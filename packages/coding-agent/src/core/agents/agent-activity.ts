// A bounded, in-memory log of what the agents of a session did: lifecycle changes, tool calls, replies and messages.

export type ActivityKind = "lifecycle" | "tool" | "response" | "message" | "error";

export interface ActivityEntry {
	/** Increases with every entry, so entries order and identify themselves. */
	seq: number;
	at: number;
	/** The subagent the entry is about. For a message, the subagent at either end of it. */
	agentId: string;
	kind: ActivityKind;
	/** One line. */
	text: string;
}

export type ActivityListener = (entry: ActivityEntry) => void;

export class AgentActivityLog {
	private readonly capacity: number;
	private items: ActivityEntry[] = [];
	private nextSeq = 1;
	private readonly listeners = new Set<ActivityListener>();

	/** The oldest entries are dropped beyond `capacity`. */
	constructor(capacity = 500) {
		this.capacity = capacity;
	}

	record(input: { agentId: string; kind: ActivityKind; text: string; at?: number }): ActivityEntry {
		const entry: ActivityEntry = {
			seq: this.nextSeq++,
			at: input.at ?? Date.now(),
			agentId: input.agentId,
			kind: input.kind,
			text: input.text,
		};
		this.items.push(entry);
		if (this.items.length > this.capacity) this.items = this.items.slice(this.items.length - this.capacity);
		for (const listener of [...this.listeners]) listener(entry);
		return entry;
	}

	/** Oldest first. */
	entries(): readonly ActivityEntry[] {
		return this.items;
	}

	onChange(listener: ActivityListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

/** One line of at most `max` characters: whitespace collapsed, cut with an ellipsis. */
export function gist(text: string, max = 160): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 1))}…`;
}

/** The most telling argument of a tool call: its path, command, pattern or query, else the whole arguments. */
export function summarizeToolArgs(args: unknown, max = 80): string {
	if (typeof args === "string") return gist(args, max);
	if (typeof args !== "object" || args === null) return "";
	const record = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "command", "pattern", "query", "url", "task"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return gist(value, max);
	}
	const json = JSON.stringify(args);
	return json === "{}" ? "" : gist(json, max);
}

export type ActivityKindFilter = "all" | "errors" | "responses" | "tools" | "messages" | "lifecycle";

/** The order the hub cycles through. */
export const ACTIVITY_KIND_FILTERS: readonly ActivityKindFilter[] = [
	"all",
	"errors",
	"responses",
	"tools",
	"messages",
	"lifecycle",
];

const KIND_OF_FILTER: Record<Exclude<ActivityKindFilter, "all">, ActivityKind> = {
	errors: "error",
	responses: "response",
	tools: "tool",
	messages: "message",
	lifecycle: "lifecycle",
};

/** Entries of one kind (or all), optionally of one agent, whose agent or text contains every word of `query`. */
export function filterActivity(
	entries: readonly ActivityEntry[],
	options: { kind: ActivityKindFilter; agentId?: string; query?: string },
): ActivityEntry[] {
	const words = (options.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	return entries.filter((entry) => {
		if (options.kind !== "all" && entry.kind !== KIND_OF_FILTER[options.kind]) return false;
		if (options.agentId !== undefined && entry.agentId !== options.agentId) return false;
		const haystack = `${entry.agentId} ${entry.text}`.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}
