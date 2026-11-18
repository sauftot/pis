// The agent commands of RPC mode: the same surface as ctx.agents, for headless clients.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ActivityEntry } from "../../core/agents/agent-activity.ts";
import type { DeliveryReceipt } from "../../core/agents/agent-types.ts";
import {
	type ActivityQuery,
	type AgentApiEvent,
	type AgentSummary,
	getAgentsApi,
	type SpawnedAgent,
	type SpawnSpec,
} from "../../core/agents/agents-api.ts";

export type RpcAgentCommand =
	| { id?: string; type: "agents_list" }
	| { id?: string; type: "agent_spawn"; spec: SpawnSpec }
	| { id?: string; type: "agent_send"; to: string; message: string; interrupt?: boolean }
	| { id?: string; type: "agent_interrupt"; agentId: string }
	| { id?: string; type: "agent_kill"; agentId: string }
	| { id?: string; type: "agent_revive"; agentId: string }
	| { id?: string; type: "agent_get_messages"; agentId: string }
	| { id?: string; type: "agents_activity"; agentId?: string; kind?: ActivityQuery["kind"]; limit?: number };

export type RpcAgentCommandType = RpcAgentCommand["type"];

export const RPC_AGENT_COMMAND_TYPES: readonly RpcAgentCommandType[] = [
	"agents_list",
	"agent_spawn",
	"agent_send",
	"agent_interrupt",
	"agent_kill",
	"agent_revive",
	"agent_get_messages",
	"agents_activity",
];

export type RpcAgentResponse =
	| { id?: string; type: "response"; command: "agents_list"; success: true; data: { agents: AgentSummary[] } }
	| { id?: string; type: "response"; command: "agent_spawn"; success: true; data: SpawnedAgent }
	| { id?: string; type: "response"; command: "agent_send"; success: true; data: { receipt: DeliveryReceipt } }
	| { id?: string; type: "response"; command: "agent_interrupt"; success: true; data: { interrupted: boolean } }
	| { id?: string; type: "response"; command: "agent_kill"; success: true; data: { killed: boolean } }
	| { id?: string; type: "response"; command: "agent_revive"; success: true; data: { agent: AgentSummary } }
	| { id?: string; type: "response"; command: "agent_get_messages"; success: true; data: { messages: AgentMessage[] } }
	| { id?: string; type: "response"; command: "agents_activity"; success: true; data: { entries: ActivityEntry[] } };

export type { AgentApiEvent as RpcAgentEvent };

/** The event pushed on stdout as an agent changes or does something. */
export function toRpcAgentEvent(event: AgentApiEvent): object {
	const { type: change, ...rest } = event;
	return { type: "agent_event", change, ...rest };
}

/** Subscribe to a session's agents; returns the unsubscribe function. */
export function subscribeRpcAgents(session: AgentSession, output: (event: object) => void): () => void {
	return getAgentsApi(session).onChange((event) => output(toRpcAgentEvent(event)));
}

/** Answer one agent command, or throw with a message fit for an error response. */
export async function handleRpcAgentCommand(
	session: AgentSession,
	command: RpcAgentCommand,
): Promise<RpcAgentResponse> {
	const api = getAgentsApi(session);
	switch (command.type) {
		case "agents_list":
			return {
				id: command.id,
				type: "response",
				command: "agents_list",
				success: true,
				data: { agents: api.list() },
			};
		case "agent_spawn": {
			const spawned = await api.spawn(command.spec);
			return { id: command.id, type: "response", command: "agent_spawn", success: true, data: spawned };
		}
		case "agent_send": {
			const receipt = await api.send(command.to, command.message, { interrupt: command.interrupt });
			return { id: command.id, type: "response", command: "agent_send", success: true, data: { receipt } };
		}
		case "agent_interrupt":
			return {
				id: command.id,
				type: "response",
				command: "agent_interrupt",
				success: true,
				data: { interrupted: await api.interrupt(command.agentId) },
			};
		case "agent_kill":
			return {
				id: command.id,
				type: "response",
				command: "agent_kill",
				success: true,
				data: { killed: await api.kill(command.agentId) },
			};
		case "agent_revive": {
			const agent = await api.revive(command.agentId);
			return { id: command.id, type: "response", command: "agent_revive", success: true, data: { agent } };
		}
		case "agent_get_messages":
			return {
				id: command.id,
				type: "response",
				command: "agent_get_messages",
				success: true,
				data: { messages: await api.messages(command.agentId) },
			};
		case "agents_activity":
			return {
				id: command.id,
				type: "response",
				command: "agents_activity",
				success: true,
				data: { entries: api.activity({ agentId: command.agentId, kind: command.kind, limit: command.limit }) },
			};
	}
}
