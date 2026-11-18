# Steerable Subagent Example

The [subagent example](../subagent/) rebuilt on `ctx.agents`: the same `subagent` tool (single, parallel, chain), but every subagent can be seen, steered and revived while the tool waits for it.

## Why

`../subagent` starts one `pi -p --no-session` process per task. Concrete failure: 40 seconds into a five-minute scout run you see it searching the wrong module. You can only press Esc, which stops the whole call and loses the scout's work.

Here each subagent is an in-process session owned by the agent layer. During that same run you can:

- see it in the agent hub (`Alt+A`) and on the agents line,
- view it (hub, `Enter`, or `/steer <id>`) and type "ignore the legacy module": the scout changes course, and the tool result is the corrected report,
- revive it after the call ends, or kill it and revive it later, with its history intact.

## How it works

- `ctx.agents.spawn()` starts each agent in the background; the agent layer bounds concurrency (`agents.maxConcurrency`).
- `ctx.agents.wait(id)` resolves when the agent's run ends. It takes the report, so the report comes back as the tool result and is not also sent to the main conversation as `Agent "<id>" finished:`.
- `ctx.agents.onChange()` streams each agent's tool calls into the tool card while it works.
- Esc on the main agent kills the agents the call still waits for. They are killed rather than released, so messaging one revives it.
- The result names each agent's id, so the model can ask a follow-up with `message_agent` (the report of that later run reaches main as a message, since nobody waits for it).

## Differences from `../subagent`

| | `../subagent` | this example |
|---|---|---|
| Runs as | `pi -p` child process | in-process `AgentSession` |
| Needs | nothing | `"agents": { "enabled": true }` |
| Steer, view, revive | no | yes |
| Per-task `cwd` | yes | no (agents run in the session's cwd) |
| Project agents | `agentScope` + confirmation | loaded only when the project is trusted |
| Extensions, skills, MCP in the child | yes | no (subagents run without them) |
| Per-task `model` | no | yes |

## Installation

Enable agents in `~/.pi/agent/settings.json`:

```json
{ "agents": { "enabled": true } }
```

Then link the extension, and the agent definitions of `../subagent` (same format, same directory):

```bash
mkdir -p ~/.pi/agent/extensions/steerable-subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/steerable-subagent/index.ts" ~/.pi/agent/extensions/steerable-subagent/index.ts

mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done
```

The workflow prompts in `../subagent/prompts/` work unchanged. Do not load both examples at once: both register a `subagent` tool.

## Usage

```
Use scout to find all authentication code
Run 2 scouts in parallel: one to find models, one to find providers
Use a chain: scout finds the read tool, then planner suggests improvements using {previous}
```

While it runs: `Alt+A`, select the agent, `Enter`, type. `Alt+M` returns to main. `/steer` lists the agents; `/steer <id>` views one.
