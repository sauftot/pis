/**
 * Steerable Subagent - the subagent example rebuilt on ctx.agents
 *
 * Same tool and modes as ../subagent:
 *   - Single:   { agent: "scout", task: "..." }
 *   - Parallel: { tasks: [{ agent: "scout", task: "..." }, ...] }
 *   - Chain:    { chain: [{ agent: "scout", task: "..." }, { agent: "planner", task: "... {previous} ..." }] }
 *
 * The difference is where the subagents live. ../subagent starts a `pi -p --no-session` process per task, so a
 * subagent cannot be seen, redirected or resumed. Here each one is an in-process session owned by the agent layer
 * (`ctx.agents`), so while the tool waits for it, it is:
 *   - listed in the agent hub (Alt+A) and on the agents line,
 *   - steerable: view it from the hub (or `/steer <id>`) and type, or message it,
 *   - revivable after it finishes, from its saved transcript.
 *
 * The tool collects each report with `ctx.agents.wait()`, which hands it to the tool instead of also sending it to the
 * main conversation. Esc on the main agent kills the agents this call is still waiting for; they can be revived.
 *
 * Needs `"agents": { "enabled": true }` in settings. Agent definitions are the same markdown files as ../subagent's,
 * loaded by the agent layer from ~/.pi/agent/agents and, in trusted projects, .pi/agents.
 */

import {
	type AgentsApi,
	type ExtensionAPI,
	getMarkdownTheme,
	type RunOutcome,
	type Theme,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_PARALLEL_TASKS = 8;

/** One delegated task, as the tool tracks and renders it. */
interface Run {
	agent: string;
	task: string;
	model: string | undefined;
	/** Chain step, from 1. */
	step?: number;
	/** Set once the agent exists. */
	id?: string;
	state: "pending" | "running" | RunOutcome["status"];
	/** The report, or why there is none. */
	output: string;
	/** The newest thing the agent did, while it runs. */
	doing?: string;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	runs: Run[];
	isError: boolean;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description: "Task to delegate. In a chain, {previous} is replaced by the prior step's report",
	}),
	model: Type.Optional(Type.String({ description: "Model for this agent, e.g. a cheaper one for simple work" })),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	model: Type.Optional(Type.String({ description: "Model for the agent (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Tasks to run in parallel" })),
	chain: Type.Optional(Type.Array(TaskItem, { description: "Tasks to run one after another" })),
});

export default function (pi: ExtensionAPI) {
	// Tool results cannot set the error flag themselves, so set it through the result hook.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		if ((event.details as SubagentDetails | undefined)?.isError) return { isError: true };
	});

	pi.registerCommand("steer", {
		description: "View a subagent and steer it with what you type",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) {
				const ids = ctx.agents.list().map((agent) => `${agent.id} (${agent.status})`);
				ctx.ui.notify(ids.length > 0 ? `Agents: ${ids.join(", ")}` : "No agents yet.", "info");
				return;
			}
			await ctx.ui.focusAgent(id);
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context, and wait for their reports.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"The agents stay available afterwards: message one by its id to ask a follow-up.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agents = ctx.agents;
			const chain = params.chain ?? [];
			const tasks = params.tasks ?? [];
			const single =
				params.agent && params.task ? [{ agent: params.agent, task: params.task, model: params.model }] : [];
			const mode = chain.length > 0 ? "chain" : tasks.length > 0 ? "parallel" : "single";
			const fail = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { mode, runs: [], isError: true } satisfies SubagentDetails,
			});

			if (!agents.enabled) return fail('Subagents need "agents": { "enabled": true } in settings.');
			if ([chain, tasks, single].filter((items) => items.length > 0).length !== 1) {
				return fail("Invalid parameters. Provide exactly one of: agent + task, tasks, chain.");
			}
			if (tasks.length > MAX_PARALLEL_TASKS) {
				return fail(`Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);
			}

			const runs: Run[] = [...chain, ...tasks, ...single].map((item, index) => ({
				agent: item.agent,
				task: item.task,
				model: item.model,
				step: mode === "chain" ? index + 1 : undefined,
				state: "pending",
				output: "",
			}));
			const details = (): SubagentDetails => ({
				mode,
				runs: runs.map((run) => ({ ...run })),
				isError: runs.some((run) => run.state !== "finished"),
			});
			const emit = () => onUpdate?.({ content: [{ type: "text", text: progress(runs) }], details: details() });

			// Show what each agent is doing while the tool waits.
			const stopWatching = agents.onChange((event) => {
				if (event.type !== "activity" || (event.entry.kind !== "tool" && event.entry.kind !== "response")) return;
				const run = runs.find((candidate) => candidate.id === event.entry.agentId);
				if (!run || run.state !== "running") return;
				run.doing = event.entry.text;
				emit();
			});
			// Esc on the main agent: stop the agents still working. Killed, not released, so they can be revived.
			const stopRunning = () => {
				for (const run of runs) if (run.id && run.state === "running") void agents.kill(run.id);
			};
			signal?.addEventListener("abort", stopRunning, { once: true });

			try {
				if (mode === "chain") {
					let previous = "";
					for (const run of runs) {
						if (signal?.aborted) break;
						run.task = run.task.replace(/\{previous\}/g, previous);
						await runToEnd(agents, run, emit, signal);
						if (run.state !== "finished") break;
						previous = run.output;
					}
				} else {
					await Promise.all(runs.map((run) => runToEnd(agents, run, emit, signal)));
				}
			} finally {
				stopWatching();
				signal?.removeEventListener("abort", stopRunning);
			}
			// Later chain steps after a failed or aborted one.
			for (const run of runs) if (run.state === "pending") run.output = "Not started.";
			return { content: [{ type: "text", text: forModel(mode, runs) }], details: details() };
		},

		renderCall(args, theme) {
			const items = args.chain ?? args.tasks ?? (args.agent ? [{ agent: args.agent, task: args.task ?? "" }] : []);
			const mode = args.chain
				? `chain (${items.length} steps)`
				: args.tasks
					? `parallel (${items.length} tasks)`
					: "";
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", mode);
			for (const item of items.slice(0, 3)) {
				text += `\n  ${theme.fg("accent", item.agent)} ${theme.fg("dim", preview(item.task.replace(/\{previous\}/g, ""), 50))}`;
			}
			if (items.length > 3) text += `\n  ${theme.fg("muted", `... +${items.length - 3} more`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.runs.length === 0) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}
			const container = new Container();
			details.runs.forEach((run, index) => {
				if (index > 0) container.addChild(new Spacer(1));
				container.addChild(new Text(runHeader(run, theme), 0, 0));
				if (run.state === "running" && run.doing) {
					container.addChild(new Text(theme.fg("muted", `  → ${preview(run.doing, 80)}`), 0, 0));
				} else if (run.output && expanded) {
					container.addChild(new Markdown(run.output.trim(), 0, 0, getMarkdownTheme()));
				} else if (run.output) {
					const lines = run.output.trim().split("\n");
					container.addChild(new Text(theme.fg("toolOutput", lines.slice(0, 3).join("\n")), 0, 0));
					if (lines.length > 3)
						container.addChild(new Text(theme.fg("muted", "(expand for the full report)"), 0, 0));
				}
			});
			if (details.runs.some((run) => run.state === "running")) {
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(theme.fg("dim", "Open the agent hub to view and steer a running agent."), 0, 0),
				);
			}
			return container;
		},
	});
}

