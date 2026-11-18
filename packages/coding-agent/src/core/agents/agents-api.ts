// The agents API: how code outside the agent layer (extensions through `ctx.agents`, RPC clients) lists, starts,
// messages and stops the subagents of a session. It is the main agent's view: everything is done as `main`.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "../agent-session.ts";
import { SessionManager } from "../session-manager.ts";
import { type ActivityEntry, type ActivityKindFilter, filterActivity } from "./agent-activity.ts";
import {
	type AgentRef,
	type AgentStatus,
	type DeliveryReceipt,
	MAIN_AGENT_ID,
	type RunOutcome,
} from "./agent-types.ts";
import type { AgentsHost } from "./agents-host.ts";
import { getSessionAgentsHost } from "./session-hosts.ts";

/** A subagent as plain data: safe to hand to an extension or serialise over RPC. */
export interface AgentSummary {
	id: string;
	/** `main`, or the subagent that spawned it. */
	parentId: string | undefined;
	status: AgentStatus;
	/** Name of the agent definition it runs. */
	agent: string | undefined;
	/** The task it was spawned with. */
	task: string | undefined;
	/** The model pattern it was spawned with. Undefined: its definition's or the main agent's model. */
	model: string | undefined;
	/** The tool it is running, or why it is waiting. */
	activity: string | undefined;
	createdAt: number;
	lastActivity: number;
	/** Where its transcript is saved; null when the session is not persisted. */
	sessionFile: string | null;
}

export interface SpawnSpec {
	/** Complete, self-contained instructions. */
	task: string;
	/** Short name; becomes the agent's id and address. A taken or unusable name gets a suffix or a generated one. */
	name?: string;
	/** Agent type. Defaults to `worker`. */
	agent?: string;
	/** Model pattern, as for the task tool's `model`. */
	model?: string;
	/** Background shared with the agent. */
	context?: string;
}

export interface SpawnedAgent {
	id: string;
	agent: string;
	model: string | undefined;
}

export type AgentApiEvent =
	| { type: "registered"; agent: AgentSummary }
	| { type: "status_changed"; agent: AgentSummary; previous: AgentStatus }
	| { type: "updated"; agent: AgentSummary }
	| { type: "removed"; agent: AgentSummary }
	| { type: "activity"; entry: ActivityEntry };

export interface ActivityQuery {
	agentId?: string;
	kind?: ActivityKindFilter;
	/** Only the newest `limit` entries. */
	limit?: number;
}

export interface AgentsApi {
	/** False when `agents.enabled` is not set; then every method that changes something rejects. */
	readonly enabled: boolean;
	/** Every subagent, oldest first. */
	list(): AgentSummary[];
	get(id: string): AgentSummary | undefined;
	/** Start a subagent in the background. Resolves once it exists, not when it finishes; its report reaches main as a message. */
	spawn(spec: SpawnSpec): Promise<SpawnedAgent>;
	/** Message an agent as the main agent. A parked or killed agent is revived first. Resolves once accepted. */
	send(to: string, message: string, options?: { interrupt?: boolean }): Promise<DeliveryReceipt>;
	/**
	 * Wait for the agent's run in progress, or its next run, to end. A finished run's report is returned here instead
	 * of being sent to the main conversation. Aborting `signal` stops the wait (rejecting) and the report goes to main
	 * as usual. Several waiters on one agent all get the same outcome.
	 */
	wait(id: string, options?: { signal?: AbortSignal }): Promise<RunOutcome>;
	/** Abort an agent's current run; it keeps its context. False when it has no live session. */
	interrupt(id: string): Promise<boolean>;
	/** Abort and release an agent's session. It can be revived. False when there is no such agent. */
	kill(id: string): Promise<boolean>;
	/** Bring a parked or killed agent back from its transcript. */
	revive(id: string): Promise<AgentSummary>;
	/** An agent's conversation so far. Does not revive a parked agent: its saved transcript is read instead. */
	messages(id: string): Promise<AgentMessage[]>;
	/** What the agents did, oldest first. */
	activity(query?: ActivityQuery): ActivityEntry[];
	/** Be told when an agent appears, changes, disappears or does something. Returns the unsubscribe function. */
	onChange(listener: (event: AgentApiEvent) => void): () => void;
}

const NOT_ENABLED = 'Agents are not enabled. Set "agents": { "enabled": true } in settings.';

