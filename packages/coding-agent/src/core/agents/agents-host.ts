// The agents host: one per top-level session. It owns the registry, lifecycle and bus, spawns subagents,
// bounds their concurrency, and delivers each finished run's result to the agent that spawned it.

import type { ToolDefinition } from "../extensions/types.ts";
import { AgentBus } from "./agent-bus.ts";
import { type AgentDefinition, DEFAULT_AGENT_NAME } from "./agent-definitions.ts";
import { AgentLifecycle } from "./agent-lifecycle.ts";
import { allocateAgentId } from "./agent-names.ts";
import { AgentRegistry } from "./agent-registry.ts";
import type { AgentStore } from "./agent-store.ts";
import {
	type AgentToolsHost,
	createMessageAgentTool,
	createTaskTool,
	type SpawnRequest,
	type SpawnResult,
} from "./agent-tools.ts";
import type { AgentRef, AgentSessionHandle } from "./agent-types.ts";
import { Semaphore } from "./semaphore.ts";

export const MAIN_AGENT_ID = "main";

export interface AgentsSettings {
	/** Idle time before a finished agent is parked. <= 0 disables parking. */
	idleParkMs: number;
	/** Subagent runs executing at once; the rest wait for a slot. */
	maxConcurrency: number;
	/** How deep agents may spawn agents. 1 means only the main agent spawns. */
	maxDepth: number;
}

/** What a child session needs from the layer that knows how to build sessions. */
export interface ChildSessionRequest {
	id: string;
	definition: AgentDefinition;
	/** Directory for a new transcript, or undefined for an in-memory session. */
	sessionDir: string | undefined;
	/** Existing transcript to reopen, when reviving. */
	sessionFile: string | undefined;
	/** Tools every child gets: `message_agent`, plus `task` when it may spawn. */
	customTools: ToolDefinition[];
}

export type ChildSessionFactory = (request: ChildSessionRequest) => Promise<AgentSessionHandle>;

export interface AgentsHostOptions {
	store: AgentStore;
	definitions: () => AgentDefinition[];
	settings: () => AgentsSettings;
	createChildSession: ChildSessionFactory;
	/** Pause between attempts to deliver a result to a parent that cannot take it yet. */
	deliveryRetryMs?: number;
}

const DELIVERY_ATTEMPTS = 4;

interface AgentInfo {
	agent: string;
	task: string;
}

export class AgentsHost implements AgentToolsHost {
	readonly registry = new AgentRegistry();
	readonly lifecycle: AgentLifecycle;
	readonly bus: AgentBus;
	private readonly options: AgentsHostOptions;
	private readonly info = new Map<string, AgentInfo>();
	private readonly slots: Semaphore;
	private readonly unsubscribeRegistry: () => void;
	private unsyncMain: (() => void) | undefined;
	private disposed = false;

	constructor(options: AgentsHostOptions) {
		this.options = options;
		const settings = options.settings();
		this.slots = new Semaphore(Math.max(1, settings.maxConcurrency));
		this.lifecycle = new AgentLifecycle(this.registry, { idleParkMs: () => this.options.settings().idleParkMs });
		this.bus = new AgentBus(this.registry, this.lifecycle);
		this.unsubscribeRegistry = this.registry.onChange((event) => {
			if (event.type === "status_changed" && event.ref.status === "aborted") {
				this.options.store.update(event.ref.id, { killed: true });
			}
		});
	}

