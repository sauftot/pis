// The agent hub: a roster of every subagent and an activity log of what they did, with an inspector and the keys to
// view, message, interrupt, kill and revive agents, filter what is listed, and switch the layout.

import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	ACTIVITY_KIND_FILTERS,
	type ActivityEntry,
	type AgentStatus,
	filterActivity,
	filterRoster,
	layoutRoster,
	type RosterLayout,
	type RosterRow,
	statusGlyph,
} from "../../../core/agents/index.ts";
import { keyDisplayText } from "../components/keybinding-hints.ts";
import { theme } from "../theme/theme.ts";
import { activityRowLines, detailLines, rosterRowLines, wrapHints } from "./agent-hub-rows.ts";

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
	/** Every subagent in tree order. */
	getRows(): RosterRow[];
	/** Everything the agents did, oldest first. */
	getActivity(): readonly ActivityEntry[];
	getMainStatus(): AgentStatus | undefined;
	getFocusedId(): string | undefined;
	now(): number;
	actions: AgentHubActions;
	requestRender(): void;
}

type View = "agents" | "activity";
type Mode = "list" | "message" | "filter";
type Binding = Parameters<typeof keyDisplayText>[0];

export class AgentHubComponent implements Component, Focusable {
	private readonly deps: AgentHubDeps;
	private readonly input = new Input({ prompt: "" });
	private view: View = "agents";
	private mode: Mode = "list";
	private layout: RosterLayout = "tree";
	private detailsOpen = false;
	private feedback: string | undefined;
	private rosterQuery = "";
	private activityQuery = "";
	private kindIndex = 0;
	private scopeId: string | undefined;
	private selectedId: string | undefined;
	private activitySeq: number | undefined;
	/** The activity log follows its newest entry until the selection moves up. */
	private following = true;
	private rosterScroll = 0;
	private activityScroll = 0;
	private _focused = false;

	constructor(deps: AgentHubDeps) {
		this.deps = deps;
		this.input.onSubmit = (value) => this.handleSubmit(value);
		this.input.onEscape = () => this.handleInputEscape();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.mode !== "list";
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (this.mode === "filter" && (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down"))) {
			this.move(keys.matches(data, "tui.select.up") ? -1 : 1);
		} else if (this.mode !== "list") {
			this.input.handleInput(data);
			if (this.mode === "filter") this.setQuery(this.input.getValue());
		} else if (!this.handleListKey(data)) {
			return;
		}
		this.deps.requestRender();
	}

	/** Returns whether the key did something. */
	private handleListKey(data: string): boolean {
		const keys = getKeybindings();
		const is = (binding: Binding) => keys.matches(data, binding);
		const agents = this.view === "agents";

		if (is("tui.select.cancel")) {
			if (this.query) this.setQuery("");
			else this.deps.actions.close();
		} else if (is("tui.select.up")) this.move(-1);
		else if (is("tui.select.down")) this.move(1);
		else if (is("app.agents.activity")) this.switchView();
		else if (is("app.agents.filter")) this.enterFilterMode();
		else if (is("tui.select.confirm")) this.focusSelected();
		else if (agents && is("app.agents.tree")) this.layout = this.layout === "tree" ? "flat" : "tree";
		else if (agents && is("app.agents.details")) this.detailsOpen = !this.detailsOpen;
		else if (agents && is("app.agents.message")) this.enterMessageMode();
		else if (agents && is("app.agents.interrupt")) this.act((id) => this.deps.actions.interrupt(id));
		else if (agents && is("app.agents.kill")) this.act((id) => this.deps.actions.kill(id));
		else if (agents && is("app.agents.revive")) this.act((id) => this.deps.actions.revive(id));
		else if (!agents && is("app.agents.kindFilter"))
			this.kindIndex = (this.kindIndex + 1) % ACTIVITY_KIND_FILTERS.length;
		else if (!agents && is("app.agents.scope")) this.toggleScope();
		else return false;
		return true;
	}

	render(width: number): string[] {
		const line = theme.fg("border", "─".repeat(Math.max(1, width)));
		const lines = [line, this.titleLine(width), this.stateLine(width), ""];
		lines.push(...(this.view === "agents" ? this.agentsBody(width) : this.activityBody(width)));
		if (this.feedback) lines.push("", truncateToWidth(` ${this.feedback}`, width, "…"));
		if (this.mode !== "list") lines.push("", ...this.promptLines(width));
		lines.push("", ...wrapHints(this.hints(), width), line);
		return lines;
	}

	// ---- drawing ----------------------------------------------------------------------------------------------

	private titleLine(width: number): string {
		const all = this.deps.getRows();
		const running = all.filter((row) => row.status === "running").length;
		const title = `${theme.bold(theme.fg("accent", " Agent hub"))} ${theme.fg("dim", `${all.length} ${all.length === 1 ? "agent" : "agents"}, ${running} running`)}`;
		const main = this.deps.getMainStatus();
		const viewing = this.deps.getFocusedId();
		const right = theme.fg(
			"muted",
			`${viewing ? `viewing ${viewing}` : "viewing main"}${main ? ` · main ${statusGlyph(main)} ${main}` : ""} `,
		);
		const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(right));
		return truncateToWidth(`${title}${" ".repeat(gap)}${right}`, width, "…");
	}