/** Spawn the run's agent and wait for its run to end. Never throws: a refused spawn is a failed run. */
async function runToEnd(agents: AgentsApi, run: Run, emit: () => void, signal: AbortSignal | undefined): Promise<void> {
	run.state = "running";
	try {
		const spawned = await agents.spawn({ name: run.agent, agent: run.agent, task: run.task, model: run.model });
		run.id = spawned.id;
		// Aborted while the spawn was in flight, so the abort handler did not know this agent yet.
		if (signal?.aborted) void agents.kill(spawned.id);
		emit();
		const outcome = await agents.wait(spawned.id);
		run.state = outcome.status;
		run.output = outcomeText(outcome);
	} catch (error) {
		run.state = "failed";
		run.output = error instanceof Error ? error.message : String(error);
	}
	run.doing = undefined;
	emit();
}

function outcomeText(outcome: RunOutcome): string {
	switch (outcome.status) {
		case "finished":
			return outcome.report;
		case "failed":
			return outcome.error;
		case "interrupted":
			return "Its run was interrupted. It keeps its context and can be messaged.";
		case "killed":
			return "It was killed. Messaging it revives it with its history.";
		case "released":
			return "The session ended before it finished.";
	}
}

/** The tool result the model reads. Agent ids are included so it can message an agent afterwards. */
function forModel(mode: SubagentDetails["mode"], runs: Run[]): string {
	const section = (run: Run) =>
		`### ${run.id ?? run.agent} (${run.agent}): ${run.state}\n\n${run.output || "(no output)"}`;
	if (mode === "single") return truncate(section(runs[0]!));
	if (mode === "chain") {
		const stopped = runs.find((run) => run.state !== "finished");
		if (!stopped) return truncate(section(runs.at(-1)!));
		return truncate(`Chain stopped at step ${stopped.step} (${stopped.agent}).\n\n${section(stopped)}`);
	}
	const finished = runs.filter((run) => run.state === "finished").length;
	return truncate(`Parallel: ${finished}/${runs.length} finished\n\n${runs.map(section).join("\n\n---\n\n")}`);
}

function truncate(text: string): string {
	const result = truncateHead(text);
	if (!result.truncated) return text;
	return `${result.content}\n\n[Output truncated: ${result.totalBytes - result.outputBytes} bytes omitted.]`;
}

function progress(runs: Run[]): string {
	const done = runs.filter((run) => run.state !== "pending" && run.state !== "running").length;
	return `${done}/${runs.length} done`;
}

function runHeader(run: Run, theme: Theme): string {
	const icon =
		run.state === "finished"
			? theme.fg("success", "✓")
			: run.state === "pending" || run.state === "running"
				? theme.fg("warning", "⏳")
				: theme.fg("error", "✗");
	const step = run.step ? theme.fg("muted", `${run.step}. `) : "";
	const name = theme.fg("toolTitle", theme.bold(run.id ?? run.agent));
	const type = run.id && run.id !== run.agent ? theme.fg("muted", ` (${run.agent})`) : "";
	const state =
		run.state === "finished" ? "" : ` ${theme.fg(run.state === "running" ? "warning" : "error", `[${run.state}]`)}`;
	return `${icon} ${step}${name}${type}${state}`;
}

function preview(text: string, width: number): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > width ? `${line.slice(0, width)}...` : line;
}