	/** Register the top-level session as `main`, the root every subagent reports to. */
	attachMain(session: AgentSessionHandle): void {
		this.registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session,
			status: session.isStreaming ? "running" : "idle",
		});
		this.unsyncMain = this.registry.syncSessionStatus(MAIN_AGENT_ID, session);
	}

	availableAgents(): AgentDefinition[] {
		return this.options.definitions();
	}

	/** The tools an agent at `depth` gets: `message_agent` always, `task` while it may still spawn. */
	customTools(callerId: string, depth: number): ToolDefinition[] {
		const tools = [createMessageAgentTool(this, callerId)];
		if (depth < this.options.settings().maxDepth) tools.unshift(createTaskTool(this, callerId));
		return tools;
	}

	/** Create a subagent and start it in the background. Resolves once it exists, not when it finishes. */
	async spawn(request: SpawnRequest): Promise<SpawnResult> {
		if (this.disposed) throw new Error("The agents host was shut down.");
		const callerDepth = this.depthOf(request.callerId);
		if (callerDepth >= this.options.settings().maxDepth) {
			throw new Error(
				`Agents at depth ${callerDepth} cannot spawn agents (maximum depth is ${this.options.settings().maxDepth}).`,
			);
		}
		const definitions = this.options.definitions();
		const definition = definitions.find((candidate) => candidate.name === (request.agent ?? DEFAULT_AGENT_NAME));
		if (!definition) {
			const names = definitions.map((candidate) => candidate.name).join(", ");
			throw new Error(`Unknown agent "${request.agent}". Available: ${names}.`);
		}

		const id = allocateAgentId(request.name, this.takenIds());
		const session = await this.options.createChildSession({
			id,
			definition,
			sessionDir: this.options.store.ensureDir(id),
			sessionFile: undefined,
			customTools: this.customTools(id, callerDepth + 1),
		});
		const ref = this.registry.register({
			id,
			displayName: id,
			kind: "sub",
			parentId: request.callerId,
			session,
			// Marked running while it waits for a slot so the idle timer cannot park it before its first prompt.
			status: "running",
		});
		this.registry.setActivity(id, "waiting for a slot", ref);
		this.info.set(id, { agent: definition.name, task: request.task });
		this.options.store.write({
			id,
			displayName: id,
			agent: definition.name,
			parentId: request.callerId,
			task: request.task,
			sessionFile: session.sessionFile ?? null,
			createdAt: ref.createdAt,
			killed: false,
		});
		this.lifecycle.adopt(id, { reviver: (stale) => this.revive(stale) });
		this.watchResults(id, session);
		void this.runFirstPrompt(ref, session, initialPrompt(id, request));
		return { id, agent: definition.name };
	}

	/**
	 * Register the agents saved for this session as parked (or aborted, if they were killed) so they can be
	 * listed, messaged and revived. Returns how many were restored.
	 */
	restorePersisted(): number {
		let restored = 0;
		for (const meta of this.options.store.list()) {
			if (this.registry.get(meta.id) || !meta.sessionFile) continue;
			this.registry.register({
				id: meta.id,
				displayName: meta.displayName,
				kind: "sub",
				parentId: meta.parentId,
				session: null,
				sessionFile: meta.sessionFile,
				status: meta.killed ? "aborted" : "parked",
				createdAt: meta.createdAt,
			});
			this.info.set(meta.id, { agent: meta.agent, task: meta.task });
			this.lifecycle.adopt(meta.id, { reviver: (stale) => this.revive(stale) });
			restored++;
		}
		return restored;
	}

	/** Abort and release every subagent. Called when the top-level session is disposed. */
	async dispose(): Promise<void> {
		this.disposed = true;
		this.unsubscribeRegistry();
		this.unsyncMain?.();
		await this.lifecycle.dispose();
	}

	private async revive(stale: AgentRef): Promise<AgentSessionHandle> {
		const id = stale.id;
		const definitions = this.options.definitions();
		const wanted = this.info.get(id)?.agent ?? DEFAULT_AGENT_NAME;
		const definition = definitions.find((candidate) => candidate.name === wanted) ?? definitions[0]!;
		const session = await this.options.createChildSession({
			id,
			definition,
			sessionDir: this.options.store.ensureDir(id),
			sessionFile: stale.sessionFile ?? undefined,
			customTools: this.customTools(id, this.depthOf(id)),
		});
		this.options.store.update(id, { killed: false });
		this.watchResults(id, session);
		return session;
	}

	private async runFirstPrompt(ref: AgentRef, session: AgentSessionHandle, prompt: string): Promise<void> {
		await this.slots.acquire();
		try {
			// Killed or released while it waited for a slot.
			if (this.registry.get(ref.id) !== ref || ref.session !== session) return;
			this.registry.setActivity(ref.id, undefined, ref);
			await session.prompt(prompt, { source: "extension", expandPromptTemplates: false });
		} catch (error) {
			if (this.registry.get(ref.id) === ref && ref.session === session) {
				await this.sendResult(ref, `Failed to run: ${error instanceof Error ? error.message : String(error)}`);
			}
		} finally {
			this.slots.release();
		}
	}

	/** Deliver the final answer of every run this session completes to the agent that spawned it. */
	private watchResults(id: string, session: AgentSessionHandle): void {
		session.subscribe((event) => {
			if (event.type !== "agent_settled" || event.aborted) return;
			const ref = this.registry.get(id);
			if (!ref || ref.session !== session) return;
			void this.sendResult(ref, finalReport(session));
		});
	}

	private async sendResult(ref: AgentRef, body: string): Promise<void> {
		if (!ref.parentId || this.disposed) return;
		const retryMs = this.options.deliveryRetryMs ?? 500;
		for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS && !this.disposed; attempt++) {
			const receipt = await this.bus.send({ from: ref.id, to: ref.parentId, body, kind: "result" });
			if (receipt.outcome !== "failed") return;
			// A parent that is compacting or starting cannot take a prompt yet; give it a moment.
			if (attempt < DELIVERY_ATTEMPTS) await delay(retryMs);
		}
	}

	private depthOf(id: string): number {
		let depth = 0;
		for (let parentId = this.registry.get(id)?.parentId; parentId; parentId = this.registry.get(parentId)?.parentId)
			depth++;
		return depth;
	}

	private takenIds(): Set<string> {
		const taken = new Set<string>([MAIN_AGENT_ID, "all"]);
		for (const ref of this.registry.list()) taken.add(ref.id);
		for (const meta of this.options.store.list()) taken.add(meta.id);
		return taken;
	}
}

function initialPrompt(id: string, request: SpawnRequest): string {
	const parts = [
		`You are agent "${id}", spawned by "${request.callerId}". Your final message is delivered to it automatically.`,
		`If you need an answer or a decision while you work, use message_agent to ask "${request.callerId}".`,
	];
	if (request.context) parts.push(`Context:\n${request.context}`);
	parts.push(`Task:\n${request.task}`);
	return parts.join("\n\n");
}

/** The text of the last assistant message of a finished run, or its error. */
function finalReport(session: AgentSessionHandle): string {
	const last = session.messages.findLast((message) => message.role === "assistant");
	if (!last || last.role !== "assistant") return "(no output)";
	if (last.stopReason === "error") return `Failed: ${last.errorMessage ?? "unknown error"}`;
	const text = last.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text.length > 0 ? text : "(no output)";
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
