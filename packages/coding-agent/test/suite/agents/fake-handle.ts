// A scriptable AgentSessionHandle for registry and lifecycle tests that do not need a real AgentSession.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { AgentSessionHandle } from "../../../src/core/agents/index.ts";

export interface FakeHandle extends AgentSessionHandle {
	isStreaming: boolean;
	disposed: boolean;
	aborted: boolean;
	messages: AgentMessage[];
	emit(event: AgentSessionEvent): void;
}

export function createFakeHandle(sessionFile: string | null = "/virtual/agent.jsonl"): FakeHandle {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const handle: FakeHandle = {
		isStreaming: false,
		sessionFile: sessionFile ?? undefined,
		messages: [],
		disposed: false,
		aborted: false,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt() {},
		async abort() {
			handle.aborted = true;
		},
		dispose() {
			handle.disposed = true;
			listeners.clear();
		},
		emit(event) {
			for (const listener of [...listeners]) listener(event);
		},
	};
	return handle;
}

export const agentStart: AgentSessionEvent = { type: "agent_start" };
export const agentSettled: AgentSessionEvent = { type: "agent_settled", aborted: false };
