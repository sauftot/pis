# Agents in pis

pis lets the model delegate work to background subagents, and lets you watch, steer, interrupt and stop them from the chat, without leaving the session.

## Turn it on

In `~/.pis/agent/settings.json` (or a project's `.pis/settings.json`; pi's `.pi` files are read too, see [config](./config.md)):

```json
{ "agents": { "enabled": true } }
```

| Setting | Default | Meaning |
|---|---|---|
| `agents.enabled` | `false` | Adds the `task` and `message_agent` tools and the agent controls |
| `agents.maxConcurrency` | `4` | Subagent runs at once; the rest wait for a slot |
| `agents.maxDepth` | `1` | How deep agents may spawn agents. `1`: only the main agent spawns |
| `agents.idleParkSeconds` | `300` | A finished agent is parked to disk after this long. `0` never parks |
| `agents.allowedModels` | unset | Models the model may choose for a subagent (patterns such as `haiku`). Unset allows any authenticated model; `[]` allows none |

Or use `/settings` → Subagents, which changes all but `allowedModels` in the global settings. Concurrency, depth and park time apply at once. Turning agents on or off takes effect for the next session (`/new`, `/resume` or a restart).

## Hotkeys

Every key is rebindable in `keybindings.json`; the labels on screen follow your bindings. `/hotkeys` lists them all.

| Key | Action |
|---|---|
| `Alt+A` | Open the **agent hub**: every agent, its status, what it is doing |
| `Alt+.` / `Alt+,` | Switch the view to the **next / previous** agent. The main agent is one stop in the cycle |
| `Alt+M` | Return the view to the **main agent** |
| `Esc` | While viewing an agent: **interrupt that agent's current run** (never the main agent's) |

Inside the hub:

| Key | Action |
|---|---|
| `Up` / `Down` | Select an agent |
| `Enter` | **View and steer** the selected agent |
| `M` | **Message** the selected agent without leaving your view |
| `I` | **Interrupt** its current run. It keeps its context |
| `X` | **Kill** it. It can be revived |
| `R` | **Revive** a parked or killed agent from its transcript |
| `D` | Show or hide **details**: task, current tool, parent, start time, transcript path |
| `T` | Show agents as a **tree** (parents and their children) or a **flat** list with running agents first |
| `/` | **Filter** the list or the log by text. `Enter` keeps the filter, `Esc` clears it |
| `Tab` | Switch between the **agent list** and the **activity log** |
| `Esc` | Clear the filter if one is set, otherwise close the hub |

In the activity log:

| Key | Action |
|---|---|
| `Up` / `Down` | Move through the log. Moving up pauses following; reaching the newest entry resumes it |
| `Enter` | **View that agent** |
| `F` | Cycle what is shown: all, errors, replies, tools, messages, lifecycle |
| `S` | Show every agent, or only the agent of the selected entry |
| `/` | Filter by text (matches the agent and the entry) |

## What you see

Once an agent exists, a line above the footer shows who is running and the keys to reach them:

```
agents ● Scout  ○ Wren  │  Alt+A agent hub  Alt+. next agent
```

Status glyphs: `●` running, `○` idle, `◌` parked (saved to disk, loads again when needed), `✕` killed.

While you view an agent, the editor border changes colour and the line becomes a reminder of who you are talking to:

```
▶ viewing Scout (running) — what you type steers this agent  │  Alt+M back to main  Alt+A agent hub  Escape interrupt
```

A report that reaches the main conversation while you view a subagent is unread until you go back to main. The line then says `✉ 1 unread report for main (Wren)` instead of the reminder, and the agent's hub row shows `✉1`.

## The activity log

Press `Tab` in the hub. It lists, newest last, what the agents did:

```
14:03:01 Scout  lifecycle  spawned by main (worker, model haiku): find the auth flow
14:03:04 Scout  tool       grep auth
14:03:09 Scout  reply      found the validation in src/auth/token.ts
14:03:09 Scout  lifecycle  finished its run
14:03:09 Scout  message    Scout → main report: found the validation in src/auth/token.ts
14:03:20 Scout  error      bash failed
```

It is the quickest way to see which agent is stuck or failing without opening each transcript. The log holds the last 500 entries of the session and is not saved across a restart; the agents' transcripts are.

