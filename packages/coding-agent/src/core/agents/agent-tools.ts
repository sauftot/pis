// Model-facing tools of the agent layer: `task` spawns background subagents, `message_agent` talks to one.

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import type { AgentBus } from "./agent-bus.ts";
import type { AgentDefinition } from "./agent-definitions.ts";
import type { DeliveryReceipt } from "./agent-types.ts";

export interface SpawnRequest {
	callerId: string;
	agent: string | undefined;
	name: string | undefined;
	task: string;
	context: string | undefined;
}

export interface SpawnResult {
	id: string;
	agent: string;
}

/** What the tools need from the agents host. */
export interface AgentToolsHost {
	readonly bus: AgentBus;
	availableAgents(): AgentDefinition[];
	spawn(request: SpawnRequest): Promise<SpawnResult>;
}

type SpawnOutcome = { ok: true; spawned: SpawnResult } | { ok: false; error: string };

const taskSchema = Type.Object({
	tasks: Type.Array(
		Type.Object({
			name: Type.Optional(
				Type.String({ description: "Short CamelCase name. It becomes the agent's id and message address." }),
			),
			agent: Type.Optional(Type.String({ description: "Agent type to run. Defaults to `worker`." })),
			task: Type.String({
				description: "Complete, self-contained instructions. The agent has not seen this conversation.",
			}),
		}),
		{ minItems: 1, description: "One subagent is spawned per item." },
	),
	context: Type.Optional(Type.String({ description: "Background shared with every spawned agent." })),
});

const messageSchema = Type.Object({
	to: Type.String({ description: "Agent id, or `all` to message every running or idle agent (main agent only)." }),
	message: Type.String({ description: "The message. Be specific; the recipient has no other context from you." }),
	interrupt: Type.Optional(
		Type.Boolean({
			description:
				"When the recipient is busy: true (default) delivers at its next step; false waits until it finishes.",
		}),
	),
});

/** The `task` tool, bound to the agent that calls it. */
export function createTaskTool(host: AgentToolsHost, callerId: string): ToolDefinition {
	const agents = host
		.availableAgents()
		.map((agent) => `${agent.name}: ${agent.description}`)
		.join("; ");
	return defineTool({
		name: "task",
		label: "task",
		description:
			"Spawn background subagents, each with its own context window and a fresh conversation. They run in " +
			"parallel while you continue. Each reports back to you in a message when it finishes, so do not poll. " +
			`Available agents: ${agents}.`,
		promptSnippet: "Spawn background subagents for independent subtasks",
		promptGuidelines: [
			"Use task for independent subtasks that would bloat your context or can run in parallel; do small tasks yourself.",
			"Write each task as complete instructions: a subagent has not seen this conversation.",
		],
		parameters: taskSchema,
		async execute(_toolCallId, params) {
			const outcomes = await Promise.all(
				params.tasks.map(async (item): Promise<SpawnOutcome> => {
					try {
						const spawned = await host.spawn({
							callerId,
							agent: item.agent,
							name: item.name,
							task: item.task,
							context: params.context,
						});
						return { ok: true, spawned };
					} catch (error) {
						return { ok: false, error: error instanceof Error ? error.message : String(error) };
					}
				}),
			);
			const spawned = outcomes.flatMap((outcome) => (outcome.ok ? [outcome.spawned] : []));
			const errors = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.error]));
			if (spawned.length === 0) throw new Error(errors.join("\n"));

			const lines = [
				`Spawned ${spawned.length} agent${spawned.length === 1 ? "" : "s"}:`,
				...spawned.map((agent) => `- ${agent.id} (${agent.agent})`),
				...errors.map((error) => `- failed: ${error}`),
				"They run in the background and each sends you a message when it finishes. Use message_agent to redirect one.",
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { spawned, failed: errors.length } };
		},
	});
}

/** The `message_agent` tool, bound to the agent that calls it. */
export function createMessageAgentTool(host: AgentToolsHost, callerId: string): ToolDefinition {
	return defineTool({
		name: "message_agent",
		label: "message_agent",
		description:
			"Send a message to another agent by id. A running agent receives it at its next step, an idle agent " +
			"starts working on it, and a parked agent is revived first. Returns once it is delivered, not when the " +
			"recipient answers; the answer arrives as a message.",
		promptSnippet: "Message another agent by id",
		parameters: messageSchema,
		async execute(_toolCallId, params) {
			const receipts =
				params.to === "all"
					? await host.bus.broadcast(callerId, params.message)
					: [
							await host.bus.send({
								from: callerId,
								to: params.to,
								body: params.message,
								interrupt: params.interrupt,
							}),
						];
			const failures = receipts.filter((receipt) => receipt.outcome === "failed");
			if (receipts.length > 0 && failures.length === receipts.length) {
				throw new Error(failures.map(describeReceipt).join("\n"));
			}
			const text = receipts.length === 0 ? "No agents to message." : receipts.map(describeReceipt).join("\n");
			return { content: [{ type: "text", text }], details: { receipts } };
		},
	});
}

function describeReceipt(receipt: DeliveryReceipt): string {
	if (receipt.outcome === "failed") return `${receipt.to}: failed. ${receipt.error}`;
	const how = {
		prompted: "started working on it",
		steered: "will see it at its next step",
		"followed-up": "queued it",
	};
	return `${receipt.to}: delivered${receipt.outcome === "revived" ? " (revived)" : ""}; ${how[receipt.mode]}.`;
}
