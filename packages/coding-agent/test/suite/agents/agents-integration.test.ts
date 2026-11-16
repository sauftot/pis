import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { getSessionAgentsHost } from "../../../src/core/agents/index.ts";
import { getMessageText } from "../harness.ts";
import { bootAgentsRuntime } from "./agents-runtime.ts";

/** The whole path: settings turn agents on, the model calls `task`, a real child session runs and reports back. */
describe("agents end to end", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function boot(agentsEnabled: boolean, allowedModels?: string[]) {
		const booted = await bootAgentsRuntime({ agentsEnabled, allowedModels });
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

	describe("choosing the subagent's model", () => {
		/** Main calls `task` with `model` once, then answers; the child answers with its own model id. */
		function script(runtimeFaux: Awaited<ReturnType<typeof boot>>["faux"], model: string | undefined) {
			const respond = (
				context: { messages: Array<{ role: string; content: unknown }> },
				_options: unknown,
				_state: unknown,
				used: { id: string },
			) => {
				const last = context.messages.at(-1);
				const lastText = last ? getMessageText(last) : "";
				const firstUser = getMessageText(context.messages.find((m) => m.role === "user") ?? { content: "" });
				if (firstUser.includes('You are agent "Scout"')) return fauxAssistantMessage(`ran on ${used.id}`);
				if (last?.role === "user" && lastText.includes('Agent "Scout" finished'))
					return fauxAssistantMessage("ack");
				if (last?.role === "toolResult") return fauxAssistantMessage("spawn attempted");
				return fauxAssistantMessage(
					fauxToolCall("task", {
						tasks: [model ? { name: "Scout", task: "say hi", model } : { name: "Scout", task: "say hi" }],
					}),
					{
						stopReason: "toolUse",
					},
				);
			};
			runtimeFaux.setResponses(Array.from({ length: 8 }, () => respond));
		}

		it("runs the child on the model the call names, while main keeps its own", async () => {
			const { runtime, faux } = await boot(true);
			script(faux, "faux-2");

			await runtime.session.prompt("delegate this");
			await vi.waitFor(() =>
				expect(
					runtime.session.messages.some((m) => m.role === "user" && getMessageText(m).includes("ran on faux-2")),
				).toBe(true),
			);

			expect(runtime.session.model?.id).toBe("faux-1");
			const toolResult = runtime.session.messages.find((m) => m.role === "toolResult");
			expect(getMessageText(toolResult)).toContain("- Scout (worker, model faux-2)");
			const scout = getSessionAgentsHost(runtime.session)?.registry.get("Scout")?.session as AgentSession;
			expect(scout.model?.id).toBe("faux-2");
		});

		it("runs the child on the main agent's model when the call names none", async () => {
			const { runtime, faux } = await boot(true);
			script(faux, undefined);
			await runtime.session.prompt("delegate this");
			await vi.waitFor(() =>
				expect(
					runtime.session.messages.some((m) => m.role === "user" && getMessageText(m).includes("ran on faux-1")),
				).toBe(true),
			);
		});

		it("fails the spawn, naming the models that would work, instead of falling back to the main model", async () => {
			const { runtime, faux } = await boot(true);
			script(faux, "no-such-model");
			await runtime.session.prompt("delegate this");

			const toolResult = runtime.session.messages.find((m) => m.role === "toolResult");
			const text = getMessageText(toolResult);
			expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(true);
			expect(text).toContain('Model "no-such-model" not found');
			expect(text).toContain("Available:");
			expect(text).toContain("faux-2");
			expect(getSessionAgentsHost(runtime.session)?.registry.get("Scout")).toBeUndefined();
			// Nothing was created for the refused agent: no registry entry and no directory.
			const sessionFile = runtime.session.sessionFile!;
			expect(existsSync(join(dirname(sessionFile), basename(sessionFile, ".jsonl"), "agents", "Scout"))).toBe(false);
		});

		it("enforces the allowed-models setting, and tells the model what it may pick", async () => {
			const { runtime, faux } = await boot(true, ["faux-1"]);
			const task = runtime.session.getAllTools().find((tool) => tool.name === "task");
			expect(task?.description).toContain("The model field accepts only: faux-1.");

			script(faux, "faux-2");
			await runtime.session.prompt("delegate this");
			const toolResult = runtime.session.messages.find((m) => m.role === "toolResult");
			expect(getMessageText(toolResult)).toContain('Model "faux-2" is not allowed for subagents. Allowed: faux-1.');
			expect(getSessionAgentsHost(runtime.session)?.registry.get("Scout")).toBeUndefined();
		});
	});
});
