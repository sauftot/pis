# piss: Agent Hub and in-chat agent steering (spec, draft 1)

piss is a fork of pi (`earendil-works/pi`, coding-agent 1.5.x). Goal: manage subagents from inside the chat the way omp (`can1357/oh-my-pi`) does: see them, read them, steer them, kill and revive them, without leaving the session.

Status: phases 1, 2 and 3 implemented (core in `packages/coding-agent/src/core/agents/`, UI in `src/modes/interactive/agents/`; 252 tests in `test/suite/agents/`, including the real InteractiveMode driven on a virtual terminal). Enable with `agents.enabled`. User guide: [agents.md](./agents.md). Phase 4 (activity log, tree/flat, filter, report renderer) is done; phases 5-6 not started.

## 1. Problem

Today a pi user who delegates work (the `examples/extensions/subagent` extension) gets this:

- Each subagent is a child `pi --mode json -p --no-session` process (`examples/extensions/subagent/index.ts:389`).
- The parent sees a streamed tool card, then a final result. Nothing between.
- The child cannot be messaged, redirected, inspected after it ends, or resumed. Its session is not persisted (`--no-session`).
- There is no roster of what is running.

Concrete failure: the user sees a subagent heading down the wrong path 40 seconds into a 5 minute job. Their only option is Ctrl+C, which kills the whole parent run and loses the child's work.

## 2. What gives omp its agent steering (research findings)

omp's steering is not one feature. It is five layers. Each is needed; the layers below the UI are what make the UI possible.

| # | Layer | omp source (`packages/coding-agent/src` unless noted) | What it does |
|---|-------|--------------------------------------------------|--------------|
| 1 | Agent registry | `registry/agent-registry.ts` | Process-global directory of every agent (main + subagents) by stable id. Status `running / idle / parked / aborted`. Holds a live `AgentSession` handle when alive, and `sessionFile` for revival. Emits `registered / status_changed / metadata_changed / removed`. |
| 2 | Lifecycle manager | `registry/agent-lifecycle.ts` | Finished subagents stay `idle` (session live), are `park`ed after an idle TTL (session disposed, transcript on disk), and `ensureLive(id)` revives a parked or killed agent from its JSONL transcript. This is why steering works on a "finished" agent. |
| 3 | Addressable messaging | `irc/bus.ts`, `irc/messaging.ts`, `session/irc-bridge.ts`, `internal-urls/agent-protocol.ts` | `IrcBus.send({from,to,body})` resolves the target, revives if needed, calls `session.deliverIrcMessage`. The session picks the delivery mode from its own state: streaming then non-interrupting aside at the next step boundary; idle then a wake turn. Models reach it via `write agent://<id>`; `agent://all` broadcasts (main agent only). Receipts: `injected / revived / failed`. |
| 4 | In-process child sessions | `task/executor.ts` (`createAgentSession`), `thread/*` (optional worker threads) | Subagents are real `AgentSession` objects in the same process (or mirrored from workers), not opaque subprocesses. That makes live transcript subscription and `prompt()/steer()` direct calls. |
| 5 | Focus + Hub UI | `modes/controllers/session-focus-controller.ts`, `modes/agent-hub-runtime.ts`, `packages/tui/src/overlays/agent-hub*.ts`, `docs/agent-hub.md` | `SessionFocusController.focusAgent(id)` re-points the existing transcript view, event subscription, status line and editor at a subagent's session; the main session is untouched underneath. Typing then calls the normal prompt path: steer if running, prompt if idle, revive if parked. Hub overlay (Alt+A) shows the roster, inspector, activity log, revive/kill. Pinned "Subagents" jump list above the editor; click to focus. |

Supporting pieces: `task/*` (the `task` tool, spawn policy, concurrency semaphore, output manager that allocates `agent://` ids), `async/job-manager.ts` (background jobs, result delivery back to the parent), `registry/persisted-agents.ts` (rebuild roster from artifact JSONLs on resume), `/jobs` and `history://<id>`.

Key insight: steering is "talk to a live `AgentSession` by id, and let the session decide steer vs prompt vs revive". Everything in the UI is a view over (1) and (2) plus a call into (3).

## 3. What pi already has (do not rebuild)

