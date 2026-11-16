// The agent hub: a roster of every subagent with a details inspector and the keys to focus, message,
// interrupt, kill and revive them.

import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { type AgentStatus, formatAge, type RosterRow, statusGlyph } from "../../../core/agents/index.ts";
import { keyDisplayText } from "../components/keybinding-hints.ts";
import { theme } from "../theme/theme.ts";
import { colored } from "./agents-line.ts";

export interface AgentHubActions {
	/** Show the agent in the chat view. Rejects with a message fit to show the user. */
	focus(id: string): Promise<void>;
	/** Each of these resolves to the one-line outcome to display. */
	message(id: string, text: string): Promise<string>;
	interrupt(id: string): Promise<string>;
	kill(id: string): Promise<string>;
	revive(id: string): Promise<string>;
	close(): void;
}

export interface AgentHubDeps {
	getRows(): RosterRow[];
	getMainStatus(): AgentStatus | undefined;
	getFocusedId(): string | undefined;
	now(): number;
	actions: AgentHubActions;
	requestRender(): void;
}

/** Rows shown at once; longer rosters scroll with the selection. */
const MAX_VISIBLE_ROWS = 10;
const MAX_TASK_LINES = 3;

export class AgentHubComponent implements Component, Focusable {
	private readonly deps: AgentHubDeps;
	private readonly input = new Input({ prompt: "" });
	private selectedId: string | undefined;
	private detailsOpen = false;
	private mode: "list" | "message" = "list";
	private feedback: string | undefined;
	private scrollTop = 0;
	private _focused = false;

	constructor(deps: AgentHubDeps) {
		this.deps = deps;
		this.input.onSubmit = (value) => this.sendMessage(value);
		this.input.onEscape = () => this.leaveMessageMode();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.mode === "message";
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.mode === "message") {
			this.input.handleInput(data);
			this.deps.requestRender();
			return;
		}
		const keys = getKeybindings();
		const rows = this.deps.getRows();
		const selected = this.selected(rows);

