import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLifecycle, AgentRegistry, type AgentSessionHandle } from "../../../src/core/agents/index.ts";
import { agentStart, createFakeHandle, type FakeHandle } from "./fake-handle.ts";

const TTL = 1000;

function setup(options: { ttl?: number } = {}) {
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycle(registry, { idleParkMs: () => options.ttl ?? TTL });
	const revived: FakeHandle[] = [];
	const reviver = vi.fn(async () => {
		const session = createFakeHandle();
		revived.push(session);
		return session;
	});
	const spawn = (id: string, session: FakeHandle = createFakeHandle()) => {
		const ref = registry.register({ id, displayName: id, kind: "sub", session, sessionFile: "/virtual/a.jsonl" });
		lifecycle.adopt(id, { reviver });
		return { ref, session };
	};
	return { registry, lifecycle, reviver, revived, spawn };
}

describe("AgentLifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("idle parking", () => {
		it("parks an agent after the idle TTL and disposes its session", () => {
			const { registry, spawn } = setup();
			const { ref, session } = spawn("A");

			vi.advanceTimersByTime(TTL - 1);
			expect(ref.status).toBe("idle");
			vi.advanceTimersByTime(1);
			expect(ref.status).toBe("parked");
			expect(ref.session).toBeNull();
			expect(session.disposed).toBe(true);
			expect(registry.get("A")).toBe(ref);
		});

		it("does not park a running agent, and re-arms when it goes idle again", () => {
			const { registry, spawn } = setup();
			const { ref, session } = spawn("A");

			session.emit(agentStart);
			vi.advanceTimersByTime(TTL * 3);
			expect(ref.status).toBe("running");

			session.emit({ type: "agent_settled", aborted: false });
			vi.advanceTimersByTime(TTL);
			expect(registry.get("A")?.status).toBe("parked");
		});

		it("never parks when the TTL is disabled", () => {
			const { spawn } = setup({ ttl: 0 });
			const { ref } = spawn("A");
			vi.advanceTimersByTime(TTL * 100);
			expect(ref.status).toBe("idle");
		});

		it("does not park a session that has started streaming before its run event arrived", () => {
			const { spawn, lifecycle } = setup();
			const { ref, session } = spawn("A");
			session.isStreaming = true;
			expect(lifecycle.park("A")).toBe(false);
			expect(ref.status).toBe("idle");
			expect(session.disposed).toBe(false);
		});

		it("does not park an agent without a transcript", () => {
			const { registry, lifecycle, reviver } = setup();
			const ref = registry.register({ id: "A", displayName: "A", kind: "sub", session: createFakeHandle(null) });
			lifecycle.adopt("A", { reviver });
			expect(lifecycle.park("A")).toBe(false);
			expect(ref.status).toBe("idle");
		});
	});

	describe("pin", () => {
		it("keeps a pinned agent loaded past the idle TTL, and parks it a TTL after the pin ends", () => {
			const { spawn, lifecycle } = setup();
			const { ref, session } = spawn("A");
			const unpin = lifecycle.pin("A");

			vi.advanceTimersByTime(TTL * 5);
			expect(lifecycle.park("A")).toBe(false);
			expect(ref.status).toBe("idle");
			expect(session.disposed).toBe(false);

			unpin();
			vi.advanceTimersByTime(TTL - 1);
			expect(ref.status).toBe("idle");
			vi.advanceTimersByTime(1);
			expect(ref.status).toBe("parked");
		});

		it("holds until every pin on the agent has ended, and ending one twice counts once", () => {
			const { spawn, lifecycle } = setup();
			const { ref } = spawn("A");
			const first = lifecycle.pin("A");
			const second = lifecycle.pin("A");

			first();
			first();
			vi.advanceTimersByTime(TTL * 2);
			expect(ref.status).toBe("idle");
			second();
			vi.advanceTimersByTime(TTL);
			expect(ref.status).toBe("parked");
		});

		it("does not start a park timer when the pinned agent is running", () => {
			const { spawn, lifecycle } = setup();
			const { ref, session } = spawn("A");
			const unpin = lifecycle.pin("A");
			session.emit(agentStart);
			unpin();
			vi.advanceTimersByTime(TTL * 3);
			expect(ref.status).toBe("running");
		});

		it("forgets pins when the agent is released", async () => {
			const { spawn, lifecycle, registry } = setup();
			spawn("A");
			lifecycle.pin("A");
			await lifecycle.release("A");
			const { ref } = spawn("A");
			vi.advanceTimersByTime(TTL);
			expect(registry.get("A")).toBe(ref);
			expect(ref.status).toBe("parked");
		});
	});

	describe("ensureLive", () => {
		it("returns the existing session of a live agent without reviving", async () => {
			const { spawn, lifecycle, reviver } = setup();
			const { session } = spawn("A");
			expect(await lifecycle.ensureLive("A")).toBe(session);
			expect(reviver).not.toHaveBeenCalled();
		});

		it("revives a parked agent from its transcript", async () => {
			const { spawn, lifecycle, reviver, revived } = setup();
			const { ref } = spawn("A");
			lifecycle.park("A");

			const session = await lifecycle.ensureLive("A");
			expect(session).toBe(revived[0]);
			expect(reviver).toHaveBeenCalledTimes(1);
			expect(ref.status).toBe("idle");
			expect(ref.session).toBe(session);
		});

		it("re-arms the idle timer after a revive", async () => {
			const { spawn, lifecycle } = setup();
			const { ref } = spawn("A");
			lifecycle.park("A");
			await lifecycle.ensureLive("A");
			vi.advanceTimersByTime(TTL);
			expect(ref.status).toBe("parked");
		});

		it("coalesces concurrent revives into one", async () => {
			const { spawn, lifecycle, reviver } = setup();
			spawn("A");
			lifecycle.park("A");

			const [a, b] = await Promise.all([lifecycle.ensureLive("A"), lifecycle.ensureLive("A")]);
			expect(a).toBe(b);
			expect(reviver).toHaveBeenCalledTimes(1);
		});

		it("revives a killed agent with its history", async () => {
			const { spawn, lifecycle, revived } = setup();
			const { ref } = spawn("A");
			await lifecycle.kill("A");
			expect(ref.status).toBe("aborted");

			await lifecycle.ensureLive("A");
			expect(ref.status).toBe("idle");
			expect(revived).toHaveLength(1);
		});

		it("rejects unknown agents and agents without a transcript", async () => {
			const { registry, lifecycle, reviver } = setup();
			await expect(lifecycle.ensureLive("nope")).rejects.toThrow('Agent "nope" not found');

			registry.register({ id: "B", displayName: "B", kind: "sub", session: null, status: "aborted" });
			lifecycle.adopt("B", { reviver });
			await expect(lifecycle.ensureLive("B")).rejects.toThrow("no transcript");
		});

		it("rejects an agent the lifecycle does not manage", async () => {
			const { registry, lifecycle } = setup();
			registry.register({ id: "C", displayName: "C", kind: "sub", session: null, sessionFile: "/c.jsonl" });
			await expect(lifecycle.ensureLive("C")).rejects.toThrow("not managed");
		});

		it("propagates a reviver failure and stays parked", async () => {
			const { registry, lifecycle } = setup();
			const failing = vi.fn(async (): Promise<AgentSessionHandle> => {
				throw new Error("transcript corrupt");
			});
			const ref = registry.register({
				id: "A",
				displayName: "A",
				kind: "sub",
				session: null,
				sessionFile: "/a.jsonl",
			});
			lifecycle.adopt("A", { reviver: failing });

			await expect(lifecycle.ensureLive("A")).rejects.toThrow("transcript corrupt");
			expect(ref.status).toBe("parked");
			// A later attempt tries again instead of caching the failure.
			await expect(lifecycle.ensureLive("A")).rejects.toThrow("transcript corrupt");
			expect(failing).toHaveBeenCalledTimes(2);
		});

		it("discards a revive that finishes after the agent was killed", async () => {
			const registry = new AgentRegistry();
			const lifecycle = new AgentLifecycle(registry, { idleParkMs: () => TTL });
			let finishRevive: ((s: AgentSessionHandle) => void) | undefined;
			const slow = new Promise<AgentSessionHandle>((resolve) => {
				finishRevive = resolve;
			});
			const ref = registry.register({
				id: "A",
				displayName: "A",
				kind: "sub",
				session: null,
				sessionFile: "/a.jsonl",
			});
			lifecycle.adopt("A", { reviver: () => slow });

			const pending = lifecycle.ensureLive("A");
			const assertion = expect(pending).rejects.toThrow("released or changed");
			await lifecycle.kill("A");
			const late = createFakeHandle();
			finishRevive?.(late);

			await assertion;
			expect(late.disposed).toBe(true);
			expect(ref.status).toBe("aborted");
			expect(ref.session).toBeNull();
		});
	});

	describe("kill and release", () => {
		it("kill aborts a running session, disposes it and keeps the agent registered as aborted", async () => {
			const { registry, spawn, lifecycle } = setup();
			const { ref, session } = spawn("A");
			session.emit(agentStart);

			expect(await lifecycle.kill("A")).toBe(true);
			expect(session.aborted).toBe(true);
			expect(session.disposed).toBe(true);
			expect(ref.status).toBe("aborted");
			expect(ref.session).toBeNull();
			expect(registry.get("A")).toBe(ref);
		});

		it("kill stops the idle timer", async () => {
			const { spawn, lifecycle } = setup();
			const { ref } = spawn("A");
			await lifecycle.kill("A");
			vi.advanceTimersByTime(TTL * 2);
			expect(ref.status).toBe("aborted");
		});

		it("release removes the agent and forgets how to revive it", async () => {
			const { registry, spawn, lifecycle } = setup();
			const { session } = spawn("A");
			expect(await lifecycle.release("A")).toBe(true);
			expect(session.disposed).toBe(true);
			expect(registry.get("A")).toBeUndefined();
			await expect(lifecycle.ensureLive("A")).rejects.toThrow("not found");
		});

		it("returns false for unknown agents", async () => {
			const { lifecycle } = setup();
			expect(await lifecycle.kill("nope")).toBe(false);
			expect(await lifecycle.release("nope")).toBe(false);
		});

		it("dispose releases every agent", async () => {
			const { registry, spawn, lifecycle } = setup();
			const a = spawn("A");
			const b = spawn("B");
			await lifecycle.dispose();
			expect(a.session.disposed && b.session.disposed).toBe(true);
			expect(registry.list()).toEqual([]);
		});
	});
});
