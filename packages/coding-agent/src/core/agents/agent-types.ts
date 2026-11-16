// Shared types for the piss agent registry, lifecycle manager and message bus.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent, PromptOptions } from "../agent-session.ts";

/** Lifecycle state of an agent. `parked` and `aborted` agents have no live session but can be revived. */
export type AgentStatus = "running" | "idle" | "parked" | "aborted";

export type AgentKind = "main" | "sub";

/** The part of AgentSession the agent layer uses; AgentSession satisfies it structurally. */
export interface AgentSessionHandle {
	readonly isStreaming: boolean;
	readonly sessionFile: string | undefined;
	readonly messages: readonly AgentMessage[];
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(text: string, options?: PromptOptions): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
}

export interface AgentRef {
	readonly id: string;
	/** Unique per ref object, minted by the registry. A stale async completion compares it to detect replacement. */
	readonly generation: number;
	displayName: string;
	kind: AgentKind;
	parentId: string | undefined;
	status: AgentStatus;
	/** Null exactly when the agent is parked or aborted. */
	session: AgentSessionHandle | null;
	/** Transcript path; required to park or revive. */
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	/** Short gist of the current tool call, for rosters. Display only. */
	activity: string | undefined;
}

/** A ref, or the session currently attached to it, used to guard a mutation against a replaced ref. */
export type AgentRefExpectation = AgentRef | AgentSessionHandle;

export interface RegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	session: AgentSessionHandle | null;
	sessionFile?: string | null;
	status?: AgentStatus;
	createdAt?: number;
	lastActivity?: number;
}

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef; previous: AgentStatus }
	| { type: "metadata_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

export type RegistryListener = (event: RegistryEvent) => void;

/** A message from one agent (or the user acting as `main`) to another. */
export interface AgentEnvelope {
	from: string;
	to: string;
	body: string;
	/** `result` is a finished subagent's report to its parent; `message` (default) is a peer or user message. */
	kind?: "message" | "result";
	/** When the recipient is running: false queues the message as a follow-up instead of steering. Default true. */
	interrupt?: boolean;
}

/** How a delivered message reached the recipient's session. */
export type DeliveryMode = "prompted" | "steered" | "followed-up";

export type DeliveryReceipt =
	| { outcome: "injected" | "revived"; to: string; mode: DeliveryMode }
	| { outcome: "failed"; to: string; error: string };
