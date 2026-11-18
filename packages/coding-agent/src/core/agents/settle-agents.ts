// Waiting for a session and all of its subagents to finish, for modes that exit when the work is done.

import type { AgentSession } from "../agent-session.ts";
import { getSessionAgentsHost } from "./session-hosts.ts";

/**
 * Resolve once the session and its subagents have nothing left to do: no run anywhere and no report on its way.
 * A report wakes the main agent, whose new run may spawn more agents, so this loops until both hold at once.
 * Without agents enabled it returns at once: `prompt()` has already waited for the session's own run.
 */
export async function waitForAgentsToSettle(session: AgentSession): Promise<void> {
	const host = getSessionAgentsHost(session);
	if (!host) return;
	for (;;) {
		await session.waitForIdle();
		await host.whenQuiet();
		if (session.isIdle) return;
	}
}