	/** The two views as tabs, then what narrows the current one. */
	private stateLine(width: number): string {
		const tab = (name: string, active: boolean) =>
			active ? theme.bold(theme.fg("accent", `[${name}]`)) : theme.fg("dim", ` ${name} `);
		const activityCount = this.deps.getActivity().length;
		const tabs = `${tab("Agents", this.view === "agents")} ${tab(`Activity ${activityCount}`, this.view === "activity")}`;
		const parts =
			this.view === "agents"
				? [this.layout === "tree" ? "tree" : "flat", this.rosterQuery && `filter "${this.rosterQuery}"`]
				: [
						`show ${ACTIVITY_KIND_FILTERS[this.kindIndex]}`,
						`agents: ${this.scopeId ?? "all"}`,
						this.activityQuery && `filter "${this.activityQuery}"`,
						this.following ? "following" : "paused",
					];
		const state = theme.fg("muted", parts.filter(Boolean).join(" · "));
		return truncateToWidth(` ${tabs}  ${theme.fg("dim", "│")}  ${state}`, width, "…");
	}

	private agentsBody(width: number): string[] {
		const total = this.deps.getRows().length;
		const rows = this.rosterRows();
		const selected = this.selectedRow(rows);
		if (rows.length === 0) {
			return total === 0
				? [
						theme.fg("muted", " No agents yet. Ask the model to delegate work with the task tool,"),
						theme.fg("muted", ' or enable agents with "agents.enabled": true in settings.'),
					]
				: [theme.fg("muted", ` No agents match "${this.rosterQuery}".`)];
		}
		const list = rosterRowLines({
			rows,
			selectedId: selected?.id,
			focusedId: this.deps.getFocusedId(),
			now: this.deps.now(),
			width,
			scrollTop: this.rosterScroll,
		});
		this.rosterScroll = list.scrollTop;
		const lines = list.lines;
		if (this.detailsOpen && selected) lines.push("", ...detailLines(selected, this.deps.now(), width));
		return lines;
	}

	private activityBody(width: number): string[] {
		const entries = this.activityEntries();
		if (entries.length === 0) {
			const empty =
				this.deps.getActivity().length === 0 ? " No activity yet." : " Nothing matches the current filters.";
			return [theme.fg("muted", empty)];
		}
		const selected = this.selectedEntry(entries);
		const list = activityRowLines({ entries, selectedSeq: selected?.seq, width, scrollTop: this.activityScroll });
		this.activityScroll = list.scrollTop;
		return list.lines;
	}

	private promptLines(width: number): string[] {
		const field = this.input.render(Math.max(1, width - 2)).map((line) => ` ${line}`);
		if (this.mode === "filter") {
			const title = ` ${theme.fg("accent", `Filter the ${this.view === "agents" ? "agent list" : "activity log"}`)} ${theme.fg("dim", `(${keyDisplayText("tui.select.confirm")} keep, ${keyDisplayText("tui.select.cancel")} clear)`)}`;
			return [truncateToWidth(title, width, "…"), ...field];
		}
		const target = this.selectedId ?? "";
		const title = ` ${theme.fg("accent", `Message to ${target}`)} ${theme.fg("dim", `(${keyDisplayText("tui.select.confirm")} send, ${keyDisplayText("tui.select.cancel")} cancel)`)}`;
		return [truncateToWidth(title, width, "…"), ...field];
	}

	/** Every control that works right now, labelled with its key. */
	private hints(): string[] {
		const key = (binding: Binding, label: string) => {
			const keys = keyDisplayText(binding);
			return keys ? `${theme.fg("accent", keys)} ${theme.fg("muted", label)}` : "";
		};
		if (this.mode === "message") return [];
		const move = [keyDisplayText("tui.select.up"), keyDisplayText("tui.select.down")].filter(Boolean).join("/");
		const select = move ? `${theme.fg("accent", move)} ${theme.fg("muted", "select")}` : "";
		if (this.mode === "filter")
			return [select, key("tui.select.confirm", "keep filter"), key("tui.select.cancel", "clear filter")].filter(
				Boolean,
			);

		const closeOrClear = key("tui.select.cancel", this.query ? "clear filter" : "close");
		if (this.view === "activity") {
			return [
				select,
				key("tui.select.confirm", "view that agent"),
				key("app.agents.kindFilter", `show: ${this.nextKind()}`),
				key("app.agents.scope", this.scopeId ? "all agents" : "this agent only"),
				key("app.agents.filter", "filter"),
				key("app.agents.activity", "agent list"),
				closeOrClear,
			].filter(Boolean);
		}
		const hasRows = this.rosterRows().length > 0;
		return [
			select,
			...(hasRows
				? [
						key("tui.select.confirm", "view & steer"),
						key("app.agents.message", "message"),
						key("app.agents.interrupt", "interrupt"),
						key("app.agents.kill", "kill"),
						key("app.agents.revive", "revive"),
						key("app.agents.details", "details"),
					]
				: []),
			key("app.agents.tree", this.layout === "tree" ? "flat list" : "tree"),
			key("app.agents.filter", "filter"),
			key("app.agents.activity", "activity log"),
			closeOrClear,
		].filter(Boolean);
	}

