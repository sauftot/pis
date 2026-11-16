// The one-line agents summary above the footer: who is running, and which keys control and inspect agents.

import { truncateToWidth } from "@earendil-works/pi-tui";
import { type AgentStatus, type RosterRow, statusGlyph } from "../../../core/agents/index.ts";
import { keyDisplayText } from "../components/keybinding-hints.ts";
import { theme } from "../theme/theme.ts";

export interface AgentsLineInput {
	rows: readonly RosterRow[];
	/** Id of the agent the view is on, or undefined for the main agent. */
	focusedId: string | undefined;
	width: number;
}

/** Up to this many agents are named one by one; more are summarised by status. */
const MAX_NAMED = 4;

/** The line to show, or undefined when there are no agents and the view is on the main agent. */
export function formatAgentsLine(input: AgentsLineInput): string | undefined {
	const { rows, focusedId, width } = input;
	if (focusedId !== undefined) return truncateToWidth(focusedLine(rows, focusedId), width, "…");
	if (rows.length === 0) return undefined;
	return truncateToWidth(overviewLine(rows), width, "…");
}

function overviewLine(rows: readonly RosterRow[]): string {
	const hints = [hint("app.agents.hub", "agent hub"), hint("app.agents.next", "next agent")]
		.filter(Boolean)
		.join("  ");
	return `${theme.fg("muted", "agents")} ${summary(rows)}  ${theme.fg("dim", "│")}  ${hints}`;
}

function focusedLine(rows: readonly RosterRow[], focusedId: string): string {
	const row = rows.find((candidate) => candidate.id === focusedId);
	const state = row ? ` (${row.status})` : "";
	const hints = [
		hint("app.agents.main", "back to main"),
		hint("app.agents.hub", "agent hub"),
		hint("app.interrupt", "interrupt"),
	]
		.filter(Boolean)
		.join("  ");
	const banner = theme.bold(theme.fg("accent", `▶ viewing ${focusedId}${state}`));
	return `${banner} ${theme.fg("muted", "— what you type steers this agent")}  ${theme.fg("dim", "│")}  ${hints}`;
}

function summary(rows: readonly RosterRow[]): string {
	if (rows.length <= MAX_NAMED) {
		return rows.map((row) => colored(row.status, `${statusGlyph(row.status)} ${row.id}`)).join("  ");
	}
	const counts = new Map<AgentStatus, number>();
	for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
	return (["running", "idle", "parked", "aborted"] as const)
		.filter((status) => counts.has(status))
		.map((status) => colored(status, `${statusGlyph(status)} ${counts.get(status)} ${status}`))
		.join("  ");
}

/** Status color shared by the line and the hub. */
export function colored(status: AgentStatus, text: string): string {
	const color = { running: "success", idle: "muted", parked: "dim", aborted: "error" } as const;
	return theme.fg(color[status], text);
}

function hint(binding: Parameters<typeof keyDisplayText>[0], label: string): string {
	const keys = keyDisplayText(binding);
	return keys ? `${theme.fg("accent", keys)} ${theme.fg("muted", label)}` : "";
}
