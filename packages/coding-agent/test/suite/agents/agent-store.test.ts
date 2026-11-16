import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentMeta, AgentStore } from "../../../src/core/agents/index.ts";

const meta = (id: string, patch: Partial<AgentMeta> = {}): AgentMeta => ({
	id,
	displayName: id,
	agent: "worker",
	parentId: "main",
	task: "do it",
	sessionFile: `/x/${id}.jsonl`,
	createdAt: 1,
	killed: false,
	...patch,
});

describe("AgentStore", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const newRoot = () => {
		const dir = mkdtempSync(join(tmpdir(), "piss-store-"));
		dirs.push(dir);
		return join(dir, "agents");
	};

	it("round-trips an agent's meta", () => {
		const store = new AgentStore(newRoot());
		store.write(meta("Alpha"));
		expect(store.read("Alpha")).toEqual(meta("Alpha"));
		expect(store.list()).toEqual([meta("Alpha")]);
	});

	it("merges updates and leaves a missing agent missing", () => {
		const store = new AgentStore(newRoot());
		store.write(meta("Alpha"));
		store.update("Alpha", { killed: true });
		store.update("Ghost", { killed: true });
		expect(store.read("Alpha")?.killed).toBe(true);
		expect(store.read("Ghost")).toBeUndefined();
	});

	it("skips a corrupt entry without hiding the others", () => {
		const root = newRoot();
		const store = new AgentStore(root);
		store.write(meta("Good"));
		mkdirSync(join(root, "Bad"), { recursive: true });
		writeFileSync(join(root, "Bad", "meta.json"), "{not json");
		mkdirSync(join(root, "Empty"), { recursive: true });
		expect(store.list().map((m) => m.id)).toEqual(["Good"]);
	});

	it("reports an agent's directory without creating it, and creates it on demand", () => {
		const root = newRoot();
		const store = new AgentStore(root);
		const dir = store.dirFor("Alpha");
		expect(dir).toBe(join(root, "Alpha"));
		expect(existsSync(dir!)).toBe(false);
		expect(store.ensureDir("Alpha")).toBe(dir);
		expect(existsSync(dir!)).toBe(true);
		expect(new AgentStore(undefined).dirFor("Alpha")).toBeUndefined();
	});

	it("does nothing when the session is not persisted", () => {
		const store = new AgentStore(undefined);
		expect(store.persistent).toBe(false);
		expect(store.ensureDir("A")).toBeUndefined();
		store.write(meta("A"));
		expect(store.list()).toEqual([]);
		expect(store.read("A")).toBeUndefined();
	});

	it("lists nothing before the first agent is written", () => {
		expect(new AgentStore(newRoot()).list()).toEqual([]);
	});
});