## Reports and messages in the chat

A subagent's report, and a message sent by another agent, are drawn apart from what you typed:

```
◀ report from Scout
  found the validation in src/auth/token.ts ...
```

Long reports collapse after 12 lines; `Ctrl+O` expands them, like tool output. They are still ordinary user messages in the transcript, so the model sees the same text as before.

## A typical session

1. Ask: "Use scouts to look at the auth flow and the billing flow in parallel."
2. The model calls `task`. Two agents start. The agents line appears.
3. `Alt+A` to see both. One is heading the wrong way: select it, press `Enter`, and type "ignore the legacy module, look only at `src/auth`". It picks the message up at its next step.
4. `Alt+M` to go back. When each agent finishes, its report arrives in the main conversation as `Agent "<id>" finished:` and the main agent continues.

Messaging from the hub (`M`) is the quick way to nudge an agent when you do not need to read its transcript.

## Commands

`/agents` opens the hub. Subcommands work without it:

```
/agents focus <id>        view and steer an agent
/agents main              back to the main agent
/agents msg <id> <text>   send a message
/agents interrupt <id>    stop its current run
/agents kill <id>         kill it
/agents revive <id>       bring it back
```

`/new`, `/resume`, `/fork`, `/clone`, `/import` and `/reload` act on the main session, so they return the view to it first.

## What a message does

| Recipient is | Result |
|---|---|
| running | Delivered at its next step, like steering any agent |
| idle | It starts working on it |
| parked or killed | Revived from its transcript with full history, then delivered |

Everything you type to an agent, and its replies, is saved in its own transcript under the session's `agents/` directory. A finished run's report is also sent to the agent that spawned it, even when you were the one who steered it. The one exception: when a tool waits for the agent (an extension using `ctx.agents.wait`), the report becomes that tool's result instead, so it is not delivered twice.

## Choosing the subagent's model

The `task` tool takes an optional `model` for each agent, so a stronger main model can hand cheap work to a faster one:

```
task({ tasks: [{ name: "Scout", task: "find where auth tokens are validated", model: "haiku" }] })
```

The model accepts what `--model` accepts: `haiku`, `anthropic/claude-haiku-4-5`, or `haiku:low` for a thinking level. The tool description tells the model it can do this, so ask in plain words: "use haiku scouts for the search."

Which model an agent runs on, in order: the call's `model`, then its agent type's `model:` (below), then the main agent's model.

An agent that cannot get its model fails to spawn rather than quietly running on a different one, because that would change what the work costs. The error names the models that would work, so the main model can retry. It fails when the model is unknown, its provider has no credentials, or it is outside `agents.allowedModels`. To limit what the model can pick:

```json
{ "agents": { "allowedModels": ["haiku", "sonnet"] } }
```

When set, the tool description lists exactly those models. An agent keeps its model when it is parked and revived, including after a restart.

## Agent types

`worker` is built in and uses the model rules above. Add your own as markdown files in `~/.pis/agent/agents/` (or `.pis/agents/` in a trusted project). pi's `~/.pi/agent/agents/` and `.pi/agents/` are read too; pis's file wins on a name clash:

```markdown
---
name: scout
description: Fast recon, returns compressed findings
tools: read, grep, find, ls
model: claude-haiku-4-5
---

You are a scout. Investigate quickly and report findings another agent can use.
```

## Limits

- One-shot modes (`-p`, JSON) wait, after each prompt, until every agent it started has finished and the main agent has answered their reports, then print that answer. A subagent that never finishes keeps the process running; stop it with Ctrl+C.
- Aborting the main agent does not stop its subagents. Kill them, or close the session.
- Extensions reach agents through `ctx.agents`, RPC clients through the `agent_*` commands, and SDK code through `getAgentsApi(session)`; see the extension, RPC and SDK docs. [`examples/extensions/steerable-subagent`](../../packages/coding-agent/examples/extensions/steerable-subagent/) is a `subagent` tool built on it.
- Subagents run without extensions, skills and MCP tools.
- With `--no-session` agents live in memory only and are never parked, so they cannot be revived after a kill.
- The activity log is in memory only.
- Design and internals: [agent-hub-spec.md](./agent-hub-spec.md).
