# pis and pi: shared config, separate writes

pis is a fork of pi. It is installed as the `pis` command and keeps its own config in `~/.pis/agent` and a project's `.pis/`. It also reads pi's `~/.pi/agent` and `.pi/` underneath, so everything you set up for pi works in pis from the first start. pis never writes to pi's directories.

Rule of thumb: **pis reads both, `.pis` wins, and writes go only to `.pis`.**

## What carries over, and how

| What | pi's copy | How pis uses it |
|---|---|---|
| `settings.json` (global and project) | `~/.pi/agent/settings.json`, `.pi/settings.json` | Merged per key under pis's own; a key set in pis's file wins. Changing a setting in pis writes only that key, to pis's file. |
| Extensions, skills, prompts, themes (auto-discovered) | `~/.pi/agent/{extensions,skills,prompts,themes}`, `.pi/...` | Loaded from both. One with the same name in pis's directory replaces pi's (`~/.pis/agent/extensions/foo.ts` hides `~/.pi/agent/extensions/foo.ts`). |
| Installed packages (`npm:`, `git:`) | `~/.pi/agent/npm`, `~/.pi/agent/git`, `.pi/npm`, `.pi/git` | Loaded from pi's install while pis has none. Installs and updates go to pis's own directories. |
| `auth.json`, `mcp-auth.json` | `~/.pi/agent/` | pis's file starts as a copy of pi's the first time pis needs it, then is pis's own. |
| `models.json` | `~/.pi/agent/models.json` | Used while pis has no `models.json`. |
| `mcp.json` (global and project) | `~/.pi/agent/mcp.json`, `.pi/mcp.json` | Used while pis has none. The first change (`/mcp`, `pis mcp add`) copies pi's file into pis's and edits the copy. |
| `keybindings.json` | `~/.pi/agent/keybindings.json` | Merged per action; pis's binding wins. |
| `trust.json` (project trust) | `~/.pi/agent/trust.json` | pi's decisions apply to folders pis has not decided on. `/trust` saves to pis's file. |
| Global `AGENTS.md` | `~/.pi/agent/AGENTS.md` | Used while `~/.pis/agent` has none. Project `AGENTS.md` files come from the project's folders, as before. |
| `SYSTEM.md`, `APPEND_SYSTEM.md` | `~/.pi/agent/`, `.pi/` | The first that exists: project `.pis`, project `.pi`, then `~/.pis/agent`, `~/.pi/agent`. |
| Subagent definitions | `~/.pi/agent/agents/`, `.pi/agents/` | Loaded from both; pis's definition wins on a name clash. |
| Sessions | `~/.pi/agent/sessions/` | `/resume` and `--resume` list pi's sessions next to pis's. `-c` continues pi's most recent session if it is newer than pis's. Opening a pi session forks it: pis continues in a copy under `~/.pis/agent/sessions/`, and pi's file stays as it was. |

## Environment variables

- `PIS_CODING_AGENT_DIR` moves pis's agent dir. Set alone, pis is isolated: it does not read pi's agent dir. To pair it with a pi dir, also set `PI_CODING_AGENT_DIR`.
- `PI_CODING_AGENT_DIR` moves the pi agent dir that pis reads.
- An SDK host that passes its own `agentDir` gets no pi layer.

## Things to know

- **OAuth token rotation.** pis copies pi's credentials once, then refreshes its own copy. Some providers rotate refresh tokens, so a refresh in pis can make pi's copy stale, and pi asks you to log in again (or the other way round). To avoid it, log in separately in pis (`/login`).
- **Removing something that comes from pi.** `pis remove`, `/logout` and clearing a trust decision change only pis's files. Something defined only in pi's files still applies; remove it with `pi`, or override it in pis's files.
- **Updates.** pis does not check npm for pi releases and does not show pi's update notice.
- **Managed tools** (`fd`, `rg`) are downloaded into `~/.pis/agent/bin` separately.
