// Draws a message from another agent, or a finished subagent's report, apart from what the user typed.

import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { ParsedEnvelope } from "../../../core/agents/index.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

/** Body lines shown before a long report is collapsed. */
const COLLAPSED_LINES = 12;

export class AgentMessageComponent extends Container {
	private readonly envelope: ParsedEnvelope;
	private readonly markdownTheme: MarkdownTheme;
	private outputPad: number;
	private expanded = false;

	constructor(envelope: ParsedEnvelope, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		super();
		this.envelope = envelope;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.rebuild();
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const { kind, from, body } = this.envelope;
		const box = new Box(this.outputPad, 1, (text) => theme.bg("customMessageBg", text));
		const arrow = theme.fg("customMessageLabel", "◀");
		const label =
			kind === "result"
				? `${arrow} ${theme.bold(theme.fg("customMessageLabel", `report from ${from}`))}`
				: `${arrow} ${theme.bold(theme.fg("customMessageLabel", `message from ${from}`))}`;
		box.addChild(new Text(label, 0, 0));
		box.addChild(new Spacer(1));

		const lines = body.split("\n");
		const hidden = this.expanded ? 0 : Math.max(0, lines.length - COLLAPSED_LINES);
		const shown = hidden > 0 ? lines.slice(0, COLLAPSED_LINES).join("\n") : body;
		box.addChild(
			new Markdown(shown, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
		if (hidden > 0) {
			const more = `… ${hidden} more ${hidden === 1 ? "line" : "lines"} (${keyHint("app.tools.expand", "to expand")})`;
			box.addChild(new Text(theme.fg("dim", more), 0, 0));
		}
		this.addChild(box);
	}
}
