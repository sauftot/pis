import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { getMessageText } from "../harness.ts";
import { bootAgentsRuntime } from "./agents-runtime.ts";

type Context = { messages: Array<{ role: string; content: unknown }> };

/** `pi -p` with agents on: the process must not exit before the subagents it started have reported back. */
describe("print mode with subagents", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	/**
	 * Main spawns Scout through `task`, ends its run with "spawned it", and answers Scout's report with
	 * "final answer". Scout streams a long report, so it is still working when main's first run ends.
	 */
	async function boot() {
		const booted = await bootAgentsRuntime({ agentsEnabled: true, tokensPerSecond: 2000 });
		cleanups.push(booted.cleanup);
		const respond = (context: Context) => {
			const last = context.messages.at(-1);
			const lastText = getMessageText(last);
			const first = getMessageText(context.messages.find((m) => m.role === "user") ?? { content: "" });
			if (first.startsWith("You are agent")) return fauxAssistantMessage(`scout report ${"detail ".repeat(150)}`);
			if (lastText.includes('Agent "Scout" finished')) return fauxAssistantMessage("final answer");
			if (lastText === "second question") return fauxAssistantMessage("second answer");
			if (last?.role === "toolResult") return fauxAssistantMessage("spawned it");
			return fauxAssistantMessage(fauxToolCall("task", { tasks: [{ name: "Scout", task: "look around" }] }), {
				stopReason: "toolUse",
			});
		};
		booted.faux.setResponses(Array.from({ length: 12 }, () => respond));
		const stdout: string[] = [];
		// Print mode waits for each write's callback before it exits.
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string, callback?: () => void) => {
			stdout.push(chunk);
			callback?.();
			return true;
		}) as typeof process.stdout.write);
		return { ...booted, stdout };
	}

	it("waits for the subagent's report and prints the answer to it", async () => {
		const { runtime, stdout } = await boot();
		const session = runtime.session;
		const exitCode = await runPrintMode(runtime, { mode: "text", initialMessage: "delegate" });

		expect(exitCode).toBe(0);
		const userTexts = session.messages.filter((m) => m.role === "user").map(getMessageText);
		expect(userTexts.some((text) => text.startsWith('Agent "Scout" finished:'))).toBe(true);
		expect(stdout.join("")).toBe("final answer\n");
	});

	it("finishes one prompt's agents before sending the next prompt", async () => {
		const { runtime, stdout } = await boot();
		const session = runtime.session;
		const exitCode = await runPrintMode(runtime, {
			mode: "text",
			initialMessage: "delegate",
			messages: ["second question"],
		});

		expect(exitCode).toBe(0);
		const texts = session.messages.map((m) => `${m.role}: ${getMessageText(m).slice(0, 30)}`);
		const report = texts.findIndex((text) => text.startsWith('user: Agent "Scout" finished'));
		const second = texts.indexOf("user: second question");
		expect(report).toBeGreaterThan(-1);
		expect(second).toBeGreaterThan(report);
		expect(stdout.join("")).toBe("second answer\n");
	});
});
