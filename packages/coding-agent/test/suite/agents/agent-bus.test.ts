import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBus, AgentLifecycle, AgentRegistry } from "../../../src/core/agents/index.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

const FILE = "/virtual/target.jsonl";

/** A tool that blocks until `release()`, so a test can hold a run open and message the agent mid-run. */
function createGate() {
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started: () => void = () => {};
	const hasStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			started();
			await released;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	return { tool, release, hasStarted };
}

describe("AgentBus", () => {
	const harnesses: Harness[] = [];
	const lifecycles: AgentLifecycle[] = [];

	afterEach(async () => {
		await Promise.all(lifecycles.splice(0).map((lifecycle) => lifecycle.dispose()));
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function newHarness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
		const harness = await createHarness(options);
		harnesses.push(harness);
		return harness;
	}

	/** A registry holding `main` plus one subagent `target` backed by a real session. */
	async function setup(options: { tool?: AgentTool; ttl?: number } = {}) {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycle(registry, { idleParkMs: () => options.ttl ?? 0 });
		lifecycles.push(lifecycle);
		const bus = new AgentBus(registry, lifecycle);

		const main = await newHarness();
		registry.register({ id: "main", displayName: "main", kind: "main", session: main.session });

		const target = await newHarness({ tools: options.tool ? [options.tool] : undefined });
		let current = target;
		let reviveResponses: FauxResponseStep[] = [];
		const ref = registry.register({
			id: "target",
			displayName: "target",
			kind: "sub",
			parentId: "main",
			session: target.session,
			sessionFile: FILE,
		});
		lifecycle.adopt("target", {
			// Reopen the same transcript, as a real reviver reopens the JSONL file.
			reviver: async () => {
				current = await newHarness({ sessionManager: target.sessionManager });
				// The harness does not replay the transcript; createAgentSession does. Do the same here.
				current.session.agent.state.messages = target.sessionManager.buildSessionContext().messages;
				current.setResponses(reviveResponses);
				return current.session;
			},
		});
		return {
			registry,
			lifecycle,
			bus,
			ref,
			target,
			current: () => current,
			/** Script the replies of the session the next revive creates. */
			scriptRevived: (responses: FauxResponseStep[]) => {
				reviveResponses = responses;
			},
		};
	}

	function waitForStatus(registry: AgentRegistry, id: string, status: string): Promise<void> {
		return new Promise((resolve) => {
			if (registry.get(id)?.status === status) return resolve();
			const off = registry.onChange(() => {
				if (registry.get(id)?.status === status) {
					off();
					resolve();
				}
			});
		});
	}

	it("starts a run on an idle agent and attributes the message to the sender", async () => {
		const { bus, registry, target } = await setup();
		target.setResponses([fauxAssistantMessage("acknowledged")]);

		const receipt = await bus.send({ from: "main", to: "target", body: "please look at the parser" });
		expect(receipt).toEqual({ outcome: "injected", to: "target", mode: "prompted" });

		await waitForStatus(registry, "target", "running");
		await waitForStatus(registry, "target", "idle");
		expect(getUserTexts(target)).toEqual(['Message from agent "main":\n\nplease look at the parser']);
		expect(getAssistantTexts(target)).toEqual(["acknowledged"]);
	});

	it("resolves as soon as the message is accepted, before the run finishes", async () => {
		const gate = createGate();
		const { bus, target } = await setup({ tool: gate.tool });
		target.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const receipt = await bus.send({ from: "main", to: "target", body: "start working" });
		expect(receipt.outcome).toBe("injected");
		await gate.hasStarted;
		expect(target.session.isStreaming).toBe(true);

		gate.release();
	});

	it("steers a running agent so the message lands before its next model call", async () => {
		const gate = createGate();
		const { bus, registry, target } = await setup({ tool: gate.tool });
		target.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const saw = context.messages.some(
					(m) => m.role === "user" && JSON.stringify(m.content).includes("change course"),
				);
				return fauxAssistantMessage(saw ? "saw redirect" : "missed redirect");
			},
		]);

		const run = target.session.prompt("start");
		await gate.hasStarted;
		const receipt = await bus.send({ from: "main", to: "target", body: "change course" });
		expect(receipt).toEqual({ outcome: "injected", to: "target", mode: "steered" });

		gate.release();
		await run;
		await waitForStatus(registry, "target", "idle");
		expect(getAssistantTexts(target)).toContain("saw redirect");
	});

	it("queues a follow-up for a running agent when interrupt is false", async () => {
		const gate = createGate();
		const { bus, registry, target } = await setup({ tool: gate.tool });
		target.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("first done"),
			fauxAssistantMessage("handled follow-up"),
		]);

		const run = target.session.prompt("start");
		await gate.hasStarted;
		const receipt = await bus.send({
			from: "main",
			to: "target",
			body: "when you are done, add tests",
			interrupt: false,
		});
		expect(receipt).toEqual({ outcome: "injected", to: "target", mode: "followed-up" });

		gate.release();
		await run;
		await waitForStatus(registry, "target", "idle");
		// The empty entry is the tool-call turn, which carries no text.
		expect(getAssistantTexts(target)).toEqual(["", "first done", "handled follow-up"]);
		expect(getUserTexts(target).at(-1)).toContain("when you are done, add tests");
	});

	it("revives a parked agent from its transcript, with its history, before delivering", async () => {
		const { bus, registry, lifecycle, target, ref, current, scriptRevived } = await setup();
		target.setResponses([fauxAssistantMessage("hello back")]);
		await target.session.prompt("hello");
		await waitForStatus(registry, "target", "idle");
		expect(lifecycle.park("target")).toBe(true);
		expect(ref.status).toBe("parked");

		scriptRevived([fauxAssistantMessage("resumed")]);
		const receipt = await bus.send({ from: "main", to: "target", body: "are you still there?" });
		expect(receipt).toMatchObject({ outcome: "revived", mode: "prompted" });

		const revived = current();
		expect(revived).not.toBe(target);
		// The ref is idle from the revive until the new run emits agent_start, so wait for the run itself.
		await waitForStatus(registry, "target", "running");
		await waitForStatus(registry, "target", "idle");
		expect(getUserTexts(revived)).toEqual(["hello", 'Message from agent "main":\n\nare you still there?']);
		expect(getAssistantTexts(revived)).toEqual(["hello back", "resumed"]);
	});

	it("revives a killed agent when it is messaged", async () => {
		const { bus, lifecycle, target, ref, current, scriptRevived } = await setup();
		await lifecycle.kill("target");
		expect(ref.status).toBe("aborted");

		scriptRevived([fauxAssistantMessage("back")]);
		const receipt = await bus.send({ from: "main", to: "target", body: "wake up" });
		expect(receipt.outcome).toBe("revived");
		expect(current()).not.toBe(target);
	});

	describe("refusals", () => {
		it("fails for an unknown recipient", async () => {
			const { bus } = await setup();
			expect(await bus.send({ from: "main", to: "ghost", body: "hi" })).toEqual({
				outcome: "failed",
				to: "ghost",
				error: 'Agent "ghost" not found.',
			});
		});

		it("fails for an empty body, an empty recipient and a self message", async () => {
			const { bus } = await setup();
			expect(await bus.send({ from: "main", to: "target", body: "  " })).toMatchObject({ outcome: "failed" });
			expect(await bus.send({ from: "main", to: "", body: "hi" })).toMatchObject({ outcome: "failed" });
			expect(await bus.send({ from: "target", to: "target", body: "hi" })).toMatchObject({
				outcome: "failed",
				error: "Cannot send a message to yourself.",
			});
		});

		it("reports a revive failure as a failed receipt instead of throwing", async () => {
			const registry = new AgentRegistry();
			const lifecycle = new AgentLifecycle(registry, { idleParkMs: () => 0 });
			lifecycles.push(lifecycle);
			registry.register({ id: "main", displayName: "main", kind: "main", session: null, status: "idle" });
			registry.register({ id: "t", displayName: "t", kind: "sub", session: null, sessionFile: FILE });
			lifecycle.adopt("t", {
				reviver: async () => {
					throw new Error("transcript corrupt");
				},
			});

			const receipt = await new AgentBus(registry, lifecycle).send({ from: "main", to: "t", body: "hi" });
			expect(receipt).toEqual({ outcome: "failed", to: "t", error: "transcript corrupt" });
		});

		it("fails when an input handler consumes the message", async () => {
			const registry = new AgentRegistry();
			const lifecycle = new AgentLifecycle(registry, { idleParkMs: () => 0 });
			lifecycles.push(lifecycle);
			const bus = new AgentBus(registry, lifecycle);
			const consumer = await newHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", () => ({ action: "handled" }));
					},
				],
			});
			registry.register({ id: "main", displayName: "main", kind: "main", session: null, status: "idle" });
			registry.register({ id: "t", displayName: "t", kind: "sub", session: consumer.session, sessionFile: FILE });
			lifecycle.adopt("t", { reviver: async () => consumer.session });

			const receipt = await bus.send({ from: "main", to: "t", body: "hi" });
			expect(receipt).toEqual({ outcome: "failed", to: "t", error: "An input handler consumed the message." });
		});

		it("never runs the body as an extension command", async () => {
			const commandRuns: string[] = [];
			const registry = new AgentRegistry();
			const lifecycle = new AgentLifecycle(registry, { idleParkMs: () => 0 });
			lifecycles.push(lifecycle);
			const bus = new AgentBus(registry, lifecycle);
			const victim = await newHarness({
				extensionFactories: [
					(pi) => {
						pi.registerCommand("danger", {
							description: "x",
							handler: async (args) => void commandRuns.push(args),
						});
					},
				],
			});
			victim.setResponses([fauxAssistantMessage("ok")]);
			registry.register({ id: "main", displayName: "main", kind: "main", session: null, status: "idle" });
			registry.register({ id: "t", displayName: "t", kind: "sub", session: victim.session, sessionFile: FILE });
			lifecycle.adopt("t", { reviver: async () => victim.session });

			await bus.send({ from: "main", to: "t", body: "/danger now" });
			await waitForStatus(registry, "t", "idle");
			expect(commandRuns).toEqual([]);
			expect(getUserTexts(victim)[0]).toContain("/danger now");
		});
	});

	describe("broadcast", () => {
		it("lets the main agent message every running or idle agent, and skips parked ones", async () => {
			const { bus, registry, lifecycle, target } = await setup();
			target.setResponses([fauxAssistantMessage("got it")]);
			const second = await newHarness();
			second.setResponses([fauxAssistantMessage("got it too")]);
			registry.register({
				id: "second",
				displayName: "second",
				kind: "sub",
				session: second.session,
				sessionFile: "/s.jsonl",
			});
			lifecycle.adopt("second", { reviver: async () => second.session });
			lifecycle.park("second");

			const receipts = await bus.broadcast("main", "status please");
			expect(receipts).toHaveLength(1);
			expect(receipts[0]).toMatchObject({ outcome: "injected", to: "target" });
			expect(registry.get("second")?.status).toBe("parked");
		});

		it("refuses a broadcast from a subagent", async () => {
			const { bus } = await setup();
			const receipts = await bus.broadcast("target", "everyone listen");
			expect(receipts).toEqual([
				{
					outcome: "failed",
					to: "all",
					error: "Only the main agent can broadcast. Message the one agent that can answer.",
				},
			]);
		});

		it("reports no receipts when there is nobody to message", async () => {
			const registry = new AgentRegistry();
			const lifecycle = new AgentLifecycle(registry, { idleParkMs: () => 0 });
			lifecycles.push(lifecycle);
			registry.register({ id: "main", displayName: "main", kind: "main", session: null, status: "idle" });
			expect(await new AgentBus(registry, lifecycle).broadcast("main", "hello?")).toEqual([]);
		});
	});
});
