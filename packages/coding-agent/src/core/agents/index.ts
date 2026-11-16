// Public surface of the piss agent layer.

export { AgentBus, deliverAgentMessage } from "./agent-bus.ts";
export { type AgentDefinition, DEFAULT_AGENT_NAME, discoverAgentDefinitions } from "./agent-definitions.ts";
export { type AdoptOptions, AgentLifecycle, type AgentLifecycleOptions, type AgentReviver } from "./agent-lifecycle.ts";
export { allocateAgentId } from "./agent-names.ts";
export { AgentRegistry } from "./agent-registry.ts";
export { buildRoster, formatAge, type RosterRow, statusGlyph } from "./agent-roster.ts";
export { type AgentMeta, AgentStore } from "./agent-store.ts";
export { createMessageAgentTool, createTaskTool } from "./agent-tools.ts";
export type {
	AgentEnvelope,
	AgentKind,
	AgentRef,
	AgentRefExpectation,
	AgentSessionHandle,
	AgentStatus,
	DeliveryMode,
	DeliveryReceipt,
	RegisterInput,
	RegistryEvent,
	RegistryListener,
} from "./agent-types.ts";
export {
	type AgentInfo,
	AgentsHost,
	type AgentsHostOptions,
	type AgentsSettings,
	type ChildSessionFactory,
	type ChildSessionRequest,
	MAIN_AGENT_ID,
} from "./agents-host.ts";
export { type ResolvedChildModel, resolveChildModel } from "./child-model.ts";
export { createSessionAgents, getSessionAgentsHost, type SessionAgents } from "./create-agents-host.ts";
export { Semaphore } from "./semaphore.ts";
