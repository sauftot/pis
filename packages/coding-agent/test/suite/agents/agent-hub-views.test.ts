import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEntry, RosterRow } from "../../../src/core/agents/index.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { type AgentHubActions, AgentHubComponent } from "../../../src/modes/interactive/agents/agent-hub.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

const NOW = 1_000_000;
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";

const row = (id: string, patch: Partial<RosterRow> = {}): RosterRow => ({
	id,
	depth: 0,
	parentId: "main",
	status: "idle",
	agent: "worker",
	task: `task of ${id}`,
	activity: undefined,
	createdAt: NOW - 60_000,
	lastActivity: NOW - 30_000,
	sessionFile: `/s/${id}.jsonl`,
	...patch,
});

const entry = (seq: number, patch: Partial<ActivityEntry> = {}): ActivityEntry => ({
	seq,
	at: new Date(2026, 0, 1, 14, 3, seq).getTime(),
	agentId: "Scout",
	kind: "tool",
	text: `entry ${seq}`,
	...patch,
});

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

function setup(rows: RosterRow[], activity: ActivityEntry[] = []) {
	let currentActivity = activity;
	const calls: string[] = [];
	const actions: AgentHubActions = {
		focus: vi.fn(async (id: string) => {
			calls.push(`focus ${id}`);
		}),
		message: vi.fn(async () => "ok"),
		interrupt: vi.fn(async () => "ok"),
		kill: vi.fn(async () => "ok"),
		revive: vi.fn(async () => "ok"),
		close: vi.fn(() => {
			calls.push("close");
		}),
	};
	const hub = new AgentHubComponent({
		getRows: () => rows,
		getActivity: () => currentActivity,
		getMainStatus: () => "idle",
		getFocusedId: () => undefined,
		now: () => NOW,
		actions,
		requestRender: () => {},
	});
	hub.focused = true;
	const text = (width = 110) => hub.render(width).map(stripAnsi).join("\n");
	const type = (value: string) => {
		for (const ch of value) hub.handleInput(ch);
	};
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	const setActivity = (next: ActivityEntry[]) => {
		currentActivity = next;
	};
	return { hub, text, type, calls, actions, settle, setActivity };
}

describe("agent hub: layout and filter", () => {
	const roster = [
		row("Idle1", { lastActivity: NOW - 50_000 }),
		row("Busy", { status: "running", lastActivity: NOW - 5_000, task: "refactor the parser" }),
		row("Child", { depth: 1, parentId: "Idle1", task: "write the docs" }),
	];
	/** Ids in the order they are drawn. */
	const drawn = (out: string) =>
		["Idle1", "Busy", "Child"]
			.map((id) => [id, out.indexOf(id)] as const)
			.sort((a, b) => a[1] - b[1])
			.map(([id]) => id);

	it("shows a tree by default and flattens with the layout key, running agents first", () => {
		const { hub, text } = setup(roster);
		expect(text()).toContain("tree");
		expect(text()).toContain("T flat list");
		expect(drawn(text())[0]).toBe("Idle1");

		hub.handleInput("t");
		const out = text();
		expect(out).toContain("flat");
		expect(out).toContain("T tree");
		expect(drawn(out)[0]).toBe("Busy");
	});

	it("filters the list as you type, keeps the filter after Enter, and clears it on Escape", () => {
		const { hub, text, type } = setup(roster);
		hub.handleInput("/");
		expect(text()).toContain("Filter the agent list");
		type("parser");
		let out = text();
		expect(out).toContain("Busy");
		expect(out).not.toContain("Idle1");
		expect(out).toContain('filter "parser"');

		hub.handleInput(ENTER);
		expect(text()).toContain('filter "parser"');
		expect(text()).toContain("Escape/Ctrl+C clear filter");

		hub.handleInput(ESC);
		out = text();
		expect(out).not.toContain('filter "parser"');
		expect(out).toContain("Idle1");
		expect(out).toContain("Escape/Ctrl+C close");
	});

	it("clears a kept filter on Escape before it closes the hub", () => {
		const { hub, type, calls } = setup(roster);
		hub.handleInput("/");
		type("docs");
		hub.handleInput(ENTER);
		hub.handleInput(ESC);
		expect(calls).toEqual([]);
		hub.handleInput(ESC);
		expect(calls).toEqual(["close"]);
	});

	it("clears the filter on Escape in the filter prompt, without acting on anything", () => {
		const { hub, text, type, actions } = setup(roster);
		hub.handleInput("/");
		type("docs");
		expect(text()).toContain('filter "docs"');
		hub.handleInput(ESC);
		expect(text()).not.toContain('filter "docs"');
		expect(actions.focus).not.toHaveBeenCalled();
	});

	it("moves the selection while typing a filter", () => {
		const { hub, type, actions, settle } = setup(roster);
		hub.handleInput("/");
		type("e");
		hub.handleInput(DOWN);
		hub.handleInput(ENTER);
		hub.handleInput(ENTER);
		return settle().then(() => expect(actions.focus).toHaveBeenCalledTimes(1));
	});

	it("says when nothing matches, and acts on nothing", () => {
		const { hub, text, type, calls } = setup(roster);
		hub.handleInput("/");
		type("zzz");
		hub.handleInput(ENTER);
		expect(text()).toContain('No agents match "zzz"');
		for (const key of ["x", "r", "i", "m"]) hub.handleInput(key);
		expect(calls).toEqual([]);
	});

	it("acts on the agent selected in the flat layout, not on a tree position", async () => {
		const { hub, actions, settle } = setup(roster);
		hub.handleInput("t");
		hub.handleInput(ENTER);
		await settle();
		expect(actions.focus).toHaveBeenLastCalledWith("Busy");
	});

	it("remaps the new keys and shows the new labels", () => {
		setKeybindings(
			new KeybindingsManager({
				"app.agents.filter": "ctrl+f",
				"app.agents.tree": "ctrl+t",
				"app.agents.activity": "ctrl+a",
			}),
		);
		const { text } = setup(roster);
		const out = text();
		expect(out).toContain("Ctrl+F filter");
		expect(out).toContain("Ctrl+T flat list");
		expect(out).toContain("Ctrl+A activity log");
	});
});