	// ---- data and selection -----------------------------------------------------------------------------------

	private get query(): string {
		return this.view === "agents" ? this.rosterQuery : this.activityQuery;
	}

	private setQuery(value: string): void {
		if (this.view === "agents") this.rosterQuery = value;
		else this.activityQuery = value;
		this.feedback = undefined;
	}

	private rosterRows(): RosterRow[] {
		return filterRoster(layoutRoster(this.deps.getRows(), this.layout), this.rosterQuery);
	}

	private activityEntries(): ActivityEntry[] {
		return filterActivity(this.deps.getActivity(), {
			kind: ACTIVITY_KIND_FILTERS[this.kindIndex]!,
			agentId: this.scopeId,
			query: this.activityQuery,
		});
	}

	private nextKind(): string {
		return ACTIVITY_KIND_FILTERS[(this.kindIndex + 1) % ACTIVITY_KIND_FILTERS.length]!;
	}

	private selectedRow(rows: readonly RosterRow[]): RosterRow | undefined {
		const current = rows.find((row) => row.id === this.selectedId);
		if (current) return current;
		this.selectedId = rows[0]?.id;
		return rows[0];
	}

	private selectedEntry(entries: readonly ActivityEntry[]): ActivityEntry | undefined {
		const last = entries.at(-1);
		if (!last) return undefined;
		if (this.following) {
			this.activitySeq = last.seq;
			return last;
		}
		const current = entries.find((entry) => entry.seq === this.activitySeq);
		if (current) return current;
		this.following = true;
		this.activitySeq = last.seq;
		return last;
	}

	private move(delta: -1 | 1): void {
		this.feedback = undefined;
		if (this.view === "agents") {
			const rows = this.rosterRows();
			if (rows.length === 0) return;
			const at = Math.max(
				0,
				rows.findIndex((row) => row.id === this.selectedId),
			);
			this.selectedId = rows[(at + delta + rows.length) % rows.length]?.id;
			return;
		}
		const entries = this.activityEntries();
		const current = this.selectedEntry(entries);
		if (!current) return;
		const at = entries.findIndex((entry) => entry.seq === current.seq);
		const next = entries[Math.min(entries.length - 1, Math.max(0, at + delta))]!;
		this.activitySeq = next.seq;
		// Moving off the newest entry pauses following; coming back to it resumes.
		this.following = next.seq === entries.at(-1)?.seq;
	}

	private switchView(): void {
		this.view = this.view === "agents" ? "activity" : "agents";
		this.feedback = undefined;
	}

	/** Limit the log to one agent: the one whose entry is selected, else the selected one in the list. */
	private toggleScope(): void {
		if (this.scopeId) {
			this.scopeId = undefined;
			return;
		}
		this.scopeId = this.selectedEntry(this.activityEntries())?.agentId ?? this.selectedId;
	}

	// ---- modes and actions ------------------------------------------------------------------------------------

	private enterFilterMode(): void {
		this.mode = "filter";
		this.input.setValue(this.query);
		this.input.focused = this._focused;
		this.feedback = undefined;
	}

	private enterMessageMode(): void {
		if (this.rosterRows().length === 0) return;
		this.mode = "message";
		this.input.setValue("");
		this.input.focused = this._focused;
		this.feedback = undefined;
	}

	private leaveInputMode(): void {
		this.mode = "list";
		this.input.focused = false;
		this.deps.requestRender();
	}

	private handleSubmit(value: string): void {
		if (this.mode === "filter") {
			this.leaveInputMode();
			return;
		}
		const target = this.selectedId;
		this.leaveInputMode();
		if (!target || !value.trim()) return;
		this.run(this.deps.actions.message(target, value.trim()));
	}

	private handleInputEscape(): void {
		if (this.mode === "filter") this.setQuery("");
		this.leaveInputMode();
	}

	/** Run an action on the agent selected in the roster. */
	private act(action: (id: string) => Promise<string>): void {
		const row = this.selectedRow(this.rosterRows());
		if (row) this.run(action(row.id));
	}

	private focusSelected(): void {
		const id =
			this.view === "agents"
				? this.selectedRow(this.rosterRows())?.id
				: this.selectedEntry(this.activityEntries())?.agentId;
		if (!id) return;
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