		if (keys.matches(data, "tui.select.cancel")) this.deps.actions.close();
		else if (keys.matches(data, "tui.select.up")) this.move(rows, -1);
		else if (keys.matches(data, "tui.select.down")) this.move(rows, 1);
		else if (keys.matches(data, "app.agents.details")) this.detailsOpen = !this.detailsOpen;
		else if (selected && keys.matches(data, "tui.select.confirm")) this.focusSelected(selected.id);
		else if (selected && keys.matches(data, "app.agents.message")) this.enterMessageMode();
		else if (selected && keys.matches(data, "app.agents.interrupt"))
			this.run(this.deps.actions.interrupt(selected.id));
		else if (selected && keys.matches(data, "app.agents.kill")) this.run(this.deps.actions.kill(selected.id));
		else if (selected && keys.matches(data, "app.agents.revive")) this.run(this.deps.actions.revive(selected.id));
		else return;
		this.deps.requestRender();
	}

	render(width: number): string[] {
		const rows = this.deps.getRows();
		const selected = this.selected(rows);
		const lines: string[] = [theme.fg("border", "─".repeat(Math.max(1, width)))];

		lines.push(this.titleLine(rows, width), "");
		if (rows.length === 0) {
			lines.push(
				theme.fg("muted", " No agents yet. Ask the model to delegate work with the task tool,"),
				theme.fg("muted", ' or enable agents with "agents.enabled": true in settings.'),
			);
		} else {
			lines.push(...this.rowLines(rows, selected, width));
		}

		if (this.detailsOpen && selected) lines.push("", ...this.detailLines(selected, width));
		if (this.feedback) lines.push("", truncateToWidth(` ${this.feedback}`, width, "…"));
		if (this.mode === "message" && selected) {
			lines.push("", ...this.messagePromptLines(selected, width));
		}
		lines.push(
			"",
			...wrapHints(this.hints(Boolean(selected)), width),
			theme.fg("border", "─".repeat(Math.max(1, width))),
		);
		return lines;
	}

	private titleLine(rows: readonly RosterRow[], width: number): string {
		const running = rows.filter((row) => row.status === "running").length;
		const title = `${theme.bold(theme.fg("accent", " Agents"))} ${theme.fg("dim", `${rows.length} total, ${running} running`)}`;
		const main = this.deps.getMainStatus();
		const viewing = this.deps.getFocusedId();
		const where = viewing ? `viewing ${viewing}` : "viewing main";
		const right = theme.fg("muted", `${where}${main ? ` · main ${statusGlyph(main)} ${main}` : ""} `);
		const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(right));
		return truncateToWidth(`${title}${" ".repeat(gap)}${right}`, width, "…");
	}

	private rowLines(rows: readonly RosterRow[], selected: RosterRow | undefined, width: number): string[] {
		const index = Math.max(
			0,
			rows.findIndex((row) => row.id === selected?.id),
		);
		if (index < this.scrollTop) this.scrollTop = index;
		if (index >= this.scrollTop + MAX_VISIBLE_ROWS) this.scrollTop = index - MAX_VISIBLE_ROWS + 1;
		const visible = rows.slice(this.scrollTop, this.scrollTop + MAX_VISIBLE_ROWS);

		const idWidth = Math.min(22, Math.max(...rows.map((row) => row.depth * 2 + row.id.length)));
		const typeWidth = Math.min(10, Math.max(...rows.map((row) => (row.agent ?? "").length)));
		const now = this.deps.now();
		const lines = visible.map((row) => {
			const isSelected = row.id === selected?.id;
			const name = `${"  ".repeat(row.depth)}${row.id}`;
			const pointer = isSelected ? theme.fg("accent", "▸") : " ";
			const text = row.activity ?? row.task ?? "";
			const cells = [
				pointer,
				colored(row.status, statusGlyph(row.status)),
				isSelected ? theme.bold(theme.fg("accent", pad(name, idWidth))) : pad(name, idWidth),
				theme.fg("dim", pad(row.agent ?? "", typeWidth)),
				colored(row.status, pad(row.status, 7)),
				theme.fg("dim", pad(formatAge(now - row.lastActivity), 4, "right")),
				row.activity ? theme.fg("warning", oneLine(text)) : theme.fg("muted", oneLine(text)),
			];
			const line = ` ${cells.join(" ")}`;
			return truncateToWidth(
				row.id === this.deps.getFocusedId() ? `${line} ${theme.fg("accent", "◀ viewing")}` : line,
				width,
				"…",
			);
		});
		const hiddenAbove = this.scrollTop;
		const hiddenBelow = rows.length - this.scrollTop - visible.length;
		if (hiddenAbove > 0) lines.unshift(theme.fg("dim", ` ↑ ${hiddenAbove} more`));
		if (hiddenBelow > 0) lines.push(theme.fg("dim", ` ↓ ${hiddenBelow} more`));
		return lines;
	}

	private detailLines(row: RosterRow, width: number): string[] {
		const label = (name: string) => theme.fg("dim", `${name.padEnd(11)}`);
		const lines = [
			` ${theme.bold(row.id)} ${theme.fg("dim", `· ${row.agent ?? "agent"} · ${row.status}`)}`,
			...wrapPlain(row.task ?? "(no task recorded)", Math.max(10, width - 14), MAX_TASK_LINES).map(
				(text, i) => ` ${i === 0 ? label("task") : label("")}${text}`,
			),
			` ${label("doing")}${row.activity ?? (row.status === "running" ? "thinking" : "nothing right now")}`,
			` ${label("parent")}${row.parentId ?? "main"}`,
			` ${label("started")}${formatAge(this.deps.now() - row.createdAt)} ago`,
			` ${label("transcript")}${row.sessionFile ?? "not saved (session is not persisted)"}`,
		];
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	private messagePromptLines(row: RosterRow, width: number): string[] {
		const prompt = ` ${theme.fg("accent", `Message to ${row.id}`)} ${theme.fg("dim", `(${keyDisplayText("tui.select.confirm")} send, ${keyDisplayText("tui.select.cancel")} cancel)`)}`;
		return [
			truncateToWidth(prompt, width, "…"),
			...this.input.render(Math.max(1, width - 2)).map((line) => ` ${line}`),
		];
	}

	private hints(hasSelection: boolean): string[] {
		if (this.mode === "message") return [];
		const key = (binding: Parameters<typeof keyDisplayText>[0], label: string) => {
			const keys = keyDisplayText(binding);
			return keys ? `${theme.fg("accent", keys)} ${theme.fg("muted", label)}` : "";
		};
		const move = [keyDisplayText("tui.select.up"), keyDisplayText("tui.select.down")].filter(Boolean).join("/");
		return [
			move ? `${theme.fg("accent", move)} ${theme.fg("muted", "select")}` : "",
			...(hasSelection
				? [
						key("tui.select.confirm", "view & steer"),
						key("app.agents.message", "message"),
						key("app.agents.interrupt", "interrupt"),
						key("app.agents.kill", "kill"),
						key("app.agents.revive", "revive"),
						key("app.agents.details", "details"),
					]
				: []),
			key("tui.select.cancel", "close"),
		].filter(Boolean);
	}

	private selected(rows: readonly RosterRow[]): RosterRow | undefined {
		const current = rows.find((row) => row.id === this.selectedId);
		if (current) return current;
		this.selectedId = rows[0]?.id;
		return rows[0];
	}

	private move(rows: readonly RosterRow[], delta: -1 | 1): void {
		if (rows.length === 0) return;
		const at = Math.max(
			0,
			rows.findIndex((row) => row.id === this.selectedId),
		);
		this.selectedId = rows[(at + delta + rows.length) % rows.length]?.id;
		this.feedback = undefined;
	}

	private focusSelected(id: string): void {
		this.deps.actions.focus(id).then(
			() => this.deps.actions.close(),
			(error: unknown) => {
				this.feedback = theme.fg(
					"error",
					`Cannot view ${id}: ${error instanceof Error ? error.message : String(error)}`,
				);
				this.deps.requestRender();
			},
		);
	}

	private enterMessageMode(): void {
		this.mode = "message";
		this.input.setValue("");
		this.input.focused = this._focused;
		this.feedback = undefined;
	}

	private leaveMessageMode(): void {
		this.mode = "list";
		this.input.focused = false;
		this.deps.requestRender();
	}

	private sendMessage(text: string): void {
		const target = this.selectedId;
		this.leaveMessageMode();
		if (!target || !text.trim()) return;
		this.run(this.deps.actions.message(target, text.trim()));
	}

	/** Show an action's outcome (or its failure) as the feedback line. */
	private run(outcome: Promise<string>): void {
		this.feedback = theme.fg("muted", "working…");
		outcome
			.then(
				(message) => {
					this.feedback = theme.fg("success", message);
				},
				(error: unknown) => {
					this.feedback = theme.fg("error", error instanceof Error ? error.message : String(error));
				},
			)
			.finally(() => this.deps.requestRender());
	}
}

function pad(text: string, width: number, align: "left" | "right" = "left"): string {
	const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
	const fill = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	return align === "left" ? `${clipped}${fill}` : `${fill}${clipped}`;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Greedy word wrap of plain text, capped at `maxLines` with a trailing ellipsis. */
function wrapPlain(text: string, width: number, maxLines: number): string[] {
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

/** Join hints with two spaces, starting a new line when the next one would overflow. */
function wrapHints(hints: readonly string[], width: number): string[] {
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
	return lines;
}
