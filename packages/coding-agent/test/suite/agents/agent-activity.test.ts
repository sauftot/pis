import { describe, expect, it } from "vitest";
import {
	ACTIVITY_KIND_FILTERS,
	AgentActivityLog,
	type AgentEnvelope,
	filterActivity,
	filterRoster,
	formatEnvelope,
	gist,
	layoutRoster,
	parseEnvelope,
	type RosterRow,
	summarizeToolArgs,
} from "../../../src/core/agents/index.ts";

describe("AgentActivityLog", () => {
	it("keeps entries oldest first with increasing sequence numbers", () => {
		const log = new AgentActivityLog();
		log.record({ agentId: "A", kind: "tool", text: "grep x", at: 10 });
		log.record({ agentId: "B", kind: "response", text: "done", at: 20 });
		expect(log.entries().map((e) => [e.seq, e.agentId, e.at])).toEqual([
			[1, "A", 10],
			[2, "B", 20],
		]);
	});

	it("drops the oldest entries beyond its capacity", () => {
		const log = new AgentActivityLog(3);
		for (let i = 1; i <= 5; i++) log.record({ agentId: "A", kind: "tool", text: `t${i}` });
		expect(log.entries().map((e) => e.text)).toEqual(["t3", "t4", "t5"]);
		expect(log.entries()[0]?.seq).toBe(3);
	});

	it("tells listeners about each entry until they unsubscribe", () => {
		const log = new AgentActivityLog();
		const seen: string[] = [];
		const off = log.onChange((entry) => seen.push(entry.text));
		log.record({ agentId: "A", kind: "tool", text: "one" });
		off();
		log.record({ agentId: "A", kind: "tool", text: "two" });
		expect(seen).toEqual(["one"]);
	});
});

