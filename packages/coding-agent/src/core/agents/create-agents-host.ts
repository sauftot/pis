// Assembles the agents host for a top-level session from its services.

import { basename, dirname, join } from "node:path";
import { BASE_CONFIG_DIR_NAME, CONFIG_DIR_NAME, getAgentDirLayers } from "../../config.ts";
import type { AgentSession } from "../agent-session.ts";
import type { AgentSessionServices } from "../agent-session-services.ts";
import type { SessionManager } from "../session-manager.ts";
import { type AgentDefinition, discoverAgentDefinitions } from "./agent-definitions.ts";
import { AgentStore } from "./agent-store.ts";
import { AgentsHost } from "./agents-host.ts";
import { createChildSessionFactory } from "./child-session-factory.ts";
import { setSessionAgentsHost } from "./session-hosts.ts";

export interface SessionAgents {
	host: AgentsHost;
	/** Call once the top-level session exists: registers it as `main`, restores saved agents, and ties teardown to its disposal. */
	bindMain(session: AgentSession): void;
}

export function createSessionAgents(services: AgentSessionServices, sessionManager: SessionManager): SessionAgents {
	let main: AgentSession | undefined;
	let definitions: AgentDefinition[] | undefined;

	const host = new AgentsHost({
		store: new AgentStore(agentsRoot(sessionManager.getSessionFile())),
		definitions: () => {
			definitions ??= discoverAgentDefinitions({
				cwd: services.cwd,
				userDirs: getAgentDirLayers(services.agentDir).map((dir) => join(dir, "agents")),
				configDirNames: BASE_CONFIG_DIR_NAME ? [CONFIG_DIR_NAME, BASE_CONFIG_DIR_NAME] : [CONFIG_DIR_NAME],
				includeProject: services.settingsManager.isProjectTrusted(),
			});
			return definitions;
		},
		settings: () => services.settingsManager.getAgentsSettings(),
		createChildSession: createChildSessionFactory(services, () => main?.model),
	});

	return {
		host,
		bindMain(session) {
			main = session;
			setSessionAgentsHost(session, host);
			host.attachMain(session);
			host.restorePersisted();
			session.addDisposeListener(() => void host.dispose());
		},
	};
}

/** `<session dir>/<session file name without .jsonl>/agents`, or undefined for a session that is not persisted. */
function agentsRoot(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	return join(dirname(sessionFile), basename(sessionFile, ".jsonl"), "agents");
}
