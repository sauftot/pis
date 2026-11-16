// Agent ids: safe, readable names that double as file names and message addresses.

const ADJECTIVES = [
	"Brisk",
	"Calm",
	"Deft",
	"Eager",
	"Faint",
	"Keen",
	"Lucid",
	"Nimble",
	"Quiet",
	"Swift",
	"Tidy",
	"Wry",
];
const NOUNS = [
	"Falcon",
	"Heron",
	"Otter",
	"Badger",
	"Lynx",
	"Marten",
	"Osprey",
	"Raven",
	"Sparrow",
	"Stoat",
	"Wren",
	"Yak",
];

/** Ids that name an address rather than an agent. */
const RESERVED = new Set(["main", "all"]);

const MAX_LENGTH = 32;

/**
 * Pick an id for a new agent. A requested name is reduced to `[A-Za-z0-9_-]`; a blank or reserved result falls
 * back to a generated AdjectiveNoun. A taken id gets the next free numeric suffix.
 */
export function allocateAgentId(requested: string | undefined, taken: ReadonlySet<string>): string {
	const base = sanitize(requested) ?? generate(taken);
	if (!isTaken(base, taken)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base.slice(0, MAX_LENGTH - String(n).length)}${n}`;
		if (!isTaken(candidate, taken)) return candidate;
	}
}

function sanitize(name: string | undefined): string | undefined {
	const cleaned = (name ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, MAX_LENGTH);
	return cleaned.length === 0 || RESERVED.has(cleaned.toLowerCase()) ? undefined : cleaned;
}

function generate(taken: ReadonlySet<string>): string {
	for (let attempt = 0; attempt < 50; attempt++) {
		const candidate = `${pick(ADJECTIVES)}${pick(NOUNS)}`;
		if (!isTaken(candidate, taken)) return candidate;
	}
	return `${pick(ADJECTIVES)}${pick(NOUNS)}`;
}

function pick(list: readonly string[]): string {
	return list[Math.floor(Math.random() * list.length)]!;
}

/** Ids are compared case-insensitively because they become file names on case-insensitive filesystems. */
function isTaken(id: string, taken: ReadonlySet<string>): boolean {
	const lower = id.toLowerCase();
	for (const other of taken) if (other.toLowerCase() === lower) return true;
	return false;
}
