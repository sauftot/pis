import { describe, expect, it } from "vitest";
import { AgentRegistry, buildRoster, formatAge, statusGlyph } from "../../../src/core/agents/index.ts";
import { createFakeHandle } from "./fake-handle.ts";

function registry() {
	const reg = new AgentRegistry();
	reg.register({ id: "main", displayName: "main", kind: "main", session: createFakeHandle() });
	const add = (
		id: string,
		parentId: string,
		createdAt: number,
		status: "running" | "idle" | "parked" | "aborted" = "idle",
	) =>
		reg.register({
			id,
			displayName: id,
			kind: "sub",
			parentId,
			session: null,
			sessionFile: `/${id}.jsonl`,
			status,
			createdAt,
		});
	return { reg, add };
}

describe("buildRoster", () => {
	it("leaves the main agent out and orders siblings by creation time", () => {
		const { reg, add } = registry();
		add("Late", "main", 30);
		add("Early", "main", 10);
		add("Middle", "main", 20);
		expect(buildRoster(reg, () => undefined).map((r) => r.id)).toEqual(["Early", "Middle", "Late"]);
	});

	it("puts each agent's own subagents right after it, indented", () => {
		const { reg, add } = registry();
		add("A", "main", 10);
		add("B", "main", 30);
		add("A1", "A", 20);
		add("A1a", "A1", 25);
		const rows = buildRoster(reg, () => undefined);
		expect(rows.map((r) => [r.id, r.depth])).toEqual([
			["A", 0],
			["A1", 1],
			["A1a", 2],
			["B", 0],
		]);
	});

	it("shows an agent whose parent is gone as a root", () => {
		const { reg, add } = registry();
		add("Orphan", "Vanished", 10);
		expect(buildRoster(reg, () => undefined)).toMatchObject([{ id: "Orphan", depth: 0 }]);
	});

	it("carries status, activity and the spawn description", () => {
		const { reg, add } = registry();
		add("A", "main", 10, "running");
		reg.setActivity("A", "grep");
		const [row] = buildRoster(reg, (id) => (id === "A" ? { agent: "scout", task: "find auth" } : undefined));
		expect(row).toMatchObject({ status: "running", activity: "grep", agent: "scout", task: "find auth" });
	});

	it("is empty when there are no subagents", () => {
		expect(buildRoster(registry().reg, () => undefined)).toEqual([]);
	});
});

describe("formatAge and statusGlyph", () => {
	it("formats ages compactly", () => {
		expect(formatAge(0)).toBe("now");
		expect(formatAge(4_000)).toBe("now");
		expect(formatAge(42_000)).toBe("42s");
		expect(formatAge(7 * 60_000)).toBe("7m");
		expect(formatAge(3 * 3600_000)).toBe("3h");
		expect(formatAge(50 * 3600_000)).toBe("2d");
		expect(formatAge(-5)).toBe("now");
	});

	it("gives every status its own glyph", () => {
		const glyphs = (["running", "idle", "parked", "aborted"] as const).map(statusGlyph);
		expect(new Set(glyphs).size).toBe(4);
	});
});
