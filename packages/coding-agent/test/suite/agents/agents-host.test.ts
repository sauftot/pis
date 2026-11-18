import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentDefinition,
	AgentStore,
	AgentsHost,
	type AgentsSettings,
	type ChildSessionRequest,
} from "../../../src/core/agents/index.ts";
import type { ExtensionToolContext, ToolDefinition } from "../../../src/core/extensions/types.ts";
import { agentSettled, agentStart, createFakeHandle, type FakeHandle } from "./fake-handle.ts";

const worker: AgentDefinition = {
	name: "worker",
	description: "General purpose",
	tools: undefined,
	model: undefined,
	systemPrompt: "",
	source: "builtin",
	filePath: undefined,
};
const scout: AgentDefinition = { ...worker, name: "scout", description: "Recon", tools: ["read"] };

/** A fake child whose run can be held open and which reports `report N` for its Nth run. */
interface ScriptedChild extends FakeHandle {
	prompts: string[];
	release(): void;
}

function scriptedChild(options: { hold: boolean; failFirst?: string }): ScriptedChild {
	const child = createFakeHandle() as ScriptedChild;
	child.prompts = [];
	let gate = new Promise<void>(() => {});
	let open = () => {};
	const rearm = () => {
		gate = new Promise<void>((resolve) => {
			open = resolve;
		});
	};
	if (options.hold) rearm();
	child.release = () => open();
	child.prompt = async (text, promptOptions) => {
		promptOptions?.preflightResult?.("started");
		child.prompts.push(text);
		if (options.failFirst && child.prompts.length === 1) throw new Error(options.failFirst);
		child.isStreaming = true;
		child.emit(agentStart);
		if (options.hold) await gate;
		if (options.hold) rearm();
		child.messages.push(fauxAssistantMessage(`report ${child.prompts.length}`));
		child.isStreaming = false;
		child.emit(agentSettled);
	};
	return child;
}

/** A fake main session that records every prompt and can refuse the first few. */
function fakeMain(refusals = 0) {
	const main = createFakeHandle() as FakeHandle & { attempts: string[]; accepted: string[] };
	main.attempts = [];
	main.accepted = [];
	let remaining = refusals;
	main.prompt = async (text, options) => {
		main.attempts.push(text);
		if (remaining > 0) {
			remaining--;
			throw new Error("Cannot submit a prompt while compaction is in progress.");
		}
		main.accepted.push(text);
		options?.preflightResult?.("started");
	};
	return main;
}