- `AgentSession.steer()`, `followUp()`, `prompt({streamingBehavior})`, `sendUserMessage({deliverAs})`, `abort()`, `clearQueue()`, and a `queue_update` event (`core/agent-session.ts` ~2128-2600). Equivalent to omp's low-level delivery.
- `createAgentSession` / `AgentSessionRuntime` in the SDK (`core/sdk.ts`, `core/agent-session-runtime.ts`), with `setRebindSession` hook, so the interactive mode already knows how to re-point itself at a different session (`interactive-mode.ts:645`, `renderInitialMessages`, `rebuildChatFromMessages`).
- Rich session event stream (`AgentSessionEvent`) and persisted JSONL sessions with `SessionManager`.
- Extension API: `registerTool`, `registerCommand`, `registerShortcut`, `setWidget`, `custom({overlay})`, `registerMessageRenderer`, `sendMessage`.
- RPC mode with `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `get_messages`, `switch_session` (`docs/rpc-commands.md`).

## 4. Gaps (what piss adds)

1. No registry: nothing knows which subagents exist, their status, or their parent.
2. Subagents are subprocesses with `--no-session`: no persistence, no steering channel, no revive.
3. No addressing: the model and user cannot say "tell agent X ...".
4. No focus: the chat view is hard-bound to one session.
5. No roster UI, no activity log, no kill/revive.
6. No parent/child lineage or per-agent usage metrics.

## 5. Design decisions

### D1. In-process child sessions, not subprocess RPC (v1)

Options:

- A. In-process `AgentSession` via `createAgentSession` (omp's model).
- B. Keep child processes, control them over RPC (`steer`, `follow_up`, `get_messages`).

Choose A for v1. Why: focus needs live event subscription and transcript rebuild from a session object; the TUI already does exactly that for the main session. With B every view needs an RPC mirror, and crash/kill semantics get harder. B stays the right answer for isolation (separate cwd/worktree, untrusted agents), so keep a `AgentSessionHandle` interface (see 6.1) that an `RpcAgentSession` can implement later.

Cost: a child crash is an in-process error, so wrap every child run in its own try/catch and abort controller, and never let a child exception reach the main loop. Skip omp's worker-thread pool (`thread/*`, ~5k lines); it is a performance optimization, not required for steering.

### D2. Core lives in `packages/coding-agent/src`, not in an extension

The registry, focus controller and the interactive mode's session binding need core access (`InteractiveMode` internals). Extensions get the surface via a new `ctx.agents` API (6.5) so the example subagent extension and third parties can use it. The `task` tool ships built in, off by default behind a setting.

### D3. Steering semantics copy omp exactly

For `message to agent X`:

| X state | Action | Receipt |
|---------|--------|---------|
| running | `session.steer(text)` (interrupts at next step boundary, same as user steering today) or aside if `interrupt: false` | `injected` |
| idle | `session.prompt(text)` | `injected` |
| parked / aborted | `ensureLive(X)` then prompt | `revived` |
| not found / released | error | `failed` |

Messages and replies are written to the child's persisted session, so the transcript is the source of truth.

### D4. Reuse omp's vocabulary and ids

`running | idle | parked | aborted`, `main | sub | advisor` kinds (advisor deferred), AdjectiveNoun default ids, ids unique per session. Keeps docs and muscle memory transferable. License: omp and pi are both MIT (omp adds Can Bölük and Stencil Labs copyright lines). Verbatim reuse is allowed if the omp copyright notice is added to piss's LICENSE and kept on copied files. Still prefer reimplementing against pi's APIs: omp's code assumes its own `AgentSession`, settings and tui packages.

## 6. Spec

### 6.1 Agent registry (`core/agents/agent-registry.ts`)

```ts
type AgentStatus = "running" | "idle" | "parked" | "aborted";
interface AgentRef {
  id: string; displayName: string; kind: "main" | "sub";
  parentId?: string; status: AgentStatus;
  session: AgentSession | null;     // null iff parked/aborted
  sessionFile: string | null;
  createdAt: number; lastActivity: number;
  activity?: string;                // current tool/intent gist
  usage?: { cost: number; tokens: number; requests: number; toolCalls: number };
}
interface AgentRegistry {
  register(input): AgentRef; unregister(id): void;
  get(id); list(); listVisibleTo(id);
  setStatus(id, status); setActivity(id, text);
  attachSession(id, s); detachSession(id);
  onChange(listener): () => void;  // registered|status_changed|metadata_changed|removed
}
```

- One registry per process, owned by the `AgentSessionRuntime` services (not a hidden global) so SDK users with several roots stay isolated. Main session registers as `main`.
- `syncSessionStatus(id, session)` subscribes to `agent_start` / `agent_settled` events to set `running` / `idle` and to `tool_execution_*` for `activity`.
- Generation counter on each ref so stale async completions (late revive, late park) cannot clobber a newer ref. (omp relies on this heavily: `expected` argument on every mutator.)

### 6.2 Lifecycle manager (`core/agents/agent-lifecycle.ts`)

- `adopt(id, { idleTtlMs, reviver })`: take ownership of a finished child.
- Idle TTL (setting `agents.idleParkSeconds`, default 300, 0 disables): `park(id)` aborts nothing, disposes the session, sets `parked`, keeps `sessionFile`.
- `ensureLive(id)`: idle then return; parked or aborted then reopen the JSONL via `SessionManager.open`, `createAgentSession`, `attachSession`, status `idle`. Concurrent calls for one id coalesce on a single in-flight promise.
- `release(id)`: abort if running, dispose, unregister. Killed (`x` in Hub) is `aborted` with a tombstone so it does not auto-resume until explicitly revived or messaged.
- On process exit: `dispose()` with a grace deadline.

### 6.3 Messaging (`core/agents/agent-bus.ts`)

`send({ from, to, body, interrupt?, broadcast? }) -> Receipt { to, outcome: injected|revived|failed, error? }`.

- Resolve target, `ensureLive` if needed, call the free function `deliverAgentMessage(session, envelope)` (no new method on `AgentSession`, to keep upstream rebases cheap).
- `deliverAgentMessage` makes one `session.prompt(text, { source: "extension", expandPromptTemplates: false, streamingBehavior, preflightResult })` call. `streamingBehavior` is `steer`, or `followUp` when `interrupt:false`; `prompt` itself starts a run when idle and queues when streaming, so there is no isStreaming race. `preflightResult` resolves the receipt as soon as the session accepts the message, so the sender never waits for the run. `expandPromptTemplates:false` stops an agent-authored body from running as an extension command or template. Sender attribution is a text prefix (`Message from agent "<id>":`); a custom message type with a renderer is deferred to the focus phase.
- `to: "all"` only from `main`; fans out to `listVisibleTo(sender)`.
- Never block on the recipient's reply. Replies are the recipient's normal output; for model-to-model use the recipient replies by sending to the sender id.
- Model-facing surface: tool `message_agent({ to, message, interrupt? })`, plus `read`/`write` support for `agent://<id>` later (phase 5). Start with an explicit tool; URL schemes are an omp-specific indirection pi does not need.

### 6.4 `task` tool (`core/tools/task.ts`)

Minimal v1 (omp's full surface is ~18k lines; most of it is out of scope):

- Params: `{ tasks: [{ name?, agent?, task, model? }], context? }`.
- Each spawn: allocate id, `createAgentSession` with the agent definition (reuse `examples/extensions/subagent/agents.ts` discovery, move into core), persist transcript to `<session-dir>/<sessionId>/agents/<id>.jsonl`, register as child of the caller, run in background.
- Result delivery: when a child's run settles, inject its final text into the parent as a custom message (`triggerTurn` per setting) so the parent resumes. Also write `<id>.md` output artifact.
- Concurrency: session-scoped semaphore, `task.maxConcurrency` (default 4). Recursion depth: `task.maxDepth` (default 1, subagents cannot spawn).
- Abort: parent abort does not kill children by default (children are background); `/agents kill all` does.
- Out of scope v1: isolation worktrees, structured output schemas, per-call model approval, step chains, speculative launch, eval-kernel tools, workpools.

### 6.5 Focus controller (`modes/interactive/agent-focus-controller.ts`)

- `focusAgent(id)`: `ensureLive`, then re-point: chat container rebuilt from the child's messages (`rebuildChatFromMessages` generalized to take a session), event subscription moved, `footer.setSession`, editor submit routed to `target.prompt({streamingBehavior:"steer"})`.
- `unfocus()`: restore main session view. Esc on empty editor and double-Left return to main (match omp). While focused, Esc does not abort the child.
- Request sequencing: monotonic request id so a slow revive cannot replace a newer focus (omp bug class, copy the guard).
- Dedupe events replayed by rebuild vs live (omp `ShownByRebuild`): a message appended between rebuild and subscribe must not render twice. Reuse by persistence key.
- Visible indicator: footer/status line shows `agent: <name> (running)` and a distinct prompt border color so the user always knows who they are typing to.
- Hard rules: focused agent's session-only changes (model, thinking) never touch main's settings; `/model` opens the session-only picker while focused.

### 6.6 Agent Hub overlay (`modes/interactive/components/agent-hub.ts`)

Built with pi-tui overlays (`ctx.ui.custom({ overlay: true })`). Phased:

- P-A (minimal): roster list (status, name, parent, task gist, cost, age), j/k select, Enter focus, `x` kill, `r` revive, `/` filter, Esc close.
- P-B: inspector pane (current tool + args, context use, lineage), tree toggle `t`.
- P-C: activity log (responses, tool calls, messages, lifecycle) with filters.
- Keybindings added to `DEFAULT_APP_KEYBINDINGS` (repo rule: never hardcode): `app.agents.hub` default `alt+a`, `app.agents.focusNext`, `app.agents.back`. Slash command `/agents` (open Hub), `/agents kill <id|all>`, `/agents msg <id> <text>`.
- Pinned jump list widget above editor via the existing widget mechanism: collapsed default (3 rows + expander), `display.pinnedAgents: off|collapsed|full`.
- Mouse click-to-focus deferred (omp gates it behind `tui.mouse` and it interacts with selection/scroll).

### 6.7 Persistence and resume

- Child transcripts: `<sessionDir>/<sessionId>/agents/<id>.jsonl`, plus a small `<id>.meta.json` (parentId, agent type, task, created, status, tombstone). omp derives everything from the JSONL; a sidecar is simpler and cheaper for pi.
- On session resume / `/agents` open: scan `agents/` and register parked rows with lineage.
- Kill writes a tombstone; revive removes it.

### 6.8 Extension API additions (`ExtensionContext.agents`)

```ts
ctx.agents.list(); ctx.agents.get(id);
ctx.agents.spawn(spec): Promise<AgentHandle>;
ctx.agents.send(to, message, { interrupt? }): Promise<Receipt>;
ctx.agents.kill(id); ctx.agents.revive(id); ctx.agents.focus(id);
ctx.agents.onChange(cb);
```

Then port `examples/extensions/subagent` to use it (child steerable, listed in Hub) as the reference example.

### 6.9 RPC and SDK

- RPC: `agents_list`, `agent_send`, `agent_kill`, `agent_revive`, `agent_get_messages` plus `agent_event` notifications (omp parallel: `modes/rpc/rpc-subagents.ts`). Needed for IDE integrations and for testing without a TUI.
- SDK: `runtime.agents` accessor; document in `docs/sdk.md`.

### 6.10 Settings

`agents.enabled` (default false in phase 1), `agents.idleParkSeconds`, `task.maxConcurrency`, `task.maxDepth`, `display.pinnedAgents`. All through `settings-schema.ts`.

## 7. Phases

| Phase | Deliverable | Exit test |
|-------|-------------|-----------|
| 0 | Fork hygiene: rename branding to piss (package scope, binary `piss`, config dir `.piss` or keep `.pi` per decision O1), upstream remote, CI check | `npm run check` green, `piss --version` |
| 1 (done) | Registry + lifecycle + bus, headless. `AgentSession.deliverAgentMessage`. Unit tests with faux provider harness (`test/suite/harness.ts`): steer running, prompt idle, revive parked, failed unknown, broadcast rules, stale-generation guard | tests pass |
| 2 (done) | `task` tool + `message_agent` tool, persistence under `agents/`, result delivery to parent, concurrency/depth limits | model can spawn 2 agents, message one mid-run, parent gets both results |
| 3 (done) | Focus controller + `/agents` roster (no overlay yet) + footer indicator | user focuses a running child, steers it, returns to main; no duplicated messages |
| 4 (done) | Hub overlay P-A then P-B/P-C, keybindings, pinned list | manual QA script in section 9 |
| 5 | Extension `ctx.agents`, RPC commands, port subagent example, docs | example extension steerable |
| 6 | Optional: worktree isolation, RPC-backed remote agents, click-to-focus, advisor rows | per feature |

## 7a. Phase 1 notes (as built)

- Files: `agent-types.ts`, `agent-registry.ts`, `agent-lifecycle.ts`, `agent-bus.ts`, `index.ts`. Not yet exported from the package entry; that is phase 5.
- `AgentSessionHandle` is a narrow interface (`isStreaming`, `sessionFile`, `subscribe`, `prompt`, `abort`, `dispose`) that `AgentSession` satisfies structurally. This is the seam for a later RPC-backed agent (D1).
- The registry is an instance, not a process global; the owner (runtime services) creates it. `listVisibleTo` returns only running or idle agents so a broadcast never revives a parked one.
- `park` refuses a session that is already streaming: between a message being accepted and `agent_start` the ref still reads `idle`, and an idle-TTL park in that window would dispose a session mid-delivery.
- Revive is coalesced per agent and guarded by an epoch that `park`, `kill` and `release` bump, so a slow revive that finishes after a kill is disposed instead of resurrecting the agent.
- Known gap: the ref reads `idle` for a short window after a message is accepted and before `agent_start`. Rosters may flicker; the park guard above covers the safety issue. Revisit if the Hub shows it.
- Not in phase 1: usage metrics on `AgentRef`, persisted tombstones and the `agents/` sidecar (phase 2), the `agent-message` custom message type (phase 3).
- Test harness note: `createHarness({ sessionManager })` does not replay the transcript into the agent, unlike `createAgentSession`. Revive tests set `session.agent.state.messages` from `sessionManager.buildSessionContext()` to match the SDK.

## 7b. Phase 2 notes (as built)

Enable: `{"agents": {"enabled": true}}` in settings (default off). Other keys: `idleParkSeconds` (300), `maxConcurrency` (4), `maxDepth` (1).

Pieces added:
- `AgentsHost` (`agents-host.ts`): one per top-level session. Owns registry, lifecycle and bus; `spawn`, `restorePersisted`, `dispose`. Wired in `createAgentSessionFromServices` (the one place every mode builds sessions) and torn down through a new `AgentSession.addDisposeListener` hook, so replacing or closing the session releases its children.
- `task` and `message_agent` tools (`agent-tools.ts`), registered as `customTools`. A child at depth `d` gets `task` only while `d < maxDepth`, so with the default only main spawns.
- Agent definitions (`agent-definitions.ts`): built-in `worker`, plus markdown files in `~/.pi/agent/agents` and, only when the project is trusted, `.pi/agents`. A repository can carry prompts, so untrusted project definitions never load.
- Child sessions (`child-session-factory.ts`): real in-process `AgentSession`s sharing the parent's model runtime and settings. Each gets its own resource loader with extensions, skills, prompt templates and themes off, because extension runtimes are bound to one session and sharing the parent's loader would route extension actions to the wrong session. Consequence: children do not see MCP or extension tools. A definition's `model` that does not resolve falls back to the parent's model.
- Persistence (`agent-store.ts`): `<session dir>/<session file name>/agents/<id>/` holds the transcript and `meta.json` (parent, agent type, task, killed flag). `restorePersisted()` registers saved agents as parked (or aborted if killed) when a session resumes. A session that is not persisted (`--no-session`) keeps its agents in memory only, and they never park.
- Result delivery: the final assistant text of every run that settles without abort is sent to the agent's parent as `Agent "<id>" finished:`. That covers the first run and any later run started by a message. Delivery retries up to four times, because a parent that is compacting refuses prompts.
- Concurrency: a semaphore limits running agents. A queued agent is registered as `running` with activity `waiting for a slot` so the idle timer cannot park it before its first prompt; a kill while queued frees the slot.

Verified: unit and integration tests (faux provider, real transcript files, a simulated restart), and a manual run through `--mode rpc` with a real model: the model called `task`, the child answered, the report arrived as a message and the main agent replied.

Known limits:
- Print and JSON one-shot modes (`-p`) exit when the main run ends, so background children and their results are lost. They need a way to wait for children (a `wait` tool or a drain-on-exit step) before `task` is useful there.
- The result arrives in the main transcript as a plain user message. A message renderer comes with the focus phase.
- Aborting the main agent (Esc) does not stop its children; use kill. Disposing the main session does.
- A subagent has no tool to discover its siblings. It learns ids from the spawn result, the incoming message, or its initial prompt (which names its parent).
- `agents.*` do not appear in the `/settings` menu yet.

## 7c. Phase 3 notes (as built)

Delivered: focus controller, `/agents`, the agent hub overlay (roster, details inspector, inline message, interrupt, kill, revive), the always-visible agents line, and the hotkeys. Phase 4's hub, inspector and pinned-list work is therefore largely done; what remains there is the activity log, tree toggle, filtering and mouse.

Hotkeys (all `app.agents.*` keybindings, rebindable, labelled on screen and in `/hotkeys`):

| Key | Action |
|---|---|
| `Alt+A` | Open the hub |
| `Alt+.` / `Alt+,` | Next / previous agent; the main agent is one stop in the cycle |
| `Alt+M` | Back to the main agent |
| `Esc` while viewing an agent | Interrupt that agent's run (never main's) |
| Hub: `Enter` `M` `I` `X` `R` `D` | View and steer, message, interrupt, kill, revive, details |

`Alt+[` was avoided on purpose: it is the CSI introducer, so terminals cannot tell it from the start of an escape sequence.

How the view retargets:
- `InteractiveMode.session` returns the focused agent's session when one is focused, so the transcript, editor submit, footer, model and thinking controls all follow with no per-call-site change. `retargetView()` is the one place that rebuilds the view: unsubscribe, clear the status indicator, re-render the transcript from the new session, resubscribe, then catch up.
- Catch-up: a transcript rebuilt mid-run lacks the message being written and the working indicator, because those only arrive as events. `catchUpWithRunningSession()` replays `agent_start`, `turn_start` and `message_start` with `agent.state.streamingMessage`, so later updates attach. Tested with a slowly streaming faux model.
- A focused agent is pinned (`lifecycle.pin`) so the idle timer cannot park it while it is on screen. It is released when the view leaves it.
- If the focused agent is killed or released the view returns to main on its own. A newer focus request wins over a slower earlier revive (monotonic request id).
- `/new`, `/resume`, `/fork`, `/clone`, `/import` and `/reload` return to the main view first, since they act on the main session. Replacing the session resets the focus and the old session's agents are released with it.
- The extension UI stays bound to the main session; focusing a subagent does not rebind extensions.

Hooks into upstream files (kept thin): `interactive-mode.ts` (session getter, `retargetView`, hub and command methods, key actions, border colour, a call in the rebind callback), `footer.ts` (an optional line above the footer), `keybindings.ts`, `slash-commands.ts`. `rebindCurrentSession` itself is untouched on purpose: upstream tests call it on a hand-built stub `this`, so new calls inside it break them.

Known limits:
- The hub has no filter, tree toggle or activity log yet (phase 4); long rosters scroll.
- No mouse support.
- Tool calls already running when an agent is focused do not get a card until they finish; the rest of the run renders live.
- Verified on a virtual terminal (xterm-headless), not a real one.

## 7d. Per-call subagent model (as built)

The `task` tool takes an optional `model` per item, so a stronger main model can delegate cheap work to a faster one. User-facing description: [agents.md](./agents.md#choosing-the-subagents-model).

- Order: the call's `model`, then the agent definition's `model:`, then the parent's model.
- Resolution (`child-model.ts`) reuses the CLI resolver (fuzzy names, `provider/model`, `:level` suffix) and adds rules a subagent needs:
  - Unknown, unauthenticated or disallowed models fail the spawn. Before this, an unresolvable definition `model:` silently fell back to the parent's model, which changes cost without telling anyone. The resolver also invents a "custom model" for an id the provider does not list; that is refused.
  - A bare name prefers the parent's provider. Found by a real run: with both `anthropic` and `amazon-bedrock` configured, `haiku` resolved to the Bedrock model (whose SSO token had expired), not the Anthropic one the main agent runs on. The preference only counts when that provider really lists the model, so it never makes another provider's model unreachable. `provider/model` still wins.
  - Errors list the models that would work, parent's provider first, so the model that chose can correct itself. The CLI resolver's "use `--list-models`" advice is replaced because a model cannot run it.
- `agents.allowedModels` restricts what a call may choose (unset: any authenticated model; `[]`: none). The task tool description then lists exactly those models. It applies to a fresh spawn's per-call model only, not to a definition's `model:` (operator-written) and not to a revive.
- The model pattern is saved in the agent's `meta.json` and used again on revive, including after a restart.
- A refused spawn leaves nothing behind: the model is resolved before any session directory is created, and the host passes the directory path without creating it.

Verified with the real build and real credentials over RPC: `anthropic/claude-sonnet-5-5` called `task` with `model: "haiku"`, the child ran on `anthropic/claude-haiku-5-5` and answered; an unknown model produced the error above and no child.

## 7e. Phase 4 notes (as built)

Hub additions (all `app.agents.*` keybindings, rebindable, labelled on screen, in `/hotkeys` and in `docs/keybindings.md`):

| Key | Action |
|---|---|
| `Tab` | Switch between the agent list and the activity log |
| `T` | Tree (parents and children) or flat list (running first, then idle, parked, killed; newest activity first) |
| `/` | Filter by text. `Enter` keeps it, `Esc` clears it; `Esc` clears a kept filter before it closes the hub |
| `F` | Activity log: cycle all, errors, replies, tools, messages, lifecycle. The hint names the next kind |
| `S` | Activity log: every agent, or only the agent of the selected entry |
| `Enter` in the log | View the agent of the selected entry |

The log follows the newest entry until you move up (it then shows `paused`), and resumes when you reach the bottom. The list and the log keep separate filters.

Activity log (`agent-activity.ts`): a bounded (500), in-memory ring owned by `AgentsHost`, fed by:
- registry changes (killed, parked, revived, finished its run, released), spawn and restore (with who spawned it, type, model and task);
- each subagent session's events (tool calls with their most telling argument, failed tools, replies, model errors, interrupted runs);
- the bus, through a new `onDelivery` hook: messages and reports are filed under the subagent at either end, and a failed delivery is an error entry. A message with no subagent at either end (main to an unknown id) is not logged.

The log is not persisted; the transcripts are. A restored agent starts with a single "restored" entry.

Reports and messages (`AgentMessageComponent`): the bus writes `Agent "<id>" finished:` / `Message from agent "<id>":` text (`agent-envelope.ts` now owns that format and its parser). The UI recognises it in the one `user` case of `addMessageToChat` and draws `◀ report from <id>` / `◀ message from <id>` on the custom-message background; reports longer than 12 lines collapse and expand with the tool-output key. The transcript is unchanged (still an ordinary user message), so the model sees the same text, and a person who types the same words gets the same styling and nothing more. Envelopes are kept out of the up-arrow history.

Found while testing: at a very narrow width a single long hint overflowed, because hints were wrapped between items but never cut; fixed in `wrapHints`.

Not done: mouse support, a persisted log, and an unread marker for reports that arrive while you view another agent.

## 8. Risks

- `interactive-mode.ts` is 7.3k lines with session binding spread across it (`renderInitialMessages`, `rebuildChatFromMessages`, footer, editor handlers, extension UI context). Focus must retarget all of them. Mitigation: introduce one `ViewTarget` indirection first (phase 3a), refactor with no behavior change, then add focus.
- Event dedupe between rebuild and live subscribe (see 6.5).
- Revive races: park vs message vs kill. Mitigation: generation guards and coalesced `ensureLive`, ported tests.
- Cost/context blowup from many concurrent children: concurrency cap and usage shown in the roster.
- Upstream drift: piss tracks `upstream/main`. Keep new code under `core/agents/` and `modes/interactive/agents/` with thin hook points in existing files to keep rebases cheap.
- Security: children inherit parent tools and cwd. Default child tool set honors agent definition `tools`; project-trust rules (`core/project-trust.ts`) must apply to project-level agent definitions.

## 9. Manual QA script (phase 4)

1. `piss`, ask it to spawn two scouts on a large repo. Hub shows two `running` rows.
2. Alt+A, select one, Enter. Transcript swaps; footer shows the agent name.
3. Type a redirect. It appears in the child's transcript and the child changes course.
4. Esc on empty editor returns to main with no duplicated or missing messages.
5. `x` kills one; row shows `aborted`. `r` revives; full history intact.
6. Wait past idle TTL; row becomes `parked`; message it; it revives.
7. Quit, resume the session; Hub lists the persisted agents as parked.

## 10. Open questions

- O1. Branding scope: rename config dir (`~/.pi` to `~/.piss`) or stay compatible so piss and pi share settings and sessions? Recommend staying on `~/.pi` initially (zero migration, sessions interchangeable) with an env override; decide before phase 0.
- O2. Resolved: public repo `sauftot/piss` on GitHub.
- O3. Resolved: in-process children for v1 (D1).
- O4. Resolved: `task` coexists with the example `subagent` extension; neither replaces the other.
- O5. Resolved: both MIT. Add omp's copyright line to piss's LICENSE if any code is copied verbatim.
