import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { AgentMessageComponent } from "../../../src/modes/interactive/components/agent-message.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

const render = (component: AgentMessageComponent, width = 80) => component.render(width).map(stripAnsi);

describe("AgentMessageComponent", () => {
	it("labels a report with the agent it came from, and shows the body", () => {
		const out = render(new AgentMessageComponent({ kind: "result", from: "Scout", body: "found **the** flow" })).join(
			"\n",
		);
		expect(out).toContain("◀ report from Scout");
		expect(out).toContain("found the flow");
		expect(out).not.toContain("finished:");
	});

	it("labels a message differently from a report", () => {
		const out = render(new AgentMessageComponent({ kind: "message", from: "main", body: "look at auth" })).join("\n");
		expect(out).toContain("◀ message from main");
		expect(out).not.toContain("report from");
	});

	it("renders markdown in the body", () => {
		const out = render(new AgentMessageComponent({ kind: "result", from: "A", body: "- one\n- two\n\n`code`" })).join(
			"\n",
		);
		expect(out).toContain("one");
		expect(out).toContain("two");
		expect(out).toContain("code");
		expect(out).not.toContain("`code`");
	});

	it("shows a short report whole", () => {
		const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
		const out = render(new AgentMessageComponent({ kind: "result", from: "A", body })).join("\n");
		expect(out).toContain("line 12");
		expect(out).not.toContain("more line");
	});

	it("collapses a long report, says how much is hidden and how to expand it, and expands on request", () => {
		const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
		const component = new AgentMessageComponent({ kind: "result", from: "A", body });
		let out = render(component).join("\n");
		expect(out).toContain("line 12");
		expect(out).not.toContain("line 13");
		expect(out).toContain("… 18 more lines (ctrl+o to expand)");

		component.setExpanded(true);
		out = render(component).join("\n");
		expect(out).toContain("line 30");
		expect(out).not.toContain("more lines");

		component.setExpanded(false);
		expect(render(component).join("\n")).not.toContain("line 30");
	});

	it("says '1 more line' in the singular", () => {
		const body = Array.from({ length: 13 }, (_, i) => `line ${i + 1}`).join("\n");
		expect(render(new AgentMessageComponent({ kind: "result", from: "A", body })).join("\n")).toContain(
			"… 1 more line (",
		);
	});

	it("never exceeds the width", () => {
		const body = "word ".repeat(100);
		for (const width of [20, 40, 80]) {
			for (const line of new AgentMessageComponent({ kind: "result", from: "A".repeat(30), body }).render(width)) {
				expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
			}
		}
	});
});
