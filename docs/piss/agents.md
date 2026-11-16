# Agents in piss

piss lets the model delegate work to background subagents, and lets you watch, steer, interrupt and stop them from the chat, without leaving the session.

## Turn it on

In `~/.pi/agent/settings.json` (or a project's `.pi/settings.json`):

```json
{ "agents": { "enabled": true } }
```

| Setting | Default | Meaning |
|---|---|---|
| `agents.enabled` | `false` | Adds the `task` and `message_agent` tools and the agent controls |
| `agents.maxConcurrency` | `4` | Subagent runs at once; the rest wait for a slot |
| `agents.maxDepth` | `1` | How deep agents may spawn agents. `1`: only the main agent spawns |
| `agents.idleParkSeconds` | `300` | A finished agent is parked to disk after this long. `0` never parks |

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
| `Esc` | Close the hub |

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

Everything you type to an agent, and its replies, is saved in its own transcript under the session's `agents/` directory. A finished run's report is also sent to the agent that spawned it, even when you were the one who steered it.

## Agent types

`worker` is built in. Add your own as markdown files in `~/.pi/agent/agents/` (or `.pi/agents/` in a trusted project):

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

- One-shot modes (`-p`, JSON) exit when the main run ends, so background agents and their reports are lost there. Use the interactive UI or RPC mode.
- Aborting the main agent does not stop its subagents. Kill them, or close the session.
- Subagents run without extensions, skills and MCP tools.
- With `--no-session` agents live in memory only and are never parked, so they cannot be revived after a kill.
- Design and internals: [agent-hub-spec.md](./agent-hub-spec.md).
