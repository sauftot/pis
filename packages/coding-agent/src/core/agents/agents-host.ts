// The agents host: one per top-level session. It owns the registry, lifecycle and bus, spawns subagents,
// bounds their concurrency, and delivers each finished run's result to the agent that spawned it (or to a caller
// waiting for that run).

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { AgentActivityLog, gist, summarizeToolArgs } from "./agent-activity.ts";
import { AgentBus, type DeliveryListener } from "./agent-bus.ts";
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
import {
	type AgentEnvelope,
	type AgentRef,
	type AgentSessionHandle,
	type AgentStatus,
	type DeliveryReceipt,
	MAIN_AGENT_ID,
	type RegistryEvent,
	type RunOutcome,
} from "./agent-types.ts";
import { Semaphore } from "./semaphore.ts";

export { MAIN_AGENT_ID };

export interface AgentsSettings {
	/** Idle time before a finished agent is parked. <= 0 disables parking. */
	idleParkMs: number;
	/** Subagent runs executing at once; the rest wait for a slot. */
	maxConcurrency: number;
	/** How deep agents may spawn agents. 1 means only the main agent spawns. */
	maxDepth: number;
	/** Models a `task` call may choose with its `model` field. Undefined allows any authenticated model. */
	allowedModels?: string[] | undefined;
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
	/** Model pattern chosen for this agent (per call, or when it was spawned). Overrides the definition's. */
	model: string | undefined;
	/** When set, `model` must resolve to one of these patterns' models. Only a fresh spawn is restricted. */
	restrictModelTo: string[] | undefined;
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

export interface AgentInfo {
	agent: string;
	task: string;
	model: string | undefined;
}

export class AgentsHost implements AgentToolsHost {
	readonly registry = new AgentRegistry();
	readonly lifecycle: AgentLifecycle;
	readonly bus: AgentBus;
	/** What the agents did, for the hub's activity view. */
	readonly activity = new AgentActivityLog();
	private readonly options: AgentsHostOptions;
	private readonly info = new Map<string, AgentInfo>();
	private readonly slots: Semaphore;
	private readonly unsubscribeRegistry: () => void;
	private readonly deliveryListeners = new Set<DeliveryListener>();
	/** Callers waiting for an agent's run to end, by agent id. While any wait, a report goes to them, not the parent. */
	private readonly waiters = new Map<string, Set<(outcome: RunOutcome) => void>>();
	/** Ids handed out by spawns still building their session, so concurrent spawns cannot pick the same id. */
	private readonly reservedIds = new Set<string>();
	/** Reports being delivered to a parent, including retries. Part of what {@link AgentsHost.whenQuiet} waits for. */
	private reportsInFlight = 0;
	private readonly quietWaiters = new Set<() => void>();
	private unsyncMain: (() => void) | undefined;
	private disposed = false;

