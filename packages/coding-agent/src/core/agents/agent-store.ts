// On-disk record of a session's subagents: one directory per agent holding its transcript and a meta file.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What the store remembers about an agent so a resumed session can list and revive it. */
export interface AgentMeta {
	id: string;
	displayName: string;
	/** Name of the agent definition it runs. */
	agent: string;
	parentId: string;
	/** The task it was spawned with, for rosters. */
	task: string;
	/** Model pattern it was spawned with, so a revive runs on the same model. Absent: the default. */
	model?: string;
	/** Absolute transcript path. Null until the agent's session exists. */
	sessionFile: string | null;
	createdAt: number;
	/** Set when the user or a parent killed the agent; it stays dead until revived. */
	killed: boolean;
}

const META_FILE = "meta.json";

export class AgentStore {
	private readonly root: string | undefined;

	/** `root` is `<session dir>/<session>/agents`, or undefined for a session that is not persisted. */
	constructor(root: string | undefined) {
		this.root = root;
	}

	get persistent(): boolean {
		return this.root !== undefined;
	}

	/** Where agent `id`'s transcript and meta live. Nothing is created: a spawn that fails leaves no trace. */
	dirFor(id: string): string | undefined {
		return this.root ? join(this.root, id) : undefined;
	}

	/** {@link dirFor}, created on demand. */
	ensureDir(id: string): string | undefined {
		const dir = this.dirFor(id);
		if (dir) mkdirSync(dir, { recursive: true });
		return dir;
	}

	write(meta: AgentMeta): void {
		const dir = this.ensureDir(meta.id);
		if (dir) writeFileSync(join(dir, META_FILE), JSON.stringify(meta, null, 2));
	}

	/** Merge `patch` into the stored meta of `id`. A missing meta is left missing. */
	update(id: string, patch: Partial<Omit<AgentMeta, "id">>): void {
		const current = this.read(id);
		if (current) this.write({ ...current, ...patch });
	}

	read(id: string): AgentMeta | undefined {
		if (!this.root) return undefined;
		const file = join(this.root, id, META_FILE);
		if (!existsSync(file)) return undefined;
		return parseMeta(readFileSync(file, "utf-8"));
	}

	/** Every agent with a readable meta file. A corrupt entry is skipped so one bad file cannot hide the rest. */
	list(): AgentMeta[] {
		if (!this.root || !existsSync(this.root)) return [];
		const metas: AgentMeta[] = [];
		for (const id of readdirSync(this.root)) {
			const meta = this.read(id);
			if (meta) metas.push(meta);
		}
		return metas;
	}
}

function parseMeta(text: string): AgentMeta | undefined {
	try {
		const value = JSON.parse(text) as Partial<AgentMeta>;
		if (typeof value.id !== "string" || typeof value.parentId !== "string") return undefined;
		return {
			id: value.id,
			displayName: value.displayName ?? value.id,
			agent: value.agent ?? "worker",
			parentId: value.parentId,
			task: value.task ?? "",
			model: typeof value.model === "string" ? value.model : undefined,
			sessionFile: value.sessionFile ?? null,
			createdAt: value.createdAt ?? 0,
			killed: value.killed ?? false,
		};
	} catch {
		return undefined;
	}
}
