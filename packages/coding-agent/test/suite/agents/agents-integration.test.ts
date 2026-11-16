import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessageText } from "../harness.ts";
import { bootAgentsRuntime } from "./agents-runtime.ts";

/** The whole path: settings turn agents on, the model calls `task`, a real child session runs and reports back. */
describe("agents end to end", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function boot(agentsEnabled: boolean) {
		const booted = await bootAgentsRuntime({ agentsEnabled });
		cleanups.push(booted.cleanup);
		return booted;
	}

	it("registers no agent tools when agents are disabled", async () => {
		const { runtime } = await boot(false);
		expect(runtime.session.getActiveToolNames()).not.toContain("task");
		expect(runtime.session.getActiveToolNames()).not.toContain("message_agent");
	});

	it("lets the model spawn a real subagent whose report returns to the main session", async () => {
		const { runtime, faux } = await boot(true);
		expect(runtime.session.getActiveToolNames()).toEqual(expect.arrayContaining(["task", "message_agent"]));

		// One responder serves the main session and the child: main and child share the provider's queue, so
		// the reply is chosen from the conversation, not from call order.
		const respond = (context: { messages: Array<{ role: string; content: unknown }> }) => {
			const last = context.messages.at(-1);
			const lastText = last ? getMessageText(last) : "";
			const firstUser = getMessageText(context.messages.find((m) => m.role === "user") ?? { content: "" });
			if (firstUser.includes('You are agent "Scout"')) return fauxAssistantMessage("hi from scout");
			if (last?.role === "user" && lastText.includes('Agent "Scout" finished')) return fauxAssistantMessage("ack");
			if (last?.role === "toolResult") return fauxAssistantMessage("spawned it");
			return fauxAssistantMessage(fauxToolCall("task", { tasks: [{ name: "Scout", task: "say hi" }] }), {
				stopReason: "toolUse",
			});
		};
		faux.setResponses(Array.from({ length: 8 }, () => respond));

		await runtime.session.prompt("delegate this");
		await vi.waitFor(() =>
			expect(runtime.session.messages.some((m) => m.role === "assistant" && getMessageText(m) === "ack")).toBe(true),
		);

		const userTexts = runtime.session.messages.filter((m) => m.role === "user").map(getMessageText);
		expect(userTexts).toContain('Agent "Scout" finished:\n\nhi from scout');
		const toolResult = runtime.session.messages.find((m) => m.role === "toolResult");
		expect(getMessageText(toolResult)).toContain("- Scout (worker)");

		const sessionFile = runtime.session.sessionFile!;
		const agentDir = join(dirname(sessionFile), basename(sessionFile, ".jsonl"), "agents", "Scout");
		expect(existsSync(join(agentDir, "meta.json"))).toBe(true);
	});
});
