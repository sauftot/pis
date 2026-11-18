// Which agents host belongs to which top-level session. A leaf module, so anything that holds a session can look
// its host up without importing the code that builds hosts.

import type { AgentSession } from "../agent-session.ts";
import type { AgentsHost } from "./agents-host.ts";

const hostsBySession = new WeakMap<AgentSession, AgentsHost>();

/** The agents host of a top-level session, or undefined when agents are disabled for it. */
export function getSessionAgentsHost(session: AgentSession): AgentsHost | undefined {
	return hostsBySession.get(session);
}

export function setSessionAgentsHost(session: AgentSession, host: AgentsHost): void {
	hostsBySession.set(session, host);
}