describe("agent hub: activity log", () => {
	const log = [
		entry(1, { text: "spawned by main (worker)", kind: "lifecycle" }),
		entry(2, { text: "grep auth", kind: "tool" }),
		entry(3, { agentId: "Wren", text: "bash failed", kind: "error" }),
		entry(4, { text: "found the flow", kind: "response" }),
		entry(5, { agentId: "Wren", text: "main → Wren message: hi", kind: "message" }),
	];
	const open = () => {
		const ui = setup([row("Scout"), row("Wren")], log);
		ui.hub.handleInput(TAB);
		return ui;
	};

	it("switches to the log with the activity key, showing time, agent, kind and text", () => {
		const { text } = open();
		const out = text();
		expect(out).toContain("[Activity 5]");
		expect(out).toMatch(/14:03:02\s+Scout\s+tool\s+grep auth/);
		expect(out).toMatch(/14:03:03\s+Wren\s+error\s+bash failed/);
		expect(out).toMatch(/14:03:05\s+Wren\s+message\s+main → Wren message: hi/);
		expect(out).toContain("following");
		expect(out).toContain("Tab agent list");
	});

	it("goes back to the list with the same key", () => {
		const { hub, text } = open();
		hub.handleInput(TAB);
		expect(text()).toContain("[Agents]");
		expect(text()).toContain("Tab activity log");
	});

	it("cycles the kind filter and labels the next one", () => {
		const { hub, text } = open();
		expect(text()).toContain("F show: errors");
		hub.handleInput("f");
		let out = text();
		expect(out).toContain("show errors");
		expect(out).toContain("bash failed");
		expect(out).not.toContain("grep auth");
		hub.handleInput("f");
		out = text();
		expect(out).toContain("show responses");
		expect(out).toContain("found the flow");
		for (let i = 0; i < 4; i++) hub.handleInput("f");
		expect(text()).toContain("show all");
	});

	it("limits the log to the agent of the selected entry, and back", () => {
		const { hub, text } = open();
		// Up twice from the newest entry reaches Wren's error.
		hub.handleInput(UP);
		hub.handleInput(UP);
		hub.handleInput("s");
		let out = text();
		expect(out).toContain("agents: Wren");
		expect(out).toContain("bash failed");
		expect(out).not.toContain("grep auth");
		expect(out).toContain("S all agents");
		hub.handleInput("s");
		out = text();
		expect(out).toContain("agents: all");
		expect(out).toContain("grep auth");
	});

	it("filters the log by text, independently of the list's filter", () => {
		const { hub, text, type } = open();
		hub.handleInput("/");
		expect(text()).toContain("Filter the activity log");
		type("auth");
		hub.handleInput(ENTER);
		const out = text();
		expect(out).toContain("grep auth");
		expect(out).not.toContain("bash failed");
		hub.handleInput(TAB);
		expect(text()).not.toContain('filter "auth"');
	});

	it("follows the newest entry until you move up, pauses, and resumes at the bottom", () => {
		const { hub, text, setActivity } = open();
		hub.handleInput(UP);
		expect(text()).toContain("paused");
		setActivity([...log, entry(6, { text: "a newer entry" })]);
		expect(text()).toContain("a newer entry");
		expect(text()).toContain("paused");
		hub.handleInput(DOWN);
		hub.handleInput(DOWN);
		expect(text()).toContain("following");
	});

	it("scrolls a long log and reports what is hidden", () => {
		const many = Array.from({ length: 25 }, (_, i) => entry(i + 1, { text: `step ${i + 1}` }));
		const { hub, text } = setup([row("Scout")], many);
		hub.handleInput(TAB);
		let out = text();
		expect(out).toContain("step 25");
		expect(out).toContain("↑ 15 more");
		for (let i = 0; i < 24; i++) hub.handleInput(UP);
		out = text();
		expect(out).toContain("step 1");
		expect(out).toContain("↓ 15 more");
	});

	it("views the agent of the selected entry with Enter, the newest one by default", async () => {
		const { hub, calls, settle } = open();
		hub.handleInput(ENTER);
		await settle();
		expect(calls).toEqual(["focus Wren", "close"]);

		hub.handleInput(UP);
		hub.handleInput(ENTER);
		await settle();
		expect(calls.slice(2)).toEqual(["focus Scout", "close"]);
	});

	it("ignores the list's action keys while the log is shown", () => {
		const { hub, calls } = open();
		for (const key of ["x", "r", "i", "m", "d", "t"]) hub.handleInput(key);
		expect(calls).toEqual([]);
	});

	it("says when there is no activity, or nothing matches", () => {
		const empty = setup([row("Scout")]);
		empty.hub.handleInput(TAB);
		expect(empty.text()).toContain("No activity yet.");

		const { hub, text, type } = open();
		hub.handleInput("/");
		type("zzz");
		hub.handleInput(ENTER);
		expect(text()).toContain("Nothing matches the current filters.");
	});

	it("never exceeds the width", () => {
		const { hub } = open();
		for (const width of [20, 40, 80]) {
			for (const line of hub.render(width)) expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
		}
	});
});