	constructor(options: AgentsHostOptions) {
		this.options = options;
		const settings = options.settings();
		this.slots = new Semaphore(Math.max(1, settings.maxConcurrency));
		this.lifecycle = new AgentLifecycle(this.registry, { idleParkMs: () => this.options.settings().idleParkMs });
		this.bus = new AgentBus(this.registry, this.lifecycle, (envelope, receipt) =>
			this.logDelivery(envelope, receipt),
		);
		this.unsubscribeRegistry = this.registry.onChange((event) => {
			if (event.type === "status_changed" && event.ref.status === "aborted") {
				this.options.store.update(event.ref.id, { killed: true });
				this.settleWaiters(event.ref.id, { status: "killed" });
			}
			if (event.type === "removed") this.settleWaiters(event.ref.id, { status: "released" });
			this.logRegistryEvent(event);
			this.checkQuiet();
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

	/** What an agent was spawned to do, for rosters and inspectors. Undefined for an unknown id. */
	describe(id: string): AgentInfo | undefined {
		return this.info.get(id);
	}

	/** Abort an agent's current run without killing it. Returns false when it has no live session. */
	async interrupt(id: string): Promise<boolean> {
		const session = this.registry.get(id)?.session;
		if (!session) return false;
		await session.abort();
		return true;
	}

	/**
	 * Resolve with how the agent's run in progress, or its next run, ends. While anyone waits, a finished run's report
	 * is handed to the waiters instead of being sent to the agent's parent, so it arrives exactly once. A wait that
	 * `signal` ends rejects, and the report goes to the parent as usual.
	 */
	waitForRun(id: string, signal?: AbortSignal): Promise<RunOutcome> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		return new Promise((resolve, reject) => {
			const waiting = this.waiters.get(id) ?? new Set();
			this.waiters.set(id, waiting);
			const stopWaiting = () => {
				waiting.delete(waiter);
				if (waiting.size === 0 && this.waiters.get(id) === waiting) this.waiters.delete(id);
			};
			const onAbort = () => {
				stopWaiting();
				reject(signal?.reason);
			};
			const waiter = (outcome: RunOutcome) => {
				signal?.removeEventListener("abort", onAbort);
				resolve(outcome);
			};
			waiting.add(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/**
	 * Resolve once no agent (main included) is running and no report is on its way to a parent. The main session
	 * may still be starting a run for a report that was just accepted; check `isIdle` on it and wait again.
	 */
	whenQuiet(): Promise<void> {
		if (this.disposed || this.isQuiet()) return Promise.resolve();
		return new Promise((resolve) => this.quietWaiters.add(resolve));
	}

	/** Models `task` may choose from, or undefined when any authenticated model is allowed. */
	allowedModels(): string[] | undefined {
		return this.options.settings().allowedModels;
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
		this.reservedIds.add(id);
		let session: AgentSessionHandle;
		try {
			session = await this.options.createChildSession({
				id,
				definition,
				sessionDir: this.options.store.dirFor(id),
				sessionFile: undefined,
				customTools: this.customTools(id, callerDepth + 1),
				model: request.model,
				restrictModelTo: request.model ? this.allowedModels() : undefined,
			});
		} finally {
			this.reservedIds.delete(id);
		}
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
		this.info.set(id, { agent: definition.name, task: request.task, model: request.model });
		this.activity.record({
			agentId: id,
			kind: "lifecycle",
			text: `spawned by ${request.callerId} (${definition.name}${request.model ? `, model ${request.model}` : ""}): ${gist(request.task, 100)}`,
		});
		this.options.store.write({
			id,
			displayName: id,
			agent: definition.name,
			parentId: request.callerId,
			task: request.task,
			model: request.model,
			sessionFile: session.sessionFile ?? null,
			createdAt: ref.createdAt,
			killed: false,
		});
		this.lifecycle.adopt(id, { reviver: (stale) => this.revive(stale) });
		this.watchResults(id, session);
		void this.runFirstPrompt(ref, session, initialPrompt(id, request));
		return { id, agent: definition.name, model: request.model };
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
			this.info.set(meta.id, { agent: meta.agent, task: meta.task, model: meta.model });
			this.activity.record({
				agentId: meta.id,
				kind: "lifecycle",
				text: `restored from the saved session (${meta.killed ? "killed" : "parked"})`,
			});
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
		// The registry listener that settles waiters on removal is gone by now.
		for (const id of [...this.waiters.keys()]) this.settleWaiters(id, { status: "released" });
		this.resolveQuietWaiters();
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
			model: this.info.get(id)?.model,
			restrictModelTo: undefined,
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
				const message = error instanceof Error ? error.message : String(error);
				await this.report(ref, { status: "failed", error: `could not start: ${message}` });
			}
		} finally {
			this.slots.release();
		}
	}

	/**
	 * Watch a subagent's session: record its tool calls, replies and errors in the activity log, and deliver the
	 * final answer of every run it completes to the agent that spawned it.
	 */
	private watchResults(id: string, session: AgentSessionHandle): void {
		session.subscribe((event) => {
			switch (event.type) {
				case "tool_execution_start":
					this.activity.record({
						agentId: id,
						kind: "tool",
						text: `${event.toolName} ${summarizeToolArgs(event.args)}`.trim(),
					});
					break;
				case "tool_execution_end":
					if (event.isError)
						this.activity.record({ agentId: id, kind: "error", text: `${event.toolName} failed` });
					break;
				case "message_end":
					if (event.message.role === "assistant") this.logAssistantMessage(id, event.message);
					break;
				case "agent_settled": {
					const ref = this.registry.get(id);
					// A kill detaches the session before aborting it; the kill, not this abort, settles the waiters.
					const attached = ref !== undefined && ref.session === session;
					if (event.aborted) {
						this.activity.record({ agentId: id, kind: "lifecycle", text: "run interrupted" });
						if (attached) this.settleWaiters(id, { status: "interrupted" });
						break;
					}
					if (attached) void this.report(ref, runOutcome(session));
					break;
				}
				default:
					break;
			}
		});
	}

	private logAssistantMessage(id: string, message: Extract<AgentMessage, { role: "assistant" }>): void {
		if (message.stopReason === "error") {
			this.activity.record({ agentId: id, kind: "error", text: gist(message.errorMessage ?? "model error") });
			return;
		}
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join(" ");
		if (gist(text)) this.activity.record({ agentId: id, kind: "response", text: gist(text) });
	}

	/** Lifecycle changes of subagents. Spawning and restoring are logged where they happen, with their details. */
	private logRegistryEvent(event: RegistryEvent): void {
		const ref = event.ref;
		if (ref.kind !== "sub") return;
		if (event.type === "removed") {
			this.activity.record({ agentId: ref.id, kind: "lifecycle", text: "released" });
		} else if (event.type === "status_changed") {
			const text = statusChangeText(event.previous, ref.status);
			if (text) this.activity.record({ agentId: ref.id, kind: "lifecycle", text });
		}
	}

	/** Be told about every message the bus handles, delivered or not. Returns the unsubscribe function. */
	onDelivery(listener: DeliveryListener): () => void {
		this.deliveryListeners.add(listener);
		return () => this.deliveryListeners.delete(listener);
	}

	private logDelivery(envelope: AgentEnvelope, receipt: DeliveryReceipt): void {
		for (const listener of [...this.deliveryListeners]) listener(envelope, receipt);
		const { from, to } = envelope;
		// The log is per subagent, so a message with no subagent at either end (main to an unknown id) has no home.
		const involved = [to, from].find((id) => this.registry.get(id)?.kind === "sub");
		if (involved === undefined) return;
		if (receipt.outcome === "failed") {
			this.activity.record({
				agentId: involved,
				kind: "error",
				text: `${from} → ${to}: not delivered: ${receipt.error}`,
			});
			return;
		}
		const label = envelope.kind === "result" ? "report" : "message";
		const revived = receipt.outcome === "revived" ? " (revived it)" : "";
		this.activity.record({
			agentId: involved,
			kind: "message",
			text: `${from} → ${to} ${label}${revived}: ${gist(envelope.body)}`,
		});
	}

	/** Hand a run's outcome to whoever waits for it, or else send it to the agent's parent as a report. */
	private async report(ref: AgentRef, outcome: Extract<RunOutcome, { status: "finished" | "failed" }>): Promise<void> {
		const body = outcome.status === "finished" ? outcome.report : `Failed: ${outcome.error}`;
		if (this.settleWaiters(ref.id, outcome)) {
			this.activity.record({
				agentId: ref.id,
				kind: "message",
				text: `${ref.id} → ${ref.parentId ?? MAIN_AGENT_ID} report (to a waiting caller): ${gist(body)}`,
			});
			return;
		}
		this.reportsInFlight++;
		try {
			await this.sendResult(ref, body);
		} finally {
			this.reportsInFlight--;
			this.checkQuiet();
		}
	}

	private isQuiet(): boolean {
		return this.reportsInFlight === 0 && this.registry.list().every((ref) => ref.status !== "running");
	}

	private checkQuiet(): void {
		if (this.quietWaiters.size === 0) return;
		// Deferred: a child's status turns idle before its own agent_settled handler starts the report, in the same
		// synchronous event dispatch. Checking after the dispatch sees the report as in flight.
		queueMicrotask(() => {
			if (this.isQuiet()) this.resolveQuietWaiters();
		});
	}

	private resolveQuietWaiters(): void {
		const waiting = [...this.quietWaiters];
		this.quietWaiters.clear();
		for (const resolve of waiting) resolve();
	}

	/** Resolve and forget every waiter of `id`. Returns whether there were any. */
	private settleWaiters(id: string, outcome: RunOutcome): boolean {
		const waiting = this.waiters.get(id);
		if (!waiting || waiting.size === 0) return false;
		this.waiters.delete(id);
		for (const waiter of waiting) waiter(outcome);
		return true;
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
		const taken = new Set<string>([MAIN_AGENT_ID, "all", ...this.reservedIds]);
		for (const ref of this.registry.list()) taken.add(ref.id);
		for (const meta of this.options.store.list()) taken.add(meta.id);
		return taken;
	}
}

/** What a status change means for a reader of the log; undefined when it is not worth an entry. */
function statusChangeText(previous: AgentStatus, next: AgentStatus): string | undefined {
	if (next === "aborted") return "killed";
	if (next === "parked") return "parked to disk";
	if (next === "running") return previous === "idle" ? "started working" : undefined;
	if (next === "idle") return previous === "running" ? "finished its run" : "revived";
	return undefined;
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

/** A finished run's outcome: the text of its last assistant message, or its error. */
function runOutcome(session: AgentSessionHandle): Extract<RunOutcome, { status: "finished" | "failed" }> {
	const last = session.messages.findLast((message) => message.role === "assistant");
	if (!last || last.role !== "assistant") return { status: "finished", report: "(no output)" };
	if (last.stopReason === "error") return { status: "failed", error: last.errorMessage ?? "unknown error" };
	const text = last.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return { status: "finished", report: text.length > 0 ? text : "(no output)" };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
