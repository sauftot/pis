import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterRow } from "../../../src/core/agents/index.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { type AgentHubActions, AgentHubComponent } from "../../../src/modes/interactive/agents/agent-hub.ts";
import { formatAgentsLine } from "../../../src/modes/interactive/agents/agents-line.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

const NOW = 1_000_000;
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

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

beforeAll(() => {
	initTheme("dark");
});
beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

function setup(initial: RosterRow[], options: { focusedId?: string } = {}) {
	let rows = initial;
	const calls: string[] = [];
	const renders = vi.fn();
	/** Record the call, then answer with the outcome line the real action would. */
	const recorded = (call: string, outcome: string) => {
		calls.push(call);
		return outcome;
	};
	const actions: AgentHubActions = {
		focus: vi.fn(async (id: string) => {
			calls.push(`focus ${id}`);
		}),
		message: vi.fn(async (id: string, text: string) => recorded(`message ${id} ${text}`, `Delivered to ${id}.`)),
		interrupt: vi.fn(async (id: string) => recorded(`interrupt ${id}`, `Interrupted ${id}.`)),
		kill: vi.fn(async (id: string) => recorded(`kill ${id}`, `Killed ${id}.`)),
		revive: vi.fn(async (id: string) => recorded(`revive ${id}`, `Revived ${id}.`)),
		close: vi.fn(() => {
			calls.push("close");
		}),
	};
	const hub = new AgentHubComponent({
		getRows: () => rows,
		getMainStatus: () => "idle",
		getFocusedId: () => options.focusedId,
		now: () => NOW,
		actions,
		requestRender: renders,
	});
	hub.focused = true;
	const text = (width = 100) => hub.render(width).map(stripAnsi).join("\n");
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	const setRows = (next: RosterRow[]) => {
		rows = next;
	};
	return { hub, calls, actions, text, settle, setRows };
}

