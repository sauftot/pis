// pis reads pi's config (~/.pi/agent and a project's .pi) under its own (~/.pis/agent, .pis) and never writes it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getAgentDirLayers, getBaseAgentDir, getProjectConfigDirs } from "../../../src/config.ts";
import { FileAuthStorageBackend } from "../../../src/core/auth-storage.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ModelConfig } from "../../../src/core/model-config.ts";
import { DefaultPackageManager } from "../../../src/core/package-manager.ts";
import { loadProjectContextFiles } from "../../../src/core/resource-loader.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { addMcpServerConfig, loadMcpConfig } from "../../../src/extensions/mcp/config.ts";

describe("pis over pi", () => {
	let root: string;
	let pisDir: string;
	let piDir: string;
	let project: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pis-layer-"));
		pisDir = join(root, "home", ".pis", "agent");
		piDir = join(root, "home", ".pi", "agent");
		project = join(root, "project");
		for (const dir of [pisDir, piDir, project]) mkdirSync(dir, { recursive: true });
		// The default agent dirs of both: the base layer only exists for the default one.
		vi.stubEnv(ENV_AGENT_DIR, pisDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", piDir);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	const write = (path: string, content: unknown) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
	};
	const readJson = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

	describe("layers", () => {
		it("has a base layer only under the default agent dir", () => {
			expect(getBaseAgentDir(pisDir)).toBe(piDir);
			expect(getAgentDirLayers(pisDir)).toEqual([pisDir, piDir]);
			// SDK hosts and tests with their own agent dir stay isolated from the user's pi config.
			expect(getBaseAgentDir(join(root, "custom"))).toBeUndefined();
			expect(getProjectConfigDirs(project)).toEqual([join(project, ".pis"), join(project, ".pi")]);
		});
	});

	describe("settings", () => {
		it("merges pi's settings under pis's, per key and per scope", () => {
			write(join(piDir, "settings.json"), { theme: "light", steeringMode: "all", agents: { maxDepth: 2 } });
			write(join(pisDir, "settings.json"), { theme: "dark", agents: { maxConcurrency: 8 } });
			write(join(project, ".pi", "settings.json"), { hideThinkingBlock: true });
			write(join(project, ".pis", "settings.json"), { steeringMode: "one-at-a-time" });

			const settings = SettingsManager.create(project, pisDir);
			expect(settings.getTheme()).toBe("dark");
			expect(settings.getHideThinkingBlock()).toBe(true);
			expect(settings.getSteeringMode()).toBe("one-at-a-time");
			expect(settings.getAgentsSettings()).toMatchObject({ maxDepth: 2, maxConcurrency: 8 });
		});

		it("writes only the changed key, only to pis's file", async () => {
			const piSettings = { theme: "light", steeringMode: "all" };
			write(join(piDir, "settings.json"), piSettings);
			const settings = SettingsManager.create(project, pisDir);
			settings.setTheme("dark");
			await settings.flush();

			expect(readJson(join(pisDir, "settings.json"))).toEqual({ theme: "dark" });
			expect(readJson(join(piDir, "settings.json"))).toEqual(piSettings);
			expect(settings.getSteeringMode()).toBe("all");
		});

		it("keeps pi's relative resource paths pointing into pi's directory", () => {
			write(join(piDir, "settings.json"), { extensions: ["./ext/a.ts", "-./ext/b.ts", "npm:pkg", "~/x.ts"] });
			const extensions = SettingsManager.create(project, pisDir).getGlobalSettings().extensions;
			expect(extensions).toEqual([
				join(piDir, "ext", "a.ts"),
				`-${join(piDir, "ext", "b.ts")}`,
				"npm:pkg",
				"~/x.ts",
			]);
		});
	});

	describe("credentials and models", () => {
		it("starts pis's auth.json as a copy of pi's, then leaves pi's alone", () => {
			const piAuth = { anthropic: { type: "api_key", key: "from-pi" } };
			write(join(piDir, "auth.json"), piAuth);
			const backend = new FileAuthStorageBackend(join(pisDir, "auth.json"));
			backend.withLock((current) => {
				expect(JSON.parse(current ?? "{}")).toEqual(piAuth);
				return { result: undefined, next: JSON.stringify({ ...piAuth, openai: { type: "api_key", key: "k" } }) };
			});

			expect(Object.keys(readJson(join(pisDir, "auth.json")))).toEqual(["anthropic", "openai"]);
			expect(readJson(join(piDir, "auth.json"))).toEqual(piAuth);
		});

		it("reads pi's models.json while pis has none", async () => {
			write(join(piDir, "models.json"), {
				providers: { local: { baseUrl: "http://x", api: "openai-completions" } },
			});
			const config = await ModelConfig.load(join(pisDir, "models.json"));
			expect(config.getError()).toBeUndefined();
			expect(config.getProviderIds()).toContain("local");
		});
	});

	it("merges keybindings per action, pis's winning", () => {
		write(join(piDir, "keybindings.json"), { "app.agents.hub": "alt+h", "app.model.cycleForward": "ctrl+n" });
		write(join(pisDir, "keybindings.json"), { "app.agents.hub": "alt+j" });
		const config = KeybindingsManager.create(pisDir).getEffectiveConfig();
		expect(config["app.agents.hub"]).toBe("alt+j");
		expect(config["app.model.cycleForward"]).toBe("ctrl+n");
	});

	it("applies pi's trust decisions where pis has none, and saves pis's own", () => {
		write(join(piDir, "trust.json"), { [project]: true });
		const store = new ProjectTrustStore(pisDir);
		expect(store.get(project)).toBe(true);
		store.set(join(root, "other"), false);
		expect(Object.keys(readJson(join(pisDir, "trust.json")))).toHaveLength(1);
		expect(readJson(join(piDir, "trust.json"))).toEqual({ [project]: true });
	});

	describe("resources", () => {
		async function resolveExtensions() {
			const settings = SettingsManager.create(project, pisDir);
			const manager = new DefaultPackageManager({ cwd: project, agentDir: pisDir, settingsManager: settings });
			return (await manager.resolve()).extensions.map((resource) => resource.path);
		}

		it("loads pi's extensions, with pis's shadowing those of the same name", async () => {
			write(join(piDir, "extensions", "shared.ts"), "export default () => {};");
			write(join(piDir, "extensions", "pi-only.ts"), "export default () => {};");
			write(join(pisDir, "extensions", "shared.ts"), "export default () => {};");
			write(join(project, ".pi", "extensions", "proj.ts"), "export default () => {};");

			const paths = await resolveExtensions();
			expect(paths).toContain(join(pisDir, "extensions", "shared.ts"));
			expect(paths).toContain(join(piDir, "extensions", "pi-only.ts"));
			expect(paths).not.toContain(join(piDir, "extensions", "shared.ts"));
			expect(paths).toContain(join(project, ".pi", "extensions", "proj.ts"));
		});

		it("uses pi's global AGENTS.md while pis has none", () => {
			write(join(piDir, "AGENTS.md"), "pi rules");
			expect(loadProjectContextFiles({ cwd: project, agentDir: pisDir })[0]?.content).toBe("pi rules");
			write(join(pisDir, "AGENTS.md"), "pis rules");
			expect(loadProjectContextFiles({ cwd: project, agentDir: pisDir })[0]?.content).toBe("pis rules");
		});
	});

	it("reads pi's mcp.json, and an edit copies it into pis's before changing it", () => {
		const piMcp = { mcpServers: { docs: { command: "docs-server" } } };
		write(join(piDir, "mcp.json"), piMcp);
		expect(
			loadMcpConfig({ agentDir: pisDir, cwd: project, projectTrusted: false }).servers.map((s) => s.name),
		).toEqual(["docs"]);

		addMcpServerConfig(join(pisDir, "mcp.json"), "search", { command: "search-server" });
		expect(Object.keys(readJson(join(pisDir, "mcp.json")).mcpServers)).toEqual(["docs", "search"]);
		expect(readJson(join(piDir, "mcp.json"))).toEqual(piMcp);
	});

	describe("sessions", () => {
		/** A pi session file in pi's default session dir for the project, as pi would have written it. */
		function piDefaultSession(text: string): string {
			const piSessionDir = join(piDir, "sessions", `--${project.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
			const manager = SessionManager.create(project, piSessionDir);
			manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "faux",
				provider: "faux",
				model: "faux",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			return manager.getSessionFile()!;
		}

		it("lists pi's sessions for the project next to pis's", async () => {
			const piFile = piDefaultSession("from pi");
			const sessions = await SessionManager.list(project);
			expect(sessions.map((s) => s.path)).toContain(piFile);
			expect((await SessionManager.listAll()).map((s) => s.path)).toContain(piFile);
		});

		it("forks a pi session into pis when it is opened, leaving pi's file as it was", () => {
			const piFile = piDefaultSession("from pi");
			const before = readFileSync(piFile, "utf-8");

			const opened = SessionManager.open(piFile);
			expect(opened.getSessionFile()).not.toBe(piFile);
			expect(opened.getSessionFile()!.startsWith(join(pisDir, "sessions"))).toBe(true);
			opened.appendMessage({ role: "user", content: "continued in pis", timestamp: Date.now() });

			expect(readFileSync(piFile, "utf-8")).toBe(before);
			expect(readFileSync(opened.getSessionFile()!, "utf-8")).toContain("from pi");
		});

		it("continues pi's most recent session when it is newer than pis's, as a fork", () => {
			const piFile = piDefaultSession("newest, from pi");
			const future = new Date(Date.now() + 60_000);
			utimesSync(piFile, future, future);
			const continued = SessionManager.continueRecent(project);
			expect(continued.getSessionFile()!.startsWith(join(pisDir, "sessions"))).toBe(true);
			expect(readFileSync(continued.getSessionFile()!, "utf-8")).toContain("newest, from pi");
		});
	});
});
