import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { type AgentDefinition, AgentStore, AgentsHost } from "../../../src/core/agents/index.ts";
import { setSessionAgentsHost } from "../../../src/core/agents/session-hosts.ts";
import {
	handleRpcAgentCommand,
	RPC_AGENT_COMMAND_TYPES,
	subscribeRpcAgents,
} from "../../../src/modes/rpc/rpc-agents.ts";
import { createFakeHandle } from "./fake-handle.ts";

const worker: AgentDefinition = {
	name: "worker",
	description: "General purpose",
	tools: undefined,
	model: undefined,
	systemPrompt: "",
	source: "builtin",
	filePath: undefined,
};

describe("RPC agent commands", () => {
	const hosts: AgentsHost[] = [];
	afterEach(async () => {
		await Promise.all(hosts.splice(0).map((host) => host.dispose()));
	});

	function setup() {
		const host = new AgentsHost({
			store: new AgentStore(undefined),
			definitions: () => [worker],
			settings: () => ({ idleParkMs: 0, maxConcurrency: 8, maxDepth: 1 }),
			createChildSession: async () => createFakeHandle(),
			deliveryRetryMs: 1,
		});
		hosts.push(host);
		host.attachMain(createFakeHandle());
		const session = {} as AgentSession;
		setSessionAgentsHost(session, host);
		return { host, session };
	}

	it("spawns, lists, messages, interrupts, kills and revives", async () => {
		const { session } = setup();

		const spawned = await handleRpcAgentCommand(session, {
			id: "1",
			type: "agent_spawn",
			spec: { name: "Alpha", task: "look around" },
		});
		expect(spawned).toMatchObject({
			id: "1",
			command: "agent_spawn",
			success: true,
			data: { id: "Alpha", agent: "worker" },
		});

		const listed = await handleRpcAgentCommand(session, { type: "agents_list" });
		expect(listed.command === "agents_list" && listed.data.agents.map((a) => a.id)).toEqual(["Alpha"]);

		const sent = await handleRpcAgentCommand(session, { type: "agent_send", to: "Alpha", message: "hello" });
		expect(sent).toMatchObject({ command: "agent_send", success: true });

		expect(await handleRpcAgentCommand(session, { type: "agent_interrupt", agentId: "Alpha" })).toMatchObject({
			data: { interrupted: true },
		});
		expect(await handleRpcAgentCommand(session, { type: "agent_kill", agentId: "Alpha" })).toMatchObject({
			data: { killed: true },
		});
		const revived = await handleRpcAgentCommand(session, { type: "agent_revive", agentId: "Alpha" });
		expect(revived.command === "agent_revive" && revived.data.agent.id).toBe("Alpha");

		const messages = await handleRpcAgentCommand(session, { type: "agent_get_messages", agentId: "Alpha" });
		expect(messages.command === "agent_get_messages" && Array.isArray(messages.data.messages)).toBe(true);

		const activity = await handleRpcAgentCommand(session, { type: "agents_activity", agentId: "Alpha", limit: 5 });
		expect(activity.command === "agents_activity" && Array.isArray(activity.data.entries)).toBe(true);
	});

	it("rejects with a readable message for an unknown agent", async () => {
		const { session } = setup();
		await expect(handleRpcAgentCommand(session, { type: "agent_revive", agentId: "ghost" })).rejects.toThrow(
			/No agent named "ghost"/,
		);
	});

	it("rejects changes and lists nothing when agents are not enabled", async () => {
		const session = {} as AgentSession;
		await expect(handleRpcAgentCommand(session, { type: "agent_spawn", spec: { task: "x" } })).rejects.toThrow(
			/not enabled/,
		);
		const listed = await handleRpcAgentCommand(session, { type: "agents_list" });
		expect(listed.command === "agents_list" && listed.data.agents).toEqual([]);
	});

	it("pushes agent_event lines with the change in `change`, and stops after unsubscribe", async () => {
		const { session } = setup();
		const lines: Record<string, unknown>[] = [];
		const stop = subscribeRpcAgents(session, (event) => lines.push(event as Record<string, unknown>));

		await handleRpcAgentCommand(session, { type: "agent_spawn", spec: { name: "Alpha", task: "x" } });
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((line) => line.type === "agent_event")).toBe(true);
		expect(lines[0]).toMatchObject({ change: "registered", agent: { id: "Alpha" } });

		stop();
		const seen = lines.length;
		await handleRpcAgentCommand(session, { type: "agent_kill", agentId: "Alpha" });
		expect(lines.length).toBe(seen);
	});

	it("lists every command type the dispatcher routes", () => {
		expect([...RPC_AGENT_COMMAND_TYPES].sort()).toEqual(
			[
				"agent_get_messages",
				"agent_interrupt",
				"agent_kill",
				"agent_revive",
				"agent_send",
				"agent_spawn",
				"agents_activity",
				"agents_list",
			].sort(),
		);
	});
});
