// Boots a real AgentSessionRuntime on the faux provider, with agents on or off, for end-to-end agent tests.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import type { ExtensionAPI } from "../../../src/index.ts";

export async function bootAgentsRuntime(options: {
	agentsEnabled: boolean;
	tokensPerSecond?: number;
	allowedModels?: string[];
}) {
	const tempDir = mkdtempSync(join(tmpdir(), "piss-e2e-"));
	mkdirSync(join(tempDir, "sessions"), { recursive: true });
	// The main agent runs on `faux-1`; `faux-2` stands in for the cheaper model it delegates to.
	const faux = registerFauxProvider({
		models: [{ id: "faux-1" }, { id: "faux-2" }],
		tokensPerSecond: options.tokensPerSecond,
	});
	const model = faux.getModel();

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: tempDir,
			settingsManager: SettingsManager.inMemory({
				agents: { enabled: options.agentsEnabled, idleParkSeconds: 0, allowedModels: options.allowedModels },
			}),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(model.provider, {
							baseUrl: model.baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((m) => ({
								id: m.id,
								name: m.name,
								api: m.api,
								reasoning: m.reasoning,
								input: m.input,
								cost: m.cost,
								contextWindow: m.contextWindow,
								maxTokens: m.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
	});
	await runtime.session.bindExtensions({});

	return {
		runtime,
		faux,
		async cleanup() {
			await runtime.dispose();
			faux.unregister();
			rmSync(tempDir, { recursive: true, force: true });
		},
	};
}
