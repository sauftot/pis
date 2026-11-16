// Display model of the agent roster: the subagent tree, flattened into ordered rows.

import type { AgentRegistry } from "./agent-registry.ts";
import type { AgentStatus } from "./agent-types.ts";

export interface RosterRow {
	id: string;
	/** Nesting depth below the main agent; 0 for the main agent's direct children. */
	depth: number;
	parentId: string | undefined;
	status: AgentStatus;
	/** Name of the agent definition it runs, when known. */
	agent: string | undefined;
	/** The task it was spawned with, when known. */
	task: string | undefined;
	/** Current tool, or why it is waiting. */
	activity: string | undefined;
	createdAt: number;
	lastActivity: number;
	sessionFile: string | null;
}

/**
 * Every subagent as rows in tree order: each agent is followed by its own subagents, siblings by creation
 * time. The main agent is not a row. An agent whose parent is gone is shown as a root.
 */
export function buildRoster(
	registry: AgentRegistry,
	describe: (id: string) => { agent: string; task: string } | undefined,
): RosterRow[] {
	const subs = registry.list().filter((ref) => ref.kind === "sub");
	const ids = new Set(subs.map((ref) => ref.id));
	const childrenOf = new Map<string | undefined, typeof subs>();
	for (const ref of subs) {
		const key = ref.parentId !== undefined && ids.has(ref.parentId) ? ref.parentId : undefined;
		childrenOf.set(key, [...(childrenOf.get(key) ?? []), ref]);
	}

	const rows: RosterRow[] = [];
	const visit = (parent: string | undefined, depth: number) => {
		const children = (childrenOf.get(parent) ?? []).toSorted(
			(a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
		);
		for (const ref of children) {
			const info = describe(ref.id);
			rows.push({
				id: ref.id,
				depth,
				parentId: ref.parentId,
				status: ref.status,
				agent: info?.agent,
				task: info?.task,
				activity: ref.activity,
				createdAt: ref.createdAt,
				lastActivity: ref.lastActivity,
				sessionFile: ref.sessionFile,
			});
			visit(ref.id, depth + 1);
		}
	};
	visit(undefined, 0);
	return rows;
}

/** One glyph per status, so a roster reads at a glance. */
export function statusGlyph(status: AgentStatus): string {
	return { running: "●", idle: "○", parked: "◌", aborted: "✕" }[status];
}

/** Compact age: `now`, `42s`, `7m`, `3h`, `2d`. */
export function formatAge(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 5) return "now";
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export type RosterLayout = "tree" | "flat";

/**
 * Arrange rows for display. `tree` keeps the parent/child order of {@link buildRoster}. `flat` ignores lineage and
 * puts what needs attention first: running agents, then idle, parked and killed, most recently active first.
 */
export function layoutRoster(rows: readonly RosterRow[], layout: RosterLayout): RosterRow[] {
	if (layout === "tree") return [...rows];
	const rank: Record<AgentStatus, number> = { running: 0, idle: 1, parked: 2, aborted: 3 };
	return rows
		.map((row) => ({ ...row, depth: 0 }))
		.sort((a, b) => rank[a.status] - rank[b.status] || b.lastActivity - a.lastActivity || (a.id < b.id ? -1 : 1));
}

/** Rows matching every word of `query` in their id, type, task, status or current activity. A blank query matches all. */
export function filterRoster(rows: readonly RosterRow[], query: string): RosterRow[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [...rows];
	return rows.filter((row) => {
		const haystack = [row.id, row.agent, row.task, row.status, row.activity].join(" ").toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}