describe("gist and summarizeToolArgs", () => {
	it("collapses whitespace and cuts long text with an ellipsis", () => {
		expect(gist("  a \n\n b\tc ")).toBe("a b c");
		expect(gist("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
		expect(gist("short", 10)).toBe("short");
	});

	it("picks the most telling argument of a tool call", () => {
		expect(summarizeToolArgs({ path: "src/a.ts", limit: 5 })).toBe("src/a.ts");
		expect(summarizeToolArgs({ command: "npm test" })).toBe("npm test");
		expect(summarizeToolArgs({ pattern: "TODO", path: "." })).toBe(".");
		expect(summarizeToolArgs({ other: 1 })).toBe('{"other":1}');
		expect(summarizeToolArgs({})).toBe("");
		expect(summarizeToolArgs(undefined)).toBe("");
		expect(summarizeToolArgs("plain")).toBe("plain");
	});
});

describe("filterActivity", () => {
	const log = new AgentActivityLog();
	log.record({ agentId: "Scout", kind: "tool", text: "grep auth" });
	log.record({ agentId: "Scout", kind: "response", text: "found the auth flow" });
	log.record({ agentId: "Wren", kind: "error", text: "bash failed" });
	log.record({ agentId: "Wren", kind: "message", text: "main → Wren message: hello" });
	log.record({ agentId: "Wren", kind: "lifecycle", text: "parked to disk" });
	const all = log.entries();

	it("cycles through every kind starting with all", () => {
		expect(ACTIVITY_KIND_FILTERS[0]).toBe("all");
		expect(new Set(ACTIVITY_KIND_FILTERS).size).toBe(6);
	});

	it("filters by kind", () => {
		expect(filterActivity(all, { kind: "all" })).toHaveLength(5);
		expect(filterActivity(all, { kind: "errors" }).map((e) => e.text)).toEqual(["bash failed"]);
		expect(filterActivity(all, { kind: "tools" }).map((e) => e.text)).toEqual(["grep auth"]);
		expect(filterActivity(all, { kind: "responses" })).toHaveLength(1);
		expect(filterActivity(all, { kind: "messages" })).toHaveLength(1);
		expect(filterActivity(all, { kind: "lifecycle" })).toHaveLength(1);
	});

	it("filters by agent and by every word of a query, matching the agent id too", () => {
		expect(filterActivity(all, { kind: "all", agentId: "Wren" })).toHaveLength(3);
		expect(filterActivity(all, { kind: "all", query: "auth" })).toHaveLength(2);
		expect(filterActivity(all, { kind: "all", query: "scout AUTH flow" }).map((e) => e.kind)).toEqual(["response"]);
		expect(filterActivity(all, { kind: "tools", agentId: "Wren" })).toEqual([]);
	});
});

describe("roster layout and filter", () => {
	const row = (id: string, patch: Partial<RosterRow> = {}): RosterRow => ({
		id,
		depth: 0,
		parentId: "main",
		status: "idle",
		agent: "worker",
		task: `task of ${id}`,
		activity: undefined,
		createdAt: 1,
		lastActivity: 100,
		sessionFile: null,
		...patch,
	});

	it("keeps tree order as given", () => {
		const rows = [row("A"), row("A1", { depth: 1 })];
		expect(layoutRoster(rows, "tree")).toEqual(rows);
	});

	it("flattens, ranking running before idle, parked and killed, then by recent activity", () => {
		const rows = [
			row("Dead", { status: "aborted", lastActivity: 900 }),
			row("OldIdle", { lastActivity: 10 }),
			row("Parked", { status: "parked", lastActivity: 500 }),
			row("NewIdle", { lastActivity: 80 }),
			row("Busy", { status: "running", lastActivity: 1, depth: 2 }),
		];
		const flat = layoutRoster(rows, "flat");
		expect(flat.map((r) => r.id)).toEqual(["Busy", "NewIdle", "OldIdle", "Parked", "Dead"]);
		expect(flat.every((r) => r.depth === 0)).toBe(true);
	});

	it("filters by every word across id, type, task, status and activity", () => {
		const rows = [
			row("Scout", { agent: "scout", task: "find the auth flow", status: "running", activity: "grep" }),
			row("Wren", { task: "summarize tests" }),
		];
		expect(filterRoster(rows, "").map((r) => r.id)).toEqual(["Scout", "Wren"]);
		expect(filterRoster(rows, "AUTH").map((r) => r.id)).toEqual(["Scout"]);
		expect(filterRoster(rows, "running grep").map((r) => r.id)).toEqual(["Scout"]);
		expect(filterRoster(rows, "idle tests").map((r) => r.id)).toEqual(["Wren"]);
		expect(filterRoster(rows, "auth tests")).toEqual([]);
	});
});

describe("agent envelopes", () => {
	const message: AgentEnvelope = { from: "main", to: "Scout", body: "look at auth" };
	const result: AgentEnvelope = { from: "Scout", to: "main", body: "found it", kind: "result" };

	it("round-trips a message and a result", () => {
		expect(parseEnvelope(formatEnvelope(message))).toEqual({ kind: "message", from: "main", body: "look at auth" });
		expect(parseEnvelope(formatEnvelope(result))).toEqual({ kind: "result", from: "Scout", body: "found it" });
	});

	it("keeps a multi-line body intact", () => {
		const body = "line one\n\n- item\n- item\n\n```ts\nconst x = 1;\n```";
		expect(parseEnvelope(formatEnvelope({ ...result, body }))?.body).toBe(body);
	});

	it("does not mistake other text for an envelope", () => {
		for (const text of [
			"hello",
			'Agent "Scout" finished:',
			'Agent "Scout" finished: no blank line',
			'Message from agent "":\n\nbody',
			'Message from agent "a b":\n\nbody',
			'  Agent "Scout" finished:\n\nbody',
			'Please note: Agent "Scout" finished:\n\nbody',
		]) {
			expect(parseEnvelope(text)).toBeUndefined();
		}
	});
});
