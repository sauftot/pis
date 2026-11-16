import { describe, expect, it } from "vitest";
import { allocateAgentId } from "../../../src/core/agents/index.ts";

describe("allocateAgentId", () => {
	it("keeps a clean requested name", () => {
		expect(allocateAgentId("AuthScout", new Set())).toBe("AuthScout");
	});

	it("strips characters that are unsafe in a file name or an address", () => {
		expect(allocateAgentId("../evil name:1", new Set())).toBe("evilname1");
	});

	it("truncates to 32 characters", () => {
		expect(allocateAgentId("A".repeat(50), new Set())).toHaveLength(32);
	});

	it("generates an AdjectiveNoun when no usable name is given", () => {
		for (const requested of [undefined, "", "   ", "!!!"]) {
			expect(allocateAgentId(requested, new Set())).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/);
		}
	});

	it("never returns a reserved address", () => {
		for (const requested of ["main", "MAIN", "all", "All"]) {
			expect(["main", "all"]).not.toContain(allocateAgentId(requested, new Set()).toLowerCase());
		}
	});

	it("adds the next free numeric suffix to a taken id", () => {
		expect(allocateAgentId("Scout", new Set(["Scout"]))).toBe("Scout2");
		expect(allocateAgentId("Scout", new Set(["Scout", "Scout2"]))).toBe("Scout3");
	});

	it("treats ids as case-insensitive because they become file names", () => {
		expect(allocateAgentId("scout", new Set(["Scout"]))).toBe("scout2");
	});

	it("keeps a suffixed id within 32 characters", () => {
		const long = "A".repeat(32);
		const id = allocateAgentId(long, new Set([long]));
		expect(id).toHaveLength(32);
		expect(id.endsWith("2")).toBe(true);
	});
});
