import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { getMessageText } from "../harness.ts";
import { bootAgentsRuntime } from "./agents-runtime.ts";

const ALT_A = "\x1ba";
const ALT_M = "\x1bm";
const ALT_NEXT = "\x1b.";
const ENTER = "\r";
const TAB = "\t";
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const ESC = "\x1b";

/**
 * The real InteractiveMode on a virtual terminal, driven with the real hotkeys: spawn an agent, open the hub,
 * view it, steer it, and come back.
 */
describe("agents in the interactive UI", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	beforeAll(() => initTheme("dark"));
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function start(options: { tokensPerSecond?: number } = {}) {
		const booted = await bootAgentsRuntime({ agentsEnabled: true, tokensPerSecond: options.tokensPerSecond });
		const terminal = new VirtualTerminal(130, 40);
		const mode = new InteractiveMode(booted.runtime, { terminal });
		cleanups.push(async () => {
			mode.stop("transcript");
			await booted.cleanup();
		});

		// One responder serves main and the child, chosen from the conversation (they share a provider queue).
		const respond = (context: { messages: Array<{ role: string; content: unknown }> }) => {
			const last = context.messages.at(-1);
			const lastText = last ? getMessageText(last) : "";
			const firstUser = getMessageText(context.messages.find((m) => m.role === "user") ?? { content: "" });
			if (firstUser.includes('You are agent "Scout"')) {
				if (lastText.includes("long:")) return fauxAssistantMessage(`alpha ${"word ".repeat(300)}omega`);
				return fauxAssistantMessage(lastText.includes("steer:") ? `scout obeys: ${lastText}` : "scout ready");
			}
			if (last?.role === "user" && lastText.includes('Agent "Scout" finished'))
				return fauxAssistantMessage("main noted scout");
			if (last?.role === "toolResult") return fauxAssistantMessage("main spawned it");
			if (lastText.includes("delegate")) {
				return fauxAssistantMessage(fauxToolCall("task", { tasks: [{ name: "Scout", task: "scout the repo" }] }), {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("main idle reply");
		};
		booted.faux.setResponses(Array.from({ length: 30 }, () => respond));

		void mode.run();
		const screen = async () => stripAnsi((await terminal.flushAndGetViewport()).join("\n"));
		const waitForScreen = (text: string) =>
			vi.waitFor(async () => expect(await screen()).toContain(text), { timeout: 8000 });
		const waitForNoScreen = (text: string) =>
			vi.waitFor(async () => expect(await screen()).not.toContain(text), { timeout: 8000 });
		const type = (text: string) => {
			for (const ch of text) terminal.sendInput(ch);
			terminal.sendInput(ENTER);
		};
		await waitForScreen("/ commands");
		return {
			terminal,
			booted,
			screen,
			waitForScreen,
			waitForNoScreen,
			type,
			press: (keys: string) => terminal.sendInput(keys),
		};
	}

	/** Start, then have the model spawn Scout and wait until its report reached main. */
	async function startWithScout(options: { tokensPerSecond?: number } = {}) {
		const ui = await start(options);
		ui.type("delegate to a scout");
		await ui.waitForScreen("main noted scout");
		return ui;
	}

	it("shows the agents line with the hotkeys once an agent exists", async () => {
		const { waitForScreen, screen } = await startWithScout();
		await waitForScreen("agents ○ Scout");
		const out = await screen();
		expect(out).toContain("Alt+A agent hub");
		expect(out).toContain("Alt+. next agent");
	});

	it("opens the hub with its hotkey, lists the agent and labels every control", async () => {
		const { press, waitForScreen, screen } = await startWithScout();
		press(ALT_A);
		await waitForScreen("Agent hub 1 agent,");
		const out = await screen();
		expect(out).toContain("Scout");
		expect(out).toContain("scout the repo");
		for (const label of ["Enter view & steer", "M message", "I interrupt", "X kill", "R revive", "D details"]) {
			expect(out).toContain(label);
		}
	});

	it("views the agent from the hub, steers it by typing, and returns to main", async () => {
		const { press, type, waitForScreen, waitForNoScreen, screen } = await startWithScout();

		press(ALT_A);
		await waitForScreen("Agent hub 1 agent,");
		press(ENTER);
		await waitForScreen("▶ viewing Scout");
		let out = await screen();
		expect(out).toContain("what you type steers this agent");
		expect(out).toContain("Alt+M back to main");
		expect(out).toContain("scout ready");
		expect(out).not.toContain("main noted scout");

		type("steer: go left");
		await waitForScreen("scout obeys");
		expect(await screen()).toContain("steer: go left");

		press(ALT_M);
		await waitForNoScreen("▶ viewing Scout");
		await waitForScreen("main noted scout");
		out = await screen();
		expect(out).toContain("agents ");
		// The child's own conversation is gone from the view; only its report reached main.
		expect(out).not.toContain('You are agent "Scout"');
		expect(out).toContain("report from Scout");
	});

	it("cycles the view with the next-agent hotkey, through main", async () => {
		const { press, waitForScreen, waitForNoScreen } = await startWithScout();
		press(ALT_NEXT);
		await waitForScreen("▶ viewing Scout");
		press(ALT_NEXT);
		await waitForNoScreen("▶ viewing Scout");
	});

	it("messages an agent from the hub without leaving the main view", async () => {
		const { press, type, waitForScreen, screen } = await startWithScout();
		press(ALT_A);
		await waitForScreen("Agent hub 1 agent,");
		press("m");
		await waitForScreen("Message to Scout");
		type("steer: from the hub");
		await waitForScreen("Delivered to Scout");
		expect(await screen()).not.toContain("▶ viewing");
	});

	it("catches up when an agent is viewed in the middle of a run, and keeps streaming", async () => {
		const { press, type, waitForScreen, screen } = await startWithScout({ tokensPerSecond: 90 });
		press(ALT_A);
		await waitForScreen("Agent hub 1 agent,");
		press("m");
		await waitForScreen("Message to Scout");
		type("long: write a lot");
		await waitForScreen("Delivered to Scout");
		press(ESC);
		await waitForScreen("● Scout");

		press(ALT_NEXT);
		await waitForScreen("▶ viewing Scout (running)");
		// Mid-run: the opening of the answer is already on screen, the end is not.
		await waitForScreen("alpha");
		expect(await screen()).not.toContain("omega");
		await waitForScreen("omega");
		await waitForScreen("▶ viewing Scout (idle)");
	});

	it("interrupts the viewed agent, not the main agent, with the interrupt key", async () => {
		const { press, type, waitForScreen, screen, booted } = await startWithScout({ tokensPerSecond: 90 });
		press(ALT_A);
		await waitForScreen("Agent hub 1 agent,");
		press("m");
		await waitForScreen("Message to Scout");
		type("long: write a lot");
		await waitForScreen("Delivered to Scout");
		press(ESC);
		await waitForScreen("● Scout");
		press(ALT_NEXT);
		await waitForScreen("▶ viewing Scout (running)");
		await waitForScreen("alpha");

		press(ESC);
		await waitForScreen("▶ viewing Scout (idle)");
		expect(await screen()).not.toContain("omega");
		// Still viewing the agent, and the main agent was never interrupted.
		expect(await screen()).toContain("▶ viewing Scout");
		expect(booted.runtime.session.isStreaming).toBe(false);
		expect(booted.runtime.session.messages.some((m) => m.role === "assistant" && m.stopReason === "aborted")).toBe(
			false,
		);
	});

	it("documents the agent keys in /hotkeys", async () => {
		const { type, waitForScreen, terminal } = await startWithScout();
		type("/hotkeys");
		await waitForScreen("Subcommands: focus");
		await vi.waitFor(() => {
			const all = stripAnsi(terminal.getScrollBuffer().join("\n"));
			// Each row of the rendered table: key cell, then its description.
			for (const [keys, action] of [
				["Alt+A", "Open the agent hub"],
				["Alt+. / Alt+,", "Switch the view to the next / previous agent"],
				["Alt+M", "Return the view to the main agent"],
				["Escape", "While viewing an agent: interrupt its current run"],
				["Tab", "In the hub: switch between the agent list and the activity log"],
				["T", "In the hub: show agents as a parent/child tree or a flat list"],
				["/", "In the hub: filter the list or the log by text"],
				["F / S", "In the activity log: cycle what is shown / limit it to one agent"],
				["/agents", "Same as the hub. Subcommands: focus, main, kill, revive, interrupt, msg"],
			]) {
				expect(all).toMatch(new RegExp(`${escapeRegExp(keys)}\\s*│\\s*${escapeRegExp(action)}`));
			}
		});
	});

	it("returns to main and drops the old agents when /new replaces the session, and agents still work afterwards", async () => {
		const { press, type, waitForScreen, waitForNoScreen, screen, booted } = await startWithScout();
		press(ALT_NEXT);
		await waitForScreen("▶ viewing Scout");

		type("/new");
		await waitForScreen("New session started");
		await waitForNoScreen("▶ viewing Scout");
		expect(await screen()).not.toContain("agents ○ Scout");
		expect(await screen()).not.toContain("agents ✕ Scout");

		// The replacement session has its own agents host, so spawning works again.
		type("delegate again");
		await waitForScreen("main noted scout");
		await waitForScreen("agents ○ Scout");
		expect(booted.runtime.session.sessionFile).toBeDefined();
	});

	it("draws a subagent's report apart from what the user typed", async () => {
		const { waitForScreen, screen } = await startWithScout();
		await waitForScreen("report from Scout");
		const out = await screen();
		expect(out).toContain("◀ report from Scout");
		expect(out).toContain("scout ready");
		// The envelope's own wording is replaced by the label.
		expect(out).not.toContain('Agent "Scout" finished:');
	});

	it("draws a message from main as a message when viewing the agent that received it", async () => {
		const { press, type, waitForScreen, screen } = await startWithScout();
		press(ALT_A);
		await waitForScreen("Agent hub 1 agent,");
		press("m");
		await waitForScreen("Message to Scout");
		type("steer: from the hub");
		await waitForScreen("Delivered to Scout");
		press(ESC);
		press(ALT_NEXT);
		await waitForScreen("▶ viewing Scout");
		await waitForScreen("◀ message from main");
		expect(await screen()).toContain("steer: from the hub");
	});

	it("shows what the agents did in the activity log, and filters it", async () => {
		const { press, type, waitForScreen, screen } = await startWithScout();
		press(ALT_A);
		await waitForScreen("Agent hub 1 agent,");
		press(TAB);
		await waitForScreen("[Activity");
		await waitForScreen("spawned by main (worker)");
		let out = await screen();
		expect(out).toMatch(/Scout\s+reply\s+scout ready/);
		expect(out).toMatch(/Scout\s+message\s+Scout → main report: scout ready/);
		expect(out).toMatch(/Scout\s+lifecycle\s+finished its run/);
		expect(out).toContain("Tab agent list");

		press("f");
		await waitForScreen("show errors");
		expect(await screen()).toContain("Nothing matches the current filters.");
		for (let i = 0; i < 5; i++) press("f");
		await waitForScreen("show all");

		press("/");
		await waitForScreen("Filter the activity log");
		type("report");
		await waitForScreen('filter "report"');
		out = await screen();
		expect(out).toContain("Scout → main report");
		expect(out).not.toContain("spawned by main");
	});

	it("flips the roster between tree and flat with the layout key", async () => {
		const { press, waitForScreen } = await startWithScout();
		press(ALT_A);
		await waitForScreen("T flat list");
		press("t");
		await waitForScreen("T tree");
		await waitForScreen("flat");
	});

	it("filters the roster from the hub", async () => {
		const { press, type, waitForScreen, waitForNoScreen } = await startWithScout();
		press(ALT_A);
		await waitForScreen("Agent hub 1 agent,");
		press("/");
		await waitForScreen("Filter the agent list");
		type("zzz");
		await waitForScreen('No agents match "zzz"');
		press(ESC);
		await waitForNoScreen('No agents match "zzz"');
	});

	it("flags a report that reaches main while another agent is on screen, and clears it on return", async () => {
		const { press, type, waitForScreen, waitForNoScreen, screen } = await startWithScout();
		press(ALT_NEXT);
		await waitForScreen("▶ viewing Scout");
		// Main is not on screen, so the report this message makes Scout send to main goes unseen.
		press(ALT_A);
		await waitForScreen("Agent hub 1 agent,");
		press("m");
		await waitForScreen("Message to Scout");
		type("steer: from the hub");
		await waitForScreen("Delivered to Scout");
		press(ESC);

		await waitForScreen("✉ 1 unread report for main (Scout)");
		press(ALT_A);
		await waitForScreen("✉1");
		press(ESC);

		press(ALT_M);
		await waitForNoScreen("unread report");
		await waitForNoScreen("✉");
		expect(await screen()).toContain("report from Scout");
	});

	it("does not flag a report that arrives while main is on screen", async () => {
		const { screen } = await startWithScout();
		expect(await screen()).not.toContain("✉");
	});

	it("kills an agent from the hub and shows it as killed", async () => {
		const { press, waitForScreen } = await startWithScout();
		press(ALT_A);
		await waitForScreen("Agent hub 1 agent,");
		press("x");
		await waitForScreen("Killed Scout");
		await waitForScreen("✕ Scout");
	});

	it("returns to main on its own when the viewed agent is killed", async () => {
		const { press, type, waitForScreen, waitForNoScreen } = await startWithScout();
		press(ALT_NEXT);
		await waitForScreen("▶ viewing Scout");
		type("/agents kill Scout");
		await waitForNoScreen("▶ viewing Scout");
		await waitForScreen("Killed Scout");
		await waitForScreen("✕ Scout");
	});

	it("explains how to enable agents when they are off", async () => {
		const booted = await bootAgentsRuntime({ agentsEnabled: false });
		const terminal = new VirtualTerminal(130, 40);
		const mode = new InteractiveMode(booted.runtime, { terminal });
		cleanups.push(async () => {
			mode.stop("transcript");
			await booted.cleanup();
		});
		void mode.run();
		await vi.waitFor(
			async () => expect(stripAnsi((await terminal.flushAndGetViewport()).join("\n"))).toContain("/ commands"),
			{ timeout: 8000 },
		);
		terminal.sendInput(ALT_A);
		await vi.waitFor(
			async () => {
				expect(stripAnsi((await terminal.flushAndGetViewport()).join("\n"))).toContain("Agents are not enabled");
			},
			{ timeout: 8000 },
		);
	});
});