describe("AgentsHost", () => {
	const hosts: AgentsHost[] = [];
	afterEach(async () => {
		await Promise.all(hosts.splice(0).map((host) => host.dispose()));
	});

	function setup(
		options: {
			settings?: Partial<AgentsSettings>;
			holds?: string[];
			failFirst?: Record<string, string>;
			mainRefusals?: number;
			/** Model patterns the child factory refuses, as the real one does for an unknown model. */
			refuseModels?: string[];
		} = {},
	) {
		const children = new Map<string, ScriptedChild>();
		const requests: ChildSessionRequest[] = [];
		const settings: AgentsSettings = { idleParkMs: 0, maxConcurrency: 4, maxDepth: 1, ...options.settings };
		const host = new AgentsHost({
			store: new AgentStore(undefined),
			definitions: () => [worker, scout],
			settings: () => settings,
			createChildSession: async (request) => {
				if (request.model && options.refuseModels?.includes(request.model)) {
					throw new Error(`Model "${request.model}" not found.`);
				}
				requests.push(request);
				const child = scriptedChild({
					hold: options.holds?.includes(request.id) ?? false,
					failFirst: options.failFirst?.[request.id],
				});
				children.set(request.id, child);
				return child;
			},
			deliveryRetryMs: 1,
		});
		hosts.push(host);
		const main = fakeMain(options.mainRefusals);
		host.attachMain(main);
		const spawn = (
			name: string,
			extra: { callerId?: string; agent?: string; task?: string; context?: string; model?: string } = {},
		) =>
			host.spawn({
				callerId: extra.callerId ?? "main",
				agent: extra.agent,
				name,
				task: extra.task ?? "do the thing",
				context: extra.context,
				model: extra.model,
			});
		return { host, main, children, requests, spawn };
	}

	describe("spawn and result delivery", () => {
		it("gives concurrent spawns of one name distinct ids", async () => {
			// Both spawns pick an id before either has built its session and registered.
			const { spawn, host } = setup();
			const ids = (await Promise.all([spawn("Alpha"), spawn("Alpha")])).map((spawned) => spawned.id);
			expect(ids).toEqual(["Alpha", "Alpha2"]);
			expect(host.registry.list().filter((ref) => ref.kind === "sub")).toHaveLength(2);
		});

		it("frees the id of a spawn whose session could not be built", async () => {
			const { spawn } = setup({ refuseModels: ["nope"] });
			await expect(spawn("Alpha", { model: "nope" })).rejects.toThrow('Model "nope" not found.');
			expect((await spawn("Alpha")).id).toBe("Alpha");
		});

		it("starts the agent in the background and delivers its report to the spawner", async () => {
			const { host, main, children, spawn } = setup();
			const result = await spawn("Alpha", { task: "look at auth", context: "repo uses JWT" });
			expect(result).toEqual({ id: "Alpha", agent: "worker" });

			await vi.waitFor(() => expect(main.accepted).toHaveLength(1));
			expect(main.accepted[0]).toBe('Agent "Alpha" finished:\n\nreport 1');

			const prompt = children.get("Alpha")!.prompts[0]!;
			expect(prompt).toContain('You are agent "Alpha", spawned by "main"');
			expect(prompt).toContain("Context:\nrepo uses JWT");
			expect(prompt).toContain("Task:\nlook at auth");
			expect(host.registry.get("Alpha")).toMatchObject({ parentId: "main", kind: "sub", status: "idle" });
		});

		it("delivers the report of a later run too, such as one started by a message", async () => {
			const { host, main, spawn } = setup();
			await spawn("Alpha");
			await vi.waitFor(() => expect(main.accepted).toHaveLength(1));

			await host.bus.send({ from: "main", to: "Alpha", body: "one more thing" });
			await vi.waitFor(() => expect(main.accepted).toHaveLength(2));
			expect(main.accepted[1]).toBe('Agent "Alpha" finished:\n\nreport 2');
		});

		it("does not deliver a run that was aborted", async () => {
			const { children, main, spawn } = setup({ holds: ["Alpha"] });
			await spawn("Alpha");
			await vi.waitFor(() => expect(children.get("Alpha")!.prompts).toHaveLength(1));
			children.get("Alpha")!.emit({ type: "agent_settled", aborted: true });
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(main.attempts).toEqual([]);
		});

		it("reports a first prompt that fails to start", async () => {
			const { main, spawn } = setup({ failFirst: { Alpha: "boom" } });
			await spawn("Alpha");
			await vi.waitFor(() => expect(main.accepted).toHaveLength(1));
			expect(main.accepted[0]).toBe('Agent "Alpha" finished:\n\nFailed: could not start: boom');
		});

		it("retries delivery while the spawner cannot take a prompt yet", async () => {
			const { main, spawn } = setup({ mainRefusals: 2 });
			await spawn("Alpha");
			await vi.waitFor(() => expect(main.accepted).toHaveLength(1));
			expect(main.attempts).toHaveLength(3);
		});

		it("gives up after four attempts", async () => {
			const { main, spawn } = setup({ mainRefusals: 100 });
			await spawn("Alpha");
			await vi.waitFor(() => expect(main.attempts).toHaveLength(4));
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(main.attempts).toHaveLength(4);
			expect(main.accepted).toEqual([]);
		});

		it("gives a taken name a numeric suffix and never uses an address", async () => {
			const { spawn } = setup();
			expect((await spawn("Alpha")).id).toBe("Alpha");
			expect((await spawn("Alpha")).id).toBe("Alpha2");
			expect((await spawn("main")).id).not.toBe("main");
		});

		it("rejects an unknown agent type and lists the available ones", async () => {
			const { spawn } = setup();
			await expect(spawn("Alpha", { agent: "nope" })).rejects.toThrow(
				'Unknown agent "nope". Available: worker, scout.',
			);
		});

		it("runs the named agent definition", async () => {
			const { requests, spawn } = setup();
			expect((await spawn("Alpha", { agent: "scout" })).agent).toBe("scout");
			expect(requests[0]?.definition.name).toBe("scout");
		});
	});

	describe("activity log", () => {
		const texts = (host: AgentsHost, kind: string) =>
			host.activity
				.entries()
				.filter((e) => e.kind === kind)
				.map((e) => `${e.agentId}: ${e.text}`);

		it("records a spawn with who spawned it, its type, model and task", async () => {
			const { host, spawn } = setup();
			await spawn("Alpha", { task: "inspect the auth flow", model: "haiku" });
			expect(texts(host, "lifecycle")[0]).toBe(
				"Alpha: spawned by main (worker, model haiku): inspect the auth flow",
			);
		});

		it("records tool calls with their most telling argument, and failed tools as errors", async () => {
			const { host, children, spawn } = setup({ holds: ["Alpha"] });
			await spawn("Alpha");
			const child = children.get("Alpha")!;
			child.emit({ type: "tool_execution_start", toolCallId: "1", toolName: "grep", args: { pattern: "TODO" } });
			child.emit({ type: "tool_execution_end", toolCallId: "1", toolName: "grep", result: {}, isError: true });
			expect(texts(host, "tool")).toEqual(["Alpha: grep TODO"]);
			expect(texts(host, "error")).toEqual(["Alpha: grep failed"]);
		});

		it("records replies by their text, skips empty ones, and records model errors", async () => {
			const { host, children, spawn } = setup({ holds: ["Alpha"] });
			await spawn("Alpha");
			const child = children.get("Alpha")!;
			child.emit({ type: "message_end", message: fauxAssistantMessage("  found   it\n here ") });
			child.emit({ type: "message_end", message: fauxAssistantMessage("") });
			child.emit({
				type: "message_end",
				message: fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limited" }),
			});
			expect(texts(host, "response")).toEqual(["Alpha: found it here"]);
			expect(texts(host, "error")).toEqual(["Alpha: rate limited"]);
		});

		it("records the lifecycle: finished, parked, revived, killed and interrupted", async () => {
			const { host, children, spawn } = setup();
			await spawn("Alpha");
			host.lifecycle.park("Alpha");
			await host.lifecycle.ensureLive("Alpha");
			children.get("Alpha")!.emit({ type: "agent_settled", aborted: true });
			await host.lifecycle.kill("Alpha");
			expect(texts(host, "lifecycle").slice(1)).toEqual([
				"Alpha: finished its run",
				"Alpha: parked to disk",
				"Alpha: revived",
				"Alpha: run interrupted",
				"Alpha: killed",
			]);
		});

		it("never logs the main agent's own status changes", async () => {
			const { host, main, spawn } = setup();
			await spawn("Alpha");
			main.emit({ type: "agent_start" });
			main.emit({ type: "agent_settled", aborted: false });
			expect(host.activity.entries().every((e) => e.agentId === "Alpha")).toBe(true);
		});

		it("records messages and reports against the subagent at either end, and failures as errors", async () => {
			const { host, main, spawn } = setup();
			await spawn("Alpha");
			await vi.waitFor(() => expect(main.accepted).toHaveLength(1));
			await host.bus.send({ from: "main", to: "Alpha", body: "check   the\ntests" });
			await host.bus.send({ from: "main", to: "ghost", body: "hi" });
			// The message starts another run, whose report is logged too.
			await vi.waitFor(() => expect(main.accepted).toHaveLength(2));

			expect(texts(host, "message")).toEqual([
				"Alpha: Alpha → main report: report 1",
				"Alpha: main → Alpha message: check the tests",
				"Alpha: Alpha → main report: report 2",
			]);
			// A message to an unknown id has no subagent to file it under.
			expect(texts(host, "error")).toEqual([]);
		});

		it("files a report the parent could not take under the subagent, as an error, once per attempt", async () => {
			const { host, main, spawn } = setup({ mainRefusals: 100 });
			await spawn("Alpha");
			await vi.waitFor(() => expect(main.attempts).toHaveLength(4));
			const errors = texts(host, "error");
			expect(errors).toHaveLength(4);
			expect(errors[0]).toContain("Alpha: Alpha → main: not delivered: Cannot submit a prompt");
		});
	});

	describe("delivery listeners", () => {
		it("tells listeners about each message and its receipt, failed ones too, until they unsubscribe", async () => {
			const { host, main, spawn } = setup();
			const seen: string[] = [];
			const off = host.onDelivery((envelope, receipt) =>
				seen.push(`${envelope.from}>${envelope.to}:${envelope.kind ?? "message"}:${receipt.outcome}`),
			);
			await spawn("Alpha");
			await vi.waitFor(() => expect(main.accepted).toHaveLength(1));
			await host.bus.send({ from: "main", to: "ghost", body: "hi" });
			expect(seen).toEqual(["Alpha>main:result:injected", "main>ghost:message:failed"]);

			off();
			await host.bus.send({ from: "main", to: "ghost", body: "again" });
			expect(seen).toHaveLength(2);
		});
	});

	describe("model choice", () => {
		it("passes a per-call model to the child and reports it", async () => {
			const { requests, spawn } = setup();
			const result = await spawn("Alpha", { model: "haiku" });
			expect(result).toEqual({ id: "Alpha", agent: "worker", model: "haiku" });
			expect(requests[0]?.model).toBe("haiku");
		});

		it("leaves the model unset when the call names none", async () => {
			const { requests, spawn } = setup();
			await spawn("Alpha");
			expect(requests[0]?.model).toBeUndefined();
			expect(requests[0]?.restrictModelTo).toBeUndefined();
		});

		it("restricts a per-call model to the allowed list, and only when one was chosen", async () => {
			const { requests, spawn } = setup({ settings: { allowedModels: ["haiku", "sonnet"] } });
			await spawn("Alpha", { model: "haiku" });
			await spawn("Beta");
			expect(requests[0]?.restrictModelTo).toEqual(["haiku", "sonnet"]);
			expect(requests[1]?.restrictModelTo).toBeUndefined();
		});

		it("keeps the chosen model when the agent is revived, without applying the allowlist again", async () => {
			const { host, requests, spawn } = setup({ settings: { allowedModels: ["haiku"] } });
			await spawn("Alpha", { model: "haiku" });
			host.lifecycle.park("Alpha");
			await host.lifecycle.ensureLive("Alpha");
			expect(requests.at(-1)?.model).toBe("haiku");
			expect(requests.at(-1)?.restrictModelTo).toBeUndefined();
		});

		it("exposes the allowed models", () => {
			expect(setup().host.allowedModels()).toBeUndefined();
			expect(setup({ settings: { allowedModels: ["haiku"] } }).host.allowedModels()).toEqual(["haiku"]);
		});
	});

	describe("concurrency", () => {
		it("starts only as many runs as the limit and queues the rest", async () => {
			const { host, children, spawn } = setup({ settings: { maxConcurrency: 1 }, holds: ["A", "B"] });
			await spawn("A");
			await spawn("B");
			await vi.waitFor(() => expect(children.get("A")!.prompts).toHaveLength(1));

			expect(children.get("B")!.prompts).toEqual([]);
			expect(host.registry.get("B")).toMatchObject({ status: "running", activity: "waiting for a slot" });

			children.get("A")!.release();
			await vi.waitFor(() => expect(children.get("B")!.prompts).toHaveLength(1));
			expect(host.registry.get("B")?.activity).toBeUndefined();
		});

		it("frees the slot of an agent killed while it was queued", async () => {
			const { host, children, spawn } = setup({ settings: { maxConcurrency: 1 }, holds: ["A", "B"] });
			await spawn("A");
			await spawn("B");
			await vi.waitFor(() => expect(children.get("A")!.prompts).toHaveLength(1));
			await host.lifecycle.kill("B");

			children.get("A")!.release();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(children.get("B")!.prompts).toEqual([]);

			await spawn("C");
			await vi.waitFor(() => expect(children.get("C")!.prompts).toHaveLength(1));
		});

		it("does not park a queued agent while it waits", async () => {
			const { host, spawn } = setup({ settings: { maxConcurrency: 1, idleParkMs: 1 }, holds: ["A", "B"] });
			await spawn("A");
			await spawn("B");
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(host.registry.get("B")?.status).toBe("running");
		});
	});

	describe("depth", () => {
		const names = (tools: ToolDefinition[]) => tools.map((tool) => tool.name);

		it("gives main the task tool and a first-level child only message_agent by default", async () => {
			const { host, requests, spawn } = setup();
			expect(names(host.customTools("main", 0))).toEqual(["task", "message_agent"]);
			await spawn("Alpha");
			expect(names(requests[0]!.customTools)).toEqual(["message_agent"]);
		});

		it("refuses a spawn from an agent at the maximum depth", async () => {
			const { spawn } = setup();
			await spawn("Alpha");
			await expect(spawn("Child", { callerId: "Alpha" })).rejects.toThrow(
				"cannot spawn agents (maximum depth is 1)",
			);
		});

		it("lets agents spawn agents when the depth allows, reporting to the spawning agent", async () => {
			const { host, children, requests, spawn } = setup({ settings: { maxDepth: 2 } });
			await spawn("Alpha");
			expect(names(requests[0]!.customTools)).toEqual(["task", "message_agent"]);
			await spawn("Grand", { callerId: "Alpha" });

			expect(names(requests[1]!.customTools)).toEqual(["message_agent"]);
			expect(host.registry.get("Grand")?.parentId).toBe("Alpha");
			await vi.waitFor(() =>
				expect(children.get("Alpha")!.prompts.some((p) => p.includes('Agent "Grand" finished'))).toBe(true),
			);
		});
	});

	describe("shutdown", () => {
		it("releases every agent and refuses new spawns", async () => {
			const { host, children, spawn } = setup();
			await spawn("Alpha");
			await host.dispose();
			expect(children.get("Alpha")!.disposed).toBe(true);
			expect(host.registry.get("Alpha")).toBeUndefined();
			await expect(spawn("Beta")).rejects.toThrow("shut down");
		});
	});

	describe("tools", () => {
		const context = {} as ExtensionToolContext;
		const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]?.text ?? "";

		it("task spawns every item and tells the model results arrive as messages", async () => {
			const { host } = setup();
			const tool = host.customTools("main", 0)[0]!;
			const result = await tool.execute(
				"call",
				{
					tasks: [
						{ name: "A", task: "x" },
						{ name: "B", task: "y", agent: "scout" },
					],
				},
				undefined,
				undefined,
				context,
			);
			expect(text(result)).toContain("Spawned 2 agents:");
			expect(text(result)).toContain("- A (worker)");
			expect(text(result)).toContain("- B (scout)");
			expect(text(result)).toContain("sends you a message when it finishes");
		});

		it("task reports a failed item and still spawns the rest", async () => {
			const { host, spawn } = setup();
			void spawn;
			const tool = host.customTools("main", 0)[0]!;
			const result = await tool.execute(
				"call",
				{
					tasks: [
						{ name: "A", task: "x" },
						{ name: "B", task: "y", agent: "nope" },
					],
				},
				undefined,
				undefined,
				context,
			);
			expect(text(result)).toContain("Spawned 1 agent:");
			expect(text(result)).toContain('- failed: Unknown agent "nope"');
		});

		it("task fails when nothing could be spawned", async () => {
			const { host } = setup();
			const tool = host.customTools("main", 0)[0]!;
			await expect(
				tool.execute("call", { tasks: [{ task: "y", agent: "nope" }] }, undefined, undefined, context),
			).rejects.toThrow("Unknown agent");
		});

		it("task accepts a model per item and says which model each agent got", async () => {
			const { host, requests } = setup();
			const tool = host.customTools("main", 0)[0]!;
			const result = await tool.execute(
				"call",
				{
					tasks: [
						{ name: "A", task: "x", model: "haiku" },
						{ name: "B", task: "y" },
					],
				},
				undefined,
				undefined,
				context,
			);
			expect(text(result)).toContain("- A (worker, model haiku)");
			expect(text(result)).toContain("- B (worker)");
			expect(requests.map((r) => r.model)).toEqual(["haiku", undefined]);
			const schema = JSON.stringify(tool.parameters);
			expect(schema).toContain('"model"');
		});

		it("task tells the model it can pick a cheaper model, or exactly which ones it may pick", () => {
			expect(setup().host.customTools("main", 0)[0]!.description).toContain(
				"model field to run it on a cheaper or faster model",
			);
			const restricted = setup({ settings: { allowedModels: ["haiku", "sonnet"] } }).host.customTools("main", 0)[0]!;
			expect(restricted.description).toContain("The model field accepts only: haiku, sonnet.");
			expect(restricted.description).not.toContain("cheaper or faster");
		});

		it("task reports a model the factory refuses as a failed item, and still spawns the rest", async () => {
			const { host } = setup({ refuseModels: ["bad"] });
			const tool = host.customTools("main", 0)[0]!;
			const result = await tool.execute(
				"call",
				{
					tasks: [
						{ name: "A", task: "x", model: "bad" },
						{ name: "B", task: "y" },
					],
				},
				undefined,
				undefined,
				context,
			);
			expect(text(result)).toContain("Spawned 1 agent:");
			expect(text(result)).toContain('- failed: Model "bad" not found');
		});

		it("task lists the available agents in its description", () => {
			const { host } = setup();
			expect(host.customTools("main", 0)[0]!.description).toContain("worker: General purpose; scout: Recon");
		});

		it("message_agent delivers and says how", async () => {
			const { host, spawn } = setup();
			await spawn("Alpha");
			await vi.waitFor(() => expect(host.registry.get("Alpha")?.status).toBe("idle"));
			const tool = host.customTools("main", 0)[1]!;
			const result = await tool.execute("call", { to: "Alpha", message: "hello" }, undefined, undefined, context);
			expect(text(result)).toBe("Alpha: delivered; started working on it.");
		});

		it("message_agent fails as a tool error for an unknown recipient", async () => {
			const { host } = setup();
			const tool = host.customTools("main", 0)[1]!;
			await expect(
				tool.execute("call", { to: "ghost", message: "hello" }, undefined, undefined, context),
			).rejects.toThrow('ghost: failed. Agent "ghost" not found.');
		});

		it("message_agent says so when a broadcast has nobody to reach", async () => {
			const { host } = setup();
			const tool = host.customTools("main", 0)[1]!;
			const result = await tool.execute("call", { to: "all", message: "hello?" }, undefined, undefined, context);
			expect(text(result)).toBe("No agents to message.");
		});

		it("message_agent refuses a broadcast from a subagent", async () => {
			const { host, spawn } = setup();
			await spawn("Alpha");
			const tool = host.customTools("Alpha", 1)[0]!;
			await expect(
				tool.execute("call", { to: "all", message: "hi" }, undefined, undefined, context),
			).rejects.toThrow("Only the main agent can broadcast");
		});
	});
});
