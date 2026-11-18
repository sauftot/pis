import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentApiEvent,
	type AgentDefinition,
	AgentStore,
	AgentsHost,
	createAgentsApi,
	disabledAgentsApi,
} from "../../../src/core/agents/index.ts";
import { createFakeHandle, type FakeHandle } from "./fake-handle.ts";

const worker: AgentDefinition = {
	name: "worker",
	description: "General purpose",
	tools: undefined,
	model: undefined,
	systemPrompt: "",
	source: "builtin",
	filePath: undefined,
};

describe("AgentsApi", () => {
	const hosts: AgentsHost[] = [];
	afterEach(async () => {
		await Promise.all(hosts.splice(0).map((host) => host.dispose()));
	});

	function setup() {
		const children = new Map<string, FakeHandle>();
		const host = new AgentsHost({
			store: new AgentStore(undefined),
			definitions: () => [worker, { ...worker, name: "scout" }],
			settings: () => ({ idleParkMs: 0, maxConcurrency: 8, maxDepth: 1 }),
			createChildSession: async (request) => {
				const child = createFakeHandle();
				children.set(request.id, child);
				return child;
			},
			deliveryRetryMs: 1,
		});
		hosts.push(host);
		const main = createFakeHandle();
		host.attachMain(main);
		return { host, main, children, api: createAgentsApi(host) };
	}

	describe("reading", () => {
		it("lists subagents oldest first as plain summaries, without the main agent", async () => {
			const { api, host } = setup();
			await api.spawn({ name: "Beta", task: "second", model: "haiku" });
			await api.spawn({ name: "Alpha", task: "first", agent: "scout" });
			host.registry.setActivity("Alpha", "grep");

			const list = api.list();
			expect(list.map((a) => a.id)).toEqual(["Beta", "Alpha"]);
			expect(list[0]).toMatchObject({
				parentId: "main",
				agent: "worker",
				task: "second",
				model: "haiku",
				status: "running",
			});
			expect(list[1]).toMatchObject({ agent: "scout", model: undefined, activity: "grep" });
			// Plain data: it survives a JSON round trip unchanged.
			expect(JSON.parse(JSON.stringify(list))).toEqual(list);
		});

		it("gets one agent, and nothing for an unknown id or the main agent", async () => {
			const { api } = setup();
			await api.spawn({ name: "Alpha", task: "x" });
			expect(api.get("Alpha")?.id).toBe("Alpha");
			expect(api.get("ghost")).toBeUndefined();
			expect(api.get("main")).toBeUndefined();
		});

		it("filters and limits the activity log", async () => {
			const { api, children } = setup();
			await api.spawn({ name: "Alpha", task: "x" });
			await api.spawn({ name: "Beta", task: "y" });
			children
				.get("Alpha")!
				.emit({ type: "tool_execution_start", toolCallId: "1", toolName: "grep", args: { pattern: "a" } });
			children
				.get("Beta")!
				.emit({ type: "tool_execution_start", toolCallId: "2", toolName: "read", args: { path: "b" } });

			expect(api.activity({ kind: "tools" }).map((e) => e.text)).toEqual(["grep a", "read b"]);
			expect(api.activity({ agentId: "Beta", kind: "tools" }).map((e) => e.text)).toEqual(["read b"]);
			expect(api.activity({ limit: 1 })).toHaveLength(1);
			expect(api.activity({ limit: 1 })[0]?.text).toBe("read b");
			expect(api.activity({ limit: 0 })).toEqual([]);
		});
	});

	describe("acting", () => {
		it("spawns as the main agent and returns what it started", async () => {
			const { api, host } = setup();
			const spawned = await api.spawn({ name: "Alpha", task: "do it", model: "haiku", context: "ctx" });
			expect(spawned).toEqual({ id: "Alpha", agent: "worker", model: "haiku" });
			expect(host.registry.get("Alpha")?.parentId).toBe("main");
		});

		it("rejects a spawn the host refuses", async () => {
			const { api } = setup();
			await expect(api.spawn({ task: "x", agent: "nope" })).rejects.toThrow('Unknown agent "nope"');
		});

		it("messages an agent as main and reports a refusal as a receipt, not an exception", async () => {
			const { api, children } = setup();
			await api.spawn({ name: "Alpha", task: "x" });
			children.get("Alpha")!.emit({ type: "agent_settled", aborted: false });
			const receipt = await api.send("Alpha", "look at auth", { interrupt: false });
			expect(receipt).toMatchObject({ outcome: "injected", to: "Alpha" });
			expect(await api.send("ghost", "hi")).toMatchObject({ outcome: "failed", error: 'Agent "ghost" not found.' });
		});

		it("interrupts a live agent without killing it", async () => {
			const { api, children } = setup();
			await api.spawn({ name: "Alpha", task: "x" });
			expect(await api.interrupt("Alpha")).toBe(true);
			expect(children.get("Alpha")!.aborted).toBe(true);
			expect(api.get("Alpha")?.status).not.toBe("aborted");
			await expect(api.interrupt("ghost")).rejects.toThrow('No agent named "ghost"');
		});

		it("says an agent with no live session cannot be interrupted", async () => {
			const { api, host, children } = setup();
			await api.spawn({ name: "Alpha", task: "x" });
			children.get("Alpha")!.emit({ type: "agent_settled", aborted: false });
			host.lifecycle.park("Alpha");
			expect(await api.interrupt("Alpha")).toBe(false);
		});

		it("kills an agent, and never the main agent or an unknown one", async () => {
			const { api } = setup();
			await api.spawn({ name: "Alpha", task: "x" });
			expect(await api.kill("Alpha")).toBe(true);
			expect(api.get("Alpha")?.status).toBe("aborted");
			expect(await api.kill("ghost")).toBe(false);
			expect(await api.kill("main")).toBe(false);
		});

		it("revives a parked or killed agent and returns its summary", async () => {
			const { api, host, children } = setup();
			await api.spawn({ name: "Alpha", task: "x" });
			children.get("Alpha")!.emit({ type: "agent_settled", aborted: false });
			host.lifecycle.park("Alpha");
			expect((await api.revive("Alpha")).status).toBe("idle");
			await api.kill("Alpha");
			expect((await api.revive("Alpha")).status).toBe("idle");
			await expect(api.revive("ghost")).rejects.toThrow('No agent named "ghost"');
		});
	});

	describe("wait", () => {
		/** Spawn Alpha and finish its run with `message`, after a wait has started. */
		async function finishWhileWaiting(message: ReturnType<typeof fauxAssistantMessage>) {
			const context = setup();
			const mainPrompt = vi.spyOn(context.main, "prompt");
			await context.api.spawn({ name: "Alpha", task: "x" });
			const outcome = context.api.wait("Alpha");
			const child = context.children.get("Alpha")!;
			child.messages.push(message);
			child.emit({ type: "agent_settled", aborted: false });
			return { ...context, mainPrompt, outcome: await outcome };
		}

		it("returns a finished run's report instead of sending it to main", async () => {
			const { outcome, mainPrompt, api } = await finishWhileWaiting(fauxAssistantMessage("found it"));
			expect(outcome).toEqual({ status: "finished", report: "found it" });
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(mainPrompt).not.toHaveBeenCalled();
			// The log still shows where the report went.
			expect(api.activity({ kind: "messages" }).at(-1)?.text).toContain("report (to a waiting caller): found it");
		});

		it("returns a model error as a failed run", async () => {
			const { outcome } = await finishWhileWaiting(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limited" }),
			);
			expect(outcome).toEqual({ status: "failed", error: "rate limited" });
		});

		it("gives every waiter the same outcome", async () => {
			const { api, children } = setup();
			await api.spawn({ name: "Alpha", task: "x" });
			const both = Promise.all([api.wait("Alpha"), api.wait("Alpha")]);
			children.get("Alpha")!.messages.push(fauxAssistantMessage("done"));
			children.get("Alpha")!.emit({ type: "agent_settled", aborted: false });
			expect(await both).toEqual([
				{ status: "finished", report: "done" },
				{ status: "finished", report: "done" },
			]);
		});

		it("tells an interrupted run apart from a kill and a release", async () => {
			const { api, host, children } = setup();
			await api.spawn({ name: "Alpha", task: "x" });
			const interrupted = api.wait("Alpha");
			children.get("Alpha")!.emit({ type: "agent_settled", aborted: true });
			expect(await interrupted).toEqual({ status: "interrupted" });

			const killed = api.wait("Alpha");
			await api.kill("Alpha");
			expect(await killed).toEqual({ status: "killed" });

			await api.spawn({ name: "Beta", task: "y" });
			const released = api.wait("Beta");
			await host.dispose();
			expect(await released).toEqual({ status: "released" });
		});

		it("stops waiting on abort, and the report then goes to main as usual", async () => {
			const { api, main, children } = setup();
			const mainPrompt = vi.spyOn(main, "prompt");
			await api.spawn({ name: "Alpha", task: "x" });
			const controller = new AbortController();
			const waiting = api.wait("Alpha", { signal: controller.signal });
			controller.abort(new Error("gave up"));
			await expect(waiting).rejects.toThrow("gave up");
			await expect(api.wait("Alpha", { signal: controller.signal })).rejects.toThrow("gave up");

			children.get("Alpha")!.messages.push(fauxAssistantMessage("late"));
			children.get("Alpha")!.emit({ type: "agent_settled", aborted: false });
			await vi.waitFor(() => expect(mainPrompt).toHaveBeenCalledTimes(1));
			expect(mainPrompt.mock.calls[0]?.[0]).toBe('Agent "Alpha" finished:\n\nlate');
		});

		it("rejects an unknown agent", async () => {
			const { api } = setup();
			await expect(api.wait("ghost")).rejects.toThrow('No agent named "ghost"');
		});
	});

	describe("messages", () => {
		it("returns a copy of a live agent's conversation", async () => {
			const { api, children } = setup();
			await api.spawn({ name: "Alpha", task: "x" });
			children.get("Alpha")!.messages.push(fauxAssistantMessage("hello"));
			const messages = await api.messages("Alpha");
			expect(messages).toHaveLength(1);
			messages.pop();
			expect(await api.messages("Alpha")).toHaveLength(1);
		});

		it("returns nothing for a parked agent whose transcript is missing, and rejects an unknown id", async () => {
			const { api, host, children } = setup();
			await api.spawn({ name: "Alpha", task: "x" });
			children.get("Alpha")!.emit({ type: "agent_settled", aborted: false });
			// The fake child reports a transcript path, but nothing is on disk: reading it must not throw.
			host.lifecycle.park("Alpha");
			expect(await api.messages("Alpha")).toEqual([]);
			await expect(api.messages("ghost")).rejects.toThrow('No agent named "ghost"');
		});
	});

	describe("onChange", () => {
		it("reports agents appearing, changing, being killed and released, and what they do", async () => {
			const { api, children } = setup();
			const events: AgentApiEvent[] = [];
			api.onChange((event) => events.push(event));

			await api.spawn({ name: "Alpha", task: "x" });
			children.get("Alpha")!.emit({ type: "agent_settled", aborted: false });
			await api.kill("Alpha");

			const types = events.map((e) => e.type);
			expect(types[0]).toBe("registered");
			expect(types).toContain("status_changed");
			expect(types).toContain("activity");
			const finished = events.find((e) => e.type === "status_changed" && e.agent.status === "idle");
			expect(finished).toMatchObject({ previous: "running" });
			expect(events.some((e) => e.type === "status_changed" && e.agent.status === "aborted")).toBe(true);
		});

		it("does not report the main agent's own changes", async () => {
			const { api, main } = setup();
			const events: AgentApiEvent[] = [];
			api.onChange((event) => events.push(event));
			main.emit({ type: "agent_start" });
			main.emit({ type: "agent_settled", aborted: false });
			expect(events).toEqual([]);
		});

		it("stops reporting after unsubscribe", async () => {
			const { api } = setup();
			const listener = vi.fn();
			const off = api.onChange(listener);
			off();
			await api.spawn({ name: "Alpha", task: "x" });
			expect(listener).not.toHaveBeenCalled();
		});
	});
});

describe("disabledAgentsApi", () => {
	it("is off, reads as empty and ignores subscriptions", () => {
		expect(disabledAgentsApi.enabled).toBe(false);
		expect(disabledAgentsApi.list()).toEqual([]);
		expect(disabledAgentsApi.get("a")).toBeUndefined();
		expect(disabledAgentsApi.activity()).toEqual([]);
		expect(() => disabledAgentsApi.onChange(() => {})()).not.toThrow();
	});

	it("rejects everything that would change something, saying how to turn agents on", async () => {
		for (const attempt of [
			() => disabledAgentsApi.spawn({ task: "x" }),
			() => disabledAgentsApi.send("a", "x"),
			() => disabledAgentsApi.wait("a"),
			() => disabledAgentsApi.interrupt("a"),
			() => disabledAgentsApi.kill("a"),
			() => disabledAgentsApi.revive("a"),
			() => disabledAgentsApi.messages("a"),
		]) {
			await expect(attempt()).rejects.toThrow("Agents are not enabled");
		}
	});
});