describe("AgentHubComponent", () => {
	describe("rendering", () => {
		it("shows each agent with its status, type, age and what it is doing", () => {
			const { text } = setup([
				row("Scout", { status: "running", agent: "scout", activity: "grep", lastActivity: NOW - 3_000 }),
				row("Wren", { status: "parked", lastActivity: NOW - 7 * 60_000 }),
			]);
			const out = text();
			expect(out).toContain("Agents 2 total, 1 running");
			expect(out).toMatch(/● Scout\s+scout\s+running\s+now\s+grep/);
			expect(out).toMatch(/◌ Wren\s+worker\s+parked\s+7m\s+task of Wren/);
		});

		it("indents subagents under their parent", () => {
			const { text } = setup([row("A"), row("A1", { depth: 1, parentId: "A" })]);
			const lines = text().split("\n");
			const a = lines.find((l) => l.includes(" A "))!;
			const child = lines.find((l) => l.includes("A1"))!;
			expect(child.indexOf("A1")).toBeGreaterThan(a.indexOf("A") + 1);
		});

		it("says where the view is and the main agent's state", () => {
			expect(setup([row("A")]).text()).toContain("viewing main · main ○ idle");
			expect(setup([row("A")], { focusedId: "A" }).text()).toContain("viewing A");
			expect(setup([row("A")], { focusedId: "A" }).text()).toContain("◀ viewing");
		});

		it("explains how to get agents when there are none", () => {
			const out = setup([]).text();
			expect(out).toContain("No agents yet");
			expect(out).toContain("agents.enabled");
			expect(out).not.toContain("kill");
		});

		it("labels every control with its key", () => {
			const out = setup([row("A")]).text();
			for (const label of [
				"Up/Down select",
				"Enter view & steer",
				"M message",
				"I interrupt",
				"X kill",
				"R revive",
				"D details",
				"Escape/Ctrl+C close",
			]) {
				expect(out).toContain(label);
			}
		});

		it("shows remapped keys in the labels", () => {
			setKeybindings(new KeybindingsManager({ "app.agents.kill": "ctrl+k" }));
			const out = setup([row("A")]).text();
			expect(out).toContain("Ctrl+K kill");
			expect(out).not.toContain("X kill");
		});

		it("never exceeds the width, however narrow", () => {
			const { hub } = setup([row("A".repeat(30), { task: "word ".repeat(60), activity: "x".repeat(80) })]);
			for (const width of [20, 40, 80]) {
				for (const line of hub.render(width)) expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
			}
		});

		it("scrolls a long roster with the selection and reports what is hidden", () => {
			const { hub, text } = setup(Array.from({ length: 15 }, (_, i) => row(`Agent${String(i).padStart(2, "0")}`)));
			expect(text()).toContain("↓ 5 more");
			for (let i = 0; i < 12; i++) hub.handleInput(DOWN);
			const out = text();
			expect(out).toContain("Agent12");
			expect(out).toContain("↑ 3 more");
			expect(out).not.toContain("Agent00");
		});
	});

	describe("details", () => {
		it("toggles an inspector for the selected agent", () => {
			const { hub, text } = setup([
				row("Scout", { status: "running", activity: "read", task: "find the auth flow" }),
			]);
			expect(text()).not.toContain("transcript");
			hub.handleInput("d");
			const out = text();
			expect(out).toContain("find the auth flow");
			expect(out).toContain("doing");
			expect(out).toContain("read");
			expect(out).toContain("/s/Scout.jsonl");
			hub.handleInput("d");
			expect(text()).not.toContain("transcript");
		});

		it("says when a transcript is not saved", () => {
			const { hub, text } = setup([row("A", { sessionFile: null })]);
			hub.handleInput("d");
			expect(text()).toContain("not saved");
		});
	});

	describe("keys", () => {
		it("moves the selection and wraps around", async () => {
			const { hub, actions } = setup([row("A"), row("B"), row("C")]);
			hub.handleInput(UP);
			hub.handleInput(ENTER);
			expect(actions.focus).toHaveBeenLastCalledWith("C");
			hub.handleInput(DOWN);
			hub.handleInput(ENTER);
			expect(actions.focus).toHaveBeenLastCalledWith("A");
		});

		it("focuses the selected agent and closes the hub on success", async () => {
			const { hub, calls, settle } = setup([row("A"), row("B")]);
			hub.handleInput(DOWN);
			hub.handleInput(ENTER);
			await settle();
			expect(calls).toEqual(["focus B", "close"]);
		});

		it("keeps the hub open and shows the reason when focusing fails", async () => {
			const { hub, actions, calls, text, settle } = setup([row("A")]);
			vi.mocked(actions.focus).mockRejectedValueOnce(new Error("transcript corrupt"));
			hub.handleInput(ENTER);
			await settle();
			expect(calls).not.toContain("close");
			expect(text()).toContain("Cannot view A: transcript corrupt");
		});

		it.each([
			["i", "interrupt A", "Interrupted A."],
			["x", "kill A", "Killed A."],
			["r", "revive A", "Revived A."],
		])("%s acts on the selected agent and shows the outcome", async (key, call, outcome) => {
			const { hub, calls, text, settle } = setup([row("A")]);
			hub.handleInput(key);
			await settle();
			expect(calls).toEqual([call]);
			expect(text()).toContain(outcome);
		});

		it("shows an action's failure", async () => {
			const { hub, actions, text, settle } = setup([row("A")]);
			vi.mocked(actions.kill).mockRejectedValueOnce(new Error("nope"));
			hub.handleInput("x");
			await settle();
			expect(text()).toContain("nope");
		});

		it("closes on escape", () => {
			const { hub, calls } = setup([row("A")]);
			hub.handleInput(ESC);
			expect(calls).toEqual(["close"]);
		});

		it("ignores action keys when there are no agents", () => {
			const { hub, calls } = setup([]);
			for (const key of ["x", "r", "i", "m", ENTER]) hub.handleInput(key);
			expect(calls).toEqual([]);
		});

		it("keeps the selection on the same agent when the roster changes", () => {
			const { hub, setRows, actions } = setup([row("A"), row("B")]);
			hub.handleInput(DOWN);
			setRows([row("New"), row("A"), row("B")]);
			hub.handleInput(ENTER);
			expect(actions.focus).toHaveBeenLastCalledWith("B");
		});

		it("falls back to the first agent when the selected one disappears", () => {
			const { hub, setRows, actions } = setup([row("A"), row("B")]);
			hub.handleInput(DOWN);
			setRows([row("A")]);
			hub.handleInput(ENTER);
			expect(actions.focus).toHaveBeenLastCalledWith("A");
		});
	});

	describe("message mode", () => {
		it("sends typed text to the selected agent", async () => {
			const { hub, calls, text, settle } = setup([row("A"), row("B")]);
			hub.handleInput(DOWN);
			hub.handleInput("m");
			expect(text()).toContain("Message to B");
			for (const ch of "check tests") hub.handleInput(ch);
			hub.handleInput(ENTER);
			await settle();
			expect(calls).toEqual(["message B check tests"]);
			expect(text()).toContain("Delivered to B.");
			expect(text()).not.toContain("Message to B");
		});

		it("does not treat action letters as commands while typing", () => {
			const { hub, calls } = setup([row("A")]);
			hub.handleInput("m");
			for (const ch of "xkir") hub.handleInput(ch);
			expect(calls).toEqual([]);
		});

		it("cancels on escape without closing the hub or sending", () => {
			const { hub, calls, text } = setup([row("A")]);
			hub.handleInput("m");
			hub.handleInput("x");
			hub.handleInput(ESC);
			expect(calls).toEqual([]);
			expect(text()).not.toContain("Message to A");
		});

		it("sends nothing for blank text", () => {
			const { hub, calls } = setup([row("A")]);
			hub.handleInput("m");
			hub.handleInput(" ");
			hub.handleInput(ENTER);
			expect(calls).toEqual([]);
		});
	});
});

