import { describe, expect, it } from "vitest";
import { AgentRegistry, type RegistryEvent } from "../../../src/core/agents/index.ts";
import { agentSettled, agentStart, createFakeHandle } from "./fake-handle.ts";

function setup() {
	const registry = new AgentRegistry();
	const events: RegistryEvent[] = [];
	registry.onChange((event) => events.push(event));
	return { registry, events };
}

describe("AgentRegistry", () => {
	it("registers agents and lists them", () => {
		const { registry, events } = setup();
		const session = createFakeHandle();
		const ref = registry.register({ id: "Scout", displayName: "Scout", kind: "sub", parentId: "main", session });

		expect(ref.status).toBe("idle");
		expect(ref.sessionFile).toBe("/virtual/agent.jsonl");
		expect(registry.get("Scout")).toBe(ref);
		expect(registry.list()).toEqual([ref]);
		expect(events.map((e) => e.type)).toEqual(["registered"]);
	});

	it("registers a session-less agent as parked", () => {
		const { registry } = setup();
		const ref = registry.register({ id: "A", displayName: "A", kind: "sub", session: null, sessionFile: "/x.jsonl" });
		expect(ref.status).toBe("parked");
		expect(ref.session).toBeNull();
	});

	it("mints a new generation when an id is registered again", () => {
		const { registry } = setup();
		const first = registry.register({ id: "A", displayName: "A", kind: "sub", session: createFakeHandle() });
		const second = registry.register({ id: "A", displayName: "A", kind: "sub", session: createFakeHandle() });
		expect(second.generation).not.toBe(first.generation);
		expect(registry.get("A")).toBe(second);
	});

	it("ignores mutations guarded by a replaced ref", () => {
		const { registry } = setup();
		const stale = registry.register({ id: "A", displayName: "A", kind: "sub", session: createFakeHandle() });
		const current = registry.register({ id: "A", displayName: "A", kind: "sub", session: createFakeHandle() });

		expect(registry.setStatus("A", "aborted", stale)).toBe(false);
		expect(current.status).toBe("idle");
		expect(registry.setStatus("A", "aborted", current)).toBe(true);
		expect(registry.unregister("A", stale)).toBe(false);
		expect(registry.get("A")).toBe(current);
	});

	it("emits status_changed only on a real transition", () => {
		const { registry, events } = setup();
		registry.register({ id: "A", displayName: "A", kind: "sub", session: createFakeHandle() });
		registry.setStatus("A", "idle");
		registry.setStatus("A", "running");
		const changes = events.filter((e) => e.type === "status_changed");
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ previous: "idle" });
	});

	it("lists only running and idle agents as visible, excluding the asker", () => {
		const { registry } = setup();
		registry.register({ id: "main", displayName: "main", kind: "main", session: createFakeHandle() });
		registry.register({ id: "run", displayName: "run", kind: "sub", session: createFakeHandle(), status: "running" });
		registry.register({ id: "idle", displayName: "idle", kind: "sub", session: createFakeHandle() });
		registry.register({ id: "parked", displayName: "parked", kind: "sub", session: null, sessionFile: "/p.jsonl" });
		registry.register({ id: "dead", displayName: "dead", kind: "sub", session: null, status: "aborted" });

		expect(
			registry
				.listVisibleTo("main")
				.map((r) => r.id)
				.sort(),
		).toEqual(["idle", "run"]);
	});

	it("removes an agent and emits removed", () => {
		const { registry, events } = setup();
		registry.register({ id: "A", displayName: "A", kind: "sub", session: createFakeHandle() });
		expect(registry.unregister("A")).toBe(true);
		expect(registry.get("A")).toBeUndefined();
		expect(events.at(-1)?.type).toBe("removed");
		expect(registry.unregister("A")).toBe(false);
	});

	describe("syncSessionStatus", () => {
		it("mirrors run start, tool activity and settle", () => {
			const { registry } = setup();
			const session = createFakeHandle();
			const ref = registry.register({ id: "A", displayName: "A", kind: "sub", session });
			registry.syncSessionStatus("A", session);

			session.emit(agentStart);
			expect(ref.status).toBe("running");
			session.emit({ type: "tool_execution_start", toolCallId: "1", toolName: "grep", args: {} });
			expect(ref.activity).toBe("grep");
			session.emit({ type: "tool_execution_end", toolCallId: "1", toolName: "grep", result: {}, isError: false });
			expect(ref.activity).toBeUndefined();
			session.emit(agentSettled);
			expect(ref.status).toBe("idle");
		});

		it("clears activity when the agent leaves running", () => {
			const { registry } = setup();
			const session = createFakeHandle();
			const ref = registry.register({ id: "A", displayName: "A", kind: "sub", session });
			registry.syncSessionStatus("A", session);
			session.emit(agentStart);
			session.emit({ type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: {} });
			session.emit(agentSettled);
			expect(ref.activity).toBeUndefined();
		});

		it("ignores a late settle after the agent was aborted", () => {
			const { registry } = setup();
			const session = createFakeHandle();
			const ref = registry.register({ id: "A", displayName: "A", kind: "sub", session });
			registry.syncSessionStatus("A", session);
			session.emit(agentStart);
			registry.setStatus("A", "aborted", ref);

			session.emit(agentSettled);
			expect(ref.status).toBe("aborted");
		});

		it("ignores events from a session that is no longer attached", () => {
			const { registry } = setup();
			const old = createFakeHandle();
			const ref = registry.register({ id: "A", displayName: "A", kind: "sub", session: old });
			registry.syncSessionStatus("A", old);
			registry.attachSession("A", createFakeHandle(), undefined, ref);

			old.emit(agentStart);
			expect(ref.status).toBe("idle");
		});

		it("stops mirroring after unsubscribe", () => {
			const { registry } = setup();
			const session = createFakeHandle();
			const ref = registry.register({ id: "A", displayName: "A", kind: "sub", session });
			const unsubscribe = registry.syncSessionStatus("A", session);
			unsubscribe();
			session.emit(agentStart);
			expect(ref.status).toBe("idle");
		});
	});
});
