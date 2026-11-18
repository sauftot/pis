import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import steerableSubagent from "../../../examples/extensions/steerable-subagent/index.ts";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { getAgentsApi, getSessionAgentsHost } from "../../../src/core/agents/index.ts";
import { getMessageText } from "../harness.ts";
import { bootAgentsRuntime } from "./agents-runtime.ts";

type Context = { messages: Array<{ role: string; content: unknown }> };

/** The example's `subagent` tool driven by a real main session and real child sessions on the faux provider. */
describe("steerable-subagent example", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	/**
	 * Main calls `subagent` with `args` once, then answers "done". A child answers through `child`, given the
	 * text of its last user message and its whole first prompt.
	 */
	async function run(
		args: Parameters<typeof fauxToolCall>[1],
		child: (last: string, first: string) => string,
		options: {
			agentsEnabled?: boolean;
			tokensPerSecond?: number;
			whileRunning?: (session: AgentSession) => Promise<void>;
		} = {},
	) {
		const booted = await bootAgentsRuntime({
			agentsEnabled: options.agentsEnabled ?? true,
			tokensPerSecond: options.tokensPerSecond,
			extensions: [steerableSubagent],
		});
		cleanups.push(booted.cleanup);
		const respond = (context: Context) => {
			const last = context.messages.at(-1);
			const first = getMessageText(context.messages.find((m) => m.role === "user") ?? { content: "" });
			if (first.startsWith("You are agent")) return fauxAssistantMessage(child(getMessageText(last), first));
			if (last?.role === "toolResult") return fauxAssistantMessage("done");
			return fauxAssistantMessage(fauxToolCall("subagent", args), { stopReason: "toolUse" });
		};
		booted.faux.setResponses(Array.from({ length: 12 }, () => respond));

		const session = booted.runtime.session;
		const prompted = session.prompt("delegate");
		await options.whileRunning?.(session);
		await prompted;
		await vi.waitFor(() => expect(session.isStreaming).toBe(false));
		const toolResult = session.messages.find((m) => m.role === "toolResult");
		const userTexts = session.messages.filter((m) => m.role === "user").map(getMessageText);
		return { session, toolResult, text: getMessageText(toolResult), userTexts };
	}

	it("returns a single agent's report as the tool result, and not again as a message to main", async () => {
		const { session, text, userTexts } = await run({ agent: "worker", task: "say hi" }, () => "hi from worker");
		expect(text).toContain("### worker (worker): finished");
		expect(text).toContain("hi from worker");
		expect(userTexts).toEqual(["delegate"]);
		// The agent outlives the call: listed, idle, and its id is in the result so the model can message it.
		expect(getAgentsApi(session).get("worker")).toMatchObject({ status: "idle", parentId: "main" });
	});

	it("runs parallel tasks as separate agents", async () => {
		const { text, session } = await run(
			{
				tasks: [
					{ agent: "worker", task: "count apples" },
					{ agent: "worker", task: "count pears" },
				],
			},
			(_last, first) => (first.includes("apples") ? "3 apples" : "5 pears"),
		);
		expect(text).toContain("Parallel: 2/2 finished");
		expect(text).toContain("3 apples");
		expect(text).toContain("5 pears");
		expect(
			getAgentsApi(session)
				.list()
				.map((agent) => agent.id),
		).toEqual(["worker", "worker2"]);
	});

	it("passes each chain step's report to the next through {previous}", async () => {
		const { text } = await run(
			{
				chain: [
					{ agent: "worker", task: "pick a colour" },
					{ agent: "worker", task: "paint it {previous}" },
				],
			},
			(_last, first) => (first.includes("paint it teal") ? "painted teal" : "teal"),
		);
		expect(text).toContain("### worker2 (worker): finished");
		expect(text).toContain("painted teal");
	});

	it("lets a message steer an agent while the tool waits; the report reflects it", async () => {
		const { text } = await run(
			{ agent: "worker", task: "write a long essay" },
			(last) => (last.includes("stop and say bye") ? "bye" : "essay ".repeat(200)),
			{
				tokensPerSecond: 400,
				whileRunning: async (session) => {
					const host = getSessionAgentsHost(session)!;
					await vi.waitFor(() => expect(host.registry.get("worker")?.session?.isStreaming).toBe(true), {
						timeout: 5000,
					});
					const receipt = await getAgentsApi(session).send("worker", "stop and say bye", { interrupt: true });
					expect(receipt.outcome).toBe("injected");
				},
			},
		);
		expect(text).toContain("### worker (worker): finished\n\nbye");
		expect(text).not.toContain("essay");
	});

	it("explains what to set when agents are not enabled", async () => {
		const { text } = await run({ agent: "worker", task: "x" }, () => "unused", { agentsEnabled: false });
		expect(text).toContain('"agents": { "enabled": true }');
	});

	it("rejects an unknown agent type as a failed run, without stopping the others", async () => {
		const { text, toolResult } = await run(
			{
				tasks: [
					{ agent: "worker", task: "real" },
					{ agent: "nope", task: "ghost" },
				],
			},
			() => "real work",
		);
		expect(text).toContain("Parallel: 1/2 finished");
		expect(text).toContain('Unknown agent "nope"');
		expect(toolResult).toMatchObject({ isError: true });
	});
});