describe("formatAgentsLine", () => {
	const plain = (line: string | undefined) => (line === undefined ? undefined : stripAnsi(line));

	it("is absent when there are no agents and the main agent is shown", () => {
		expect(formatAgentsLine({ rows: [], focusedId: undefined, width: 100 })).toBeUndefined();
	});

	it("lists a few agents with their status and the keys that open and cycle them", () => {
		const line = plain(
			formatAgentsLine({
				rows: [row("Scout", { status: "running" }), row("Wren")],
				focusedId: undefined,
				width: 120,
			}),
		)!;
		expect(line).toContain("● Scout");
		expect(line).toContain("○ Wren");
		expect(line).toContain("Alt+A agent hub");
		expect(line).toContain("Alt+. next agent");
	});

	it("summarises a long roster by status", () => {
		const rows = [
			...Array.from({ length: 3 }, (_, i) => row(`R${i}`, { status: "running" })),
			row("I1"),
			row("P1", { status: "parked" }),
		];
		const line = plain(formatAgentsLine({ rows, focusedId: undefined, width: 120 }))!;
		expect(line).toContain("● 3 running");
		expect(line).toContain("○ 1 idle");
		expect(line).toContain("◌ 1 parked");
		expect(line).not.toContain("R0");
	});

	it("announces who is being steered and how to get back, even with no other agents", () => {
		const line = plain(
			formatAgentsLine({ rows: [row("Scout", { status: "running" })], focusedId: "Scout", width: 140 }),
		)!;
		expect(line).toContain("▶ viewing Scout (running)");
		expect(line).toContain("what you type steers this agent");
		expect(line).toContain("Alt+M back to main");
		expect(line).toContain("Alt+A agent hub");
		expect(line).toContain("Escape interrupt");
	});

	it("follows remapped keys and drops a hint whose key was unbound", () => {
		setKeybindings(new KeybindingsManager({ "app.agents.hub": "ctrl+h", "app.agents.next": [] }));
		const line = plain(formatAgentsLine({ rows: [row("A")], focusedId: undefined, width: 120 }))!;
		expect(line).toContain("Ctrl+H agent hub");
		expect(line).not.toContain("next agent");
	});

	it("fits the width", () => {
		const line = formatAgentsLine({ rows: [row("A".repeat(40))], focusedId: "A".repeat(40), width: 30 })!;
		expect(stripAnsi(line).length).toBeLessThanOrEqual(30);
	});
});
