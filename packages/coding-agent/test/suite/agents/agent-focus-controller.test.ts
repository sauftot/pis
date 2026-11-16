import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	type AgentDefinition,
	type AgentSessionHandle,
	AgentStore,
	AgentsHost,
	type ChildSessionRequest,
} from "../../../src/core/agents/index.ts";
import { AgentFocusController } from "../../../src/modes/interactive/agents/agent-focus-controller.ts";
import { agentSettled, createFakeHandle, type FakeHandle } from "./fake-handle.ts";

const worker: AgentDefinition = {
	name: "worker",
	description: "General purpose",
	tools: undefined,
	model: undefined,
	systemPrompt: "",
	source: "builtin",
	filePath: undefined,
};
const TTL = 1000;

describe("AgentFocusController", () => {
	const hosts: AgentsHost[] = [];

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});
	afterEach(async () => {
		vi.useRealTimers();
		await Promise.all(hosts.splice(0).map((host) => host.dispose()));
	});

	function setup(options: { slowRevive?: Promise<void> } = {}) {
		const children = new Map<string, FakeHandle>();
		const requests: ChildSessionRequest[] = [];
		const host = new AgentsHost({
			store: new AgentStore(undefined),
			definitions: () => [worker],
			settings: () => ({ idleParkMs: TTL, maxConcurrency: 8, maxDepth: 1 }),
			createChildSession: async (request) => {
				requests.push(request);
				// Only revives are slowed: a first-time spawn has no sessionFile.
				if (request.sessionFile) await options.slowRevive;
				const child = createFakeHandle();
				children.set(request.id, child);
				return child;
			},
			deliveryRetryMs: 1,
		});
		hosts.push(host);
		host.attachMain(createFakeHandle());

		const retargets: Array<string | undefined> = [];
		const notices: string[] = [];
		let enabled = true;
		const controller: AgentFocusController = new AgentFocusController({
			getHost: () => (enabled ? host : undefined),
			retargetView: () => retargets.push(controller.focusedId),
			notify: (message) => notices.push(message),
			// The controller only passes the handle through; tests treat a fake handle as a viewable session.
			asViewSession: (handle: AgentSessionHandle) => handle as unknown as AgentSession,
		});
		const spawn = async (name: string) => {
			await host.spawn({
				callerId: "main",
				agent: undefined,
				name,
				task: "work",
				context: undefined,
				model: undefined,
			});
			// The fake child never runs; settle it so it is idle like a finished agent.
			children.get(name)!.emit(agentSettled);
		};
		const disable = () => {
			enabled = false;
		};
		return { host, controller, spawn, children, retargets, notices, disable, requests };
	}

	it("focuses a live agent and retargets the view once", async () => {
		const { controller, spawn, children, retargets } = setup();
		await spawn("Alpha");

		await controller.focus("Alpha");
		expect(controller.focusedId).toBe("Alpha");
		expect(controller.session).toBe(children.get("Alpha"));
		expect(retargets).toEqual(["Alpha"]);
	});

	it("keeps a focused agent loaded past the idle TTL, and parks it after the view leaves", async () => {
		const { host, controller, spawn } = setup();
		await spawn("Alpha");
		await controller.focus("Alpha");

		vi.advanceTimersByTime(TTL * 5);
		expect(host.registry.get("Alpha")?.status).toBe("idle");

		controller.unfocus();
		vi.advanceTimersByTime(TTL);
		expect(host.registry.get("Alpha")?.status).toBe("parked");
	});

	it("revives a parked agent before showing it, and says so", async () => {
		const { host, controller, spawn, notices, requests } = setup();
		await spawn("Alpha");
		host.lifecycle.park("Alpha");

		await controller.focus("Alpha");
		expect(controller.focusedId).toBe("Alpha");
		expect(requests.at(-1)?.sessionFile).toBeDefined();
		expect(notices).toEqual(["Revived Alpha from its transcript."]);
	});

	it("returns to the main agent when asked to focus main, or to unfocus", async () => {
		const { controller, spawn, retargets } = setup();
		await spawn("Alpha");
		await controller.focus("Alpha");
		await controller.focus("main");
		expect(controller.focusedId).toBeUndefined();
		expect(retargets).toEqual(["Alpha", undefined]);

		controller.unfocus();
		expect(retargets).toHaveLength(2);
	});

	it("does not retarget again when the agent is already focused", async () => {
		const { controller, spawn, retargets } = setup();
		await spawn("Alpha");
		await controller.focus("Alpha");
		await controller.focus("Alpha");
		expect(retargets).toEqual(["Alpha"]);
	});

	it("switches directly between agents and releases the earlier one", async () => {
		const { host, controller, spawn } = setup();
		await spawn("Alpha");
		await spawn("Beta");
		await controller.focus("Alpha");
		await controller.focus("Beta");
		expect(controller.focusedId).toBe("Beta");

		vi.advanceTimersByTime(TTL);
		expect(host.registry.get("Alpha")?.status).toBe("parked");
		expect(host.registry.get("Beta")?.status).toBe("idle");
	});

	it("rejects an unknown agent, the main agent's registry entry and a disabled host", async () => {
		const { controller, disable } = setup();
		await expect(controller.focus("ghost")).rejects.toThrow('No agent named "ghost"');
		disable();
		await expect(controller.focus("Alpha")).rejects.toThrow("Agents are not enabled");
		await expect(controller.cycle(1)).rejects.toThrow("Agents are not enabled");
	});

	it("lets the newest focus request win when an earlier revive finishes late", async () => {
		let finish: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const { host, controller, spawn, retargets } = setup({ slowRevive: slow });
		await spawn("Alpha");
		await spawn("Beta");
		host.lifecycle.park("Alpha");

		const first = controller.focus("Alpha");
		await controller.focus("Beta");
		finish();
		await first;

		expect(controller.focusedId).toBe("Beta");
		expect(retargets).toEqual(["Beta"]);
	});

	it("returns to main, with a notice, when the focused agent is killed", async () => {
		const { host, controller, spawn, retargets, notices } = setup();
		await spawn("Alpha");
		await controller.focus("Alpha");

		await host.lifecycle.kill("Alpha");
		expect(controller.focusedId).toBeUndefined();
		expect(retargets).toEqual(["Alpha", undefined]);
		expect(notices).toEqual(["Alpha was stopped. Back on the main agent."]);
	});

	it("returns to main when the focused agent is released", async () => {
		const { host, controller, spawn, notices } = setup();
		await spawn("Alpha");
		await controller.focus("Alpha");
		await host.lifecycle.release("Alpha");
		expect(controller.focusedId).toBeUndefined();
		expect(notices).toHaveLength(1);
	});

	it("ignores the death of an agent that is not focused", async () => {
		const { host, controller, spawn, notices } = setup();
		await spawn("Alpha");
		await spawn("Beta");
		await controller.focus("Alpha");
		await host.lifecycle.kill("Beta");
		expect(controller.focusedId).toBe("Alpha");
		expect(notices).toEqual([]);
	});

	describe("cycle", () => {
		it("walks main, then each agent in tree order, then back to main", async () => {
			const { controller, spawn } = setup();
			await spawn("Alpha");
			await spawn("Beta");

			const seen: Array<string | undefined> = [];
			for (let step = 0; step < 4; step++) {
				await controller.cycle(1);
				seen.push(controller.focusedId);
			}
			expect(seen).toEqual(["Alpha", "Beta", undefined, "Alpha"]);
		});

		it("walks backwards, from main to the last agent", async () => {
			const { controller, spawn } = setup();
			await spawn("Alpha");
			await spawn("Beta");
			await controller.cycle(-1);
			expect(controller.focusedId).toBe("Beta");
			await controller.cycle(-1);
			expect(controller.focusedId).toBe("Alpha");
		});

		it("skips killed agents but includes parked ones", async () => {
			const { host, controller, spawn } = setup();
			await spawn("Alpha");
			await spawn("Beta");
			await spawn("Gamma");
			await host.lifecycle.kill("Beta");
			host.lifecycle.park("Gamma");

			await controller.cycle(1);
			await controller.cycle(1);
			expect(controller.focusedId).toBe("Gamma");
		});

		it("says so when there is nothing to switch to", async () => {
			const { controller, notices } = setup();
			await controller.cycle(1);
			expect(controller.focusedId).toBeUndefined();
			expect(notices).toEqual(["There are no agents to switch to."]);
		});
	});

	it("drops the focus silently on reset, so a replaced session is not redrawn", async () => {
		const { host, controller, spawn, retargets } = setup();
		await spawn("Alpha");
		await controller.focus("Alpha");
		controller.reset();

		expect(controller.focusedId).toBeUndefined();
		expect(retargets).toEqual(["Alpha"]);
		vi.advanceTimersByTime(TTL);
		expect(host.registry.get("Alpha")?.status).toBe("parked");
	});
});