/** What `ctx.agents` is when agents are off: reads are empty, anything that would change something rejects. */
export const disabledAgentsApi: AgentsApi = {
	enabled: false,
	list: () => [],
	get: () => undefined,
	spawn: () => Promise.reject(new Error(NOT_ENABLED)),
	send: () => Promise.reject(new Error(NOT_ENABLED)),
	wait: () => Promise.reject(new Error(NOT_ENABLED)),
	interrupt: () => Promise.reject(new Error(NOT_ENABLED)),
	kill: () => Promise.reject(new Error(NOT_ENABLED)),
	revive: () => Promise.reject(new Error(NOT_ENABLED)),
	messages: () => Promise.reject(new Error(NOT_ENABLED)),
	activity: () => [],
	onChange: () => () => {},
};

const apis = new WeakMap<AgentsHost, AgentsApi>();

/** The agents API of a top-level session: the real one when agents are enabled, else {@link disabledAgentsApi}. */
export function getAgentsApi(session: AgentSession): AgentsApi {
	const host = getSessionAgentsHost(session);
	if (!host) return disabledAgentsApi;
	let api = apis.get(host);
	if (!api) {
		api = createAgentsApi(host);
		apis.set(host, api);
	}
	return api;
}

export function createAgentsApi(host: AgentsHost): AgentsApi {
	const subagent = (id: string): AgentRef => {
		const ref = host.registry.get(id);
		if (!ref || ref.kind !== "sub") throw new Error(`No agent named "${id}".`);
		return ref;
	};
	const summarize = (ref: AgentRef): AgentSummary => {
		const info = host.describe(ref.id);
		return {
			id: ref.id,
			parentId: ref.parentId,
			status: ref.status,
			agent: info?.agent,
			task: info?.task,
			model: info?.model,
			activity: ref.activity,
			createdAt: ref.createdAt,
			lastActivity: ref.lastActivity,
			sessionFile: ref.sessionFile,
		};
	};

	return {
		enabled: true,
		list: () =>
			host.registry
				.list()
				.filter((ref) => ref.kind === "sub")
				// Stable: agents created in the same millisecond keep registration order.
				.sort((a, b) => a.createdAt - b.createdAt)
				.map(summarize),
		get: (id) => {
			const ref = host.registry.get(id);
			return ref?.kind === "sub" ? summarize(ref) : undefined;
		},
		spawn: (spec) =>
			host.spawn({
				callerId: MAIN_AGENT_ID,
				agent: spec.agent,
				name: spec.name,
				task: spec.task,
				context: spec.context,
				model: spec.model,
			}),
		send: (to, message, options) =>
			host.bus.send({ from: MAIN_AGENT_ID, to, body: message, interrupt: options?.interrupt }),
		wait: async (id, options) => host.waitForRun(subagent(id).id, options?.signal),
		interrupt: async (id) => host.interrupt(subagent(id).id),
		kill: async (id) => (host.registry.get(id)?.kind === "sub" ? host.lifecycle.kill(id) : false),
		revive: async (id) => {
			const ref = subagent(id);
			await host.lifecycle.ensureLive(ref.id);
			return summarize(subagent(id));
		},
		messages: async (id) => {
			const ref = subagent(id);
			if (ref.session) return [...ref.session.messages];
			if (!ref.sessionFile) return [];
			return SessionManager.open(ref.sessionFile).buildSessionContext().messages;
		},
		activity: (query = {}) => {
			const entries = filterActivity(host.activity.entries(), { kind: query.kind ?? "all", agentId: query.agentId });
			return query.limit === undefined ? entries : entries.slice(Math.max(0, entries.length - query.limit));
		},
		onChange: (listener) => {
			const stopRegistry = host.registry.onChange((event) => {
				if (event.ref.kind !== "sub") return;
				const agent = summarize(event.ref);
				if (event.type === "registered") listener({ type: "registered", agent });
				else if (event.type === "status_changed")
					listener({ type: "status_changed", agent, previous: event.previous });
				else if (event.type === "metadata_changed") listener({ type: "updated", agent });
				else listener({ type: "removed", agent });
			});
			const stopActivity = host.activity.onChange((entry) => listener({ type: "activity", entry }));
			return () => {
				stopRegistry();
				stopActivity();
			};
		},
	};
}
