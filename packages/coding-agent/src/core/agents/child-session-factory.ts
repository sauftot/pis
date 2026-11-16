// Builds the in-process AgentSession for a subagent, from the same services as its parent.

import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionServices } from "../agent-session-services.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import type { ChildSessionFactory } from "./agents-host.ts";
import { resolveChildModel } from "./child-model.ts";

/**
 * A child shares the parent's model runtime (credentials, catalogue) and settings, but gets its own resource
 * loader: extension runtimes are bound to one session, so sharing the parent's loader would route extension
 * actions to the wrong session. Children run without extensions, skills and prompt templates; the agent
 * definition supplies their prompt.
 */
export function createChildSessionFactory(
	services: AgentSessionServices,
	getParentModel: () => Model<any> | undefined,
): ChildSessionFactory {
	return async ({ definition, sessionDir, sessionFile, customTools, model, restrictModelTo }) => {
		// Resolved before anything is created, so a refused model leaves no session directory behind. The call's
		// model wins over the definition's. A pattern that does not resolve fails the spawn: running on a different
		// model than asked would silently change what the work costs.
		const requested = model ?? definition.model;
		const chosen = requested
			? resolveChildModel(services.modelRuntime, requested, {
					allowed: model ? restrictModelTo : undefined,
					preferProvider: getParentModel()?.provider,
				})
			: undefined;

		const sessionManager = sessionFile
			? SessionManager.open(sessionFile)
			: sessionDir
				? SessionManager.create(services.cwd, sessionDir)
				: SessionManager.inMemory(services.cwd);

		const resourceLoader = new DefaultResourceLoader({
			cwd: services.cwd,
			agentDir: services.agentDir,
			settingsManager: services.settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			appendSystemPrompt: definition.systemPrompt.trim() ? [definition.systemPrompt] : undefined,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: services.cwd,
			agentDir: services.agentDir,
			modelRuntime: services.modelRuntime,
			settingsManager: services.settingsManager,
			resourceLoader,
			sessionManager,
			model: chosen?.model ?? getParentModel(),
			thinkingLevel: chosen?.thinkingLevel,
			// An allowlist would otherwise disable the agent tools, so name them explicitly.
			tools: definition.tools ? [...definition.tools, ...customTools.map((tool) => tool.name)] : undefined,
			customTools,
		});
		return session;
	};
}
