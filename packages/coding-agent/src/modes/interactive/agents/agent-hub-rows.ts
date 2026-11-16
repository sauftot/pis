// Drawing the agent hub's lists: the roster and the activity log, the inspector, and small text helpers.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type ActivityEntry,
	type ActivityKind,
	formatAge,
	type RosterRow,
	statusGlyph,
} from "../../../core/agents/index.ts";
import { theme } from "../theme/theme.ts";
import { colored } from "./agents-line.ts";

/** Rows shown at once; longer lists scroll with the selection. */
export const MAX_VISIBLE_ROWS = 10;
const MAX_TASK_LINES = 3;

export interface WindowedList {
	lines: string[];
	/** The scroll offset to keep for the next draw. */
	scrollTop: number;
}

export function rosterRowLines(input: {
	rows: readonly RosterRow[];
	selectedId: string | undefined;
	focusedId: string | undefined;
	now: number;
	width: number;
	scrollTop: number;
}): WindowedList {
	const { rows, selectedId, focusedId, now, width } = input;
	const idWidth = Math.min(22, Math.max(...rows.map((row) => row.depth * 2 + row.id.length)));
	const typeWidth = Math.min(10, Math.max(...rows.map((row) => (row.agent ?? "").length)));
	const render = (row: RosterRow): string => {
		const isSelected = row.id === selectedId;
		const name = `${"  ".repeat(row.depth)}${row.id}`;
		const text = oneLine(row.activity ?? row.task ?? "");
		const cells = [
			isSelected ? theme.fg("accent", "▸") : " ",
			colored(row.status, statusGlyph(row.status)),
			isSelected ? theme.bold(theme.fg("accent", pad(name, idWidth))) : pad(name, idWidth),
			theme.fg("dim", pad(row.agent ?? "", typeWidth)),
			colored(row.status, pad(row.status, 7)),
			theme.fg("dim", pad(formatAge(now - row.lastActivity), 4, "right")),
			row.activity ? theme.fg("warning", text) : theme.fg("muted", text),
		];
		const line = ` ${cells.join(" ")}`;
		return truncateToWidth(row.id === focusedId ? `${line} ${theme.fg("accent", "◀ viewing")}` : line, width, "…");
	};
	return windowed(
		rows,
		rows.findIndex((row) => row.id === selectedId),
		input.scrollTop,
		render,
	);
}

export function activityRowLines(input: {
	entries: readonly ActivityEntry[];
	selectedSeq: number | undefined;
	width: number;
	scrollTop: number;
}): WindowedList {
	const { entries, selectedSeq, width } = input;
	const idWidth = Math.min(16, Math.max(...entries.map((entry) => entry.agentId.length)));
	const render = (entry: ActivityEntry): string => {
		const isSelected = entry.seq === selectedSeq;
		const cells = [
			isSelected ? theme.fg("accent", "▸") : " ",
			theme.fg("dim", formatClock(entry.at)),
			isSelected ? theme.bold(theme.fg("accent", pad(entry.agentId, idWidth))) : pad(entry.agentId, idWidth),
			kindCell(entry.kind),
			kindText(entry),
		];
		return truncateToWidth(` ${cells.join(" ")}`, width, "…");
	};
	return windowed(
		entries,
		entries.findIndex((entry) => entry.seq === selectedSeq),
		input.scrollTop,
		render,
	);
}

export function detailLines(row: RosterRow, now: number, width: number): string[] {
	const label = (name: string) => theme.fg("dim", name.padEnd(11));
	const lines = [
		` ${theme.bold(row.id)} ${theme.fg("dim", `· ${row.agent ?? "agent"} · ${row.status}`)}`,
		...wrapPlain(row.task ?? "(no task recorded)", Math.max(10, width - 14), MAX_TASK_LINES).map(
			(text, i) => ` ${i === 0 ? label("task") : label("")}${text}`,
		),
		` ${label("doing")}${row.activity ?? (row.status === "running" ? "thinking" : "nothing right now")}`,
		` ${label("parent")}${row.parentId ?? "main"}`,
		` ${label("started")}${formatAge(now - row.createdAt)} ago`,
		` ${label("transcript")}${row.sessionFile ?? "not saved (session is not persisted)"}`,
	];
	return lines.map((line) => truncateToWidth(line, width, "…"));
}

/** `HH:MM:SS` in local time. */
export function formatClock(at: number): string {
	const date = new Date(at);
	return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

const KIND_LABEL: Record<ActivityKind, string> = {
	lifecycle: "lifecycle",
	tool: "tool",
	response: "reply",
	message: "message",
	error: "error",
};

function kindCell(kind: ActivityKind): string {
	const text = pad(KIND_LABEL[kind], 9);
	switch (kind) {
		case "error":
			return theme.fg("error", text);
		case "response":
			return theme.fg("success", text);
		case "message":
			return theme.fg("accent", text);
		case "tool":
			return theme.fg("dim", text);
		case "lifecycle":
			return theme.fg("muted", text);
	}
}

function kindText(entry: ActivityEntry): string {
	return entry.kind === "error" ? theme.fg("error", entry.text) : entry.text;
}

/** The visible slice around the selection, with `↑ n more` and `↓ n more` markers for what is hidden. */
function windowed<T>(
	items: readonly T[],
	selectedIndex: number,
	scrollTop: number,
	render: (item: T) => string,
): WindowedList {
	const index = Math.max(0, selectedIndex);
	let top = Math.min(scrollTop, Math.max(0, items.length - MAX_VISIBLE_ROWS));
	if (index < top) top = index;
	if (index >= top + MAX_VISIBLE_ROWS) top = index - MAX_VISIBLE_ROWS + 1;
	const visible = items.slice(top, top + MAX_VISIBLE_ROWS);
	const lines = visible.map(render);
	if (top > 0) lines.unshift(theme.fg("dim", ` ↑ ${top} more`));
	const below = items.length - top - visible.length;
	if (below > 0) lines.push(theme.fg("dim", ` ↓ ${below} more`));
	return { lines, scrollTop: top };
}

export function pad(text: string, width: number, align: "left" | "right" = "left"): string {
	const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
	const fill = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	return align === "left" ? `${clipped}${fill}` : `${fill}${clipped}`;
}

export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Greedy word wrap of plain text, capped at `maxLines` with a trailing ellipsis. */
export function wrapPlain(text: string, width: number, maxLines: number): string[] {
	const lines: string[] = [];
	let current = "";
	for (const word of oneLine(text).split(" ")) {
		if (current && current.length + 1 + word.length > width) {
			lines.push(current);
			current = word;
		} else {
			current = current ? `${current} ${word}` : word;
		}
	}
	if (current) lines.push(current);
	if (lines.length <= maxLines) return lines;
	return [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1]?.slice(0, Math.max(0, width - 1))}…`];
}

/** Join hints with two spaces, starting a new line when the next one would overflow. A hint wider than a line is cut. */
export function wrapHints(hints: readonly string[], width: number): string[] {
	const lines: string[] = [];
	let current = "";
	for (const hint of hints) {
		const next = current ? `${current}  ${hint}` : ` ${hint}`;
		if (current && visibleWidth(next) > width) {
			lines.push(current);
			current = ` ${hint}`;
		} else {
			current = next;
		}
	}
	if (current) lines.push(current);
	return lines.map((line) => truncateToWidth(line, width, "…"));
}
