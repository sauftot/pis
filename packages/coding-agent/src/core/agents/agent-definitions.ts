// Agent definitions: markdown files with frontmatter that configure a subagent's prompt, tools and model.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "../../utils/frontmatter.ts";

export type AgentDefinitionSource = "builtin" | "user" | "project";

export interface AgentDefinition {
	name: string;
	description: string;
	/** Tool allowlist. Undefined means the default tool set. */
	tools: string[] | undefined;
	/** Model pattern, as accepted by `--model`. Undefined means the parent's model. */
	model: string | undefined;
	systemPrompt: string;
	source: AgentDefinitionSource;
	filePath: string | undefined;
}

export interface DiscoverAgentDefinitionsOptions {
	cwd: string;
	/** User definition dirs, highest priority first: `~/.pis/agent/agents`, then pi's `~/.pi/agent/agents`. */
	userDirs: string[];
	/** Project config directory names, highest priority first, such as `.pis` and `.pi`. */
	configDirNames: string[];
	/** Whether project-level definitions may load. They carry prompts from the repository, so they need trust. */
	includeProject: boolean;
}

type AgentFrontmatter = { name?: unknown; description?: unknown; tools?: unknown; model?: unknown };

export const DEFAULT_AGENT_NAME = "worker";

const BUILTIN_WORKER: AgentDefinition = {
	name: DEFAULT_AGENT_NAME,
	description: "General-purpose subagent with the default tool set.",
	tools: undefined,
	model: undefined,
	systemPrompt:
		"You are a subagent working on one task delegated by another agent. Do the task, then reply with a concise " +
		"final report: what you did, what you found, and anything the delegating agent must act on. Your final " +
		"message is delivered to the delegating agent automatically, so do not wait for further instructions.",
	source: "builtin",
	filePath: undefined,
};

/** Built-in worker, then user definitions, then project definitions; a later definition replaces an earlier one of the same name. */
export function discoverAgentDefinitions(options: DiscoverAgentDefinitionsOptions): AgentDefinition[] {
	const byName = new Map<string, AgentDefinition>([[BUILTIN_WORKER.name, BUILTIN_WORKER]]);
	// Lowest priority first, so a later directory's definition replaces an earlier one of the same name.
	for (const dir of [...options.userDirs].reverse())
		for (const definition of loadDirectory(dir, "user")) byName.set(definition.name, definition);
	if (options.includeProject) {
		for (const configDirName of [...options.configDirNames].reverse()) {
			const projectDir = findProjectAgentsDir(options.cwd, configDirName);
			if (projectDir)
				for (const definition of loadDirectory(projectDir, "project")) byName.set(definition.name, definition);
		}
	}
	return [...byName.values()];
}

function loadDirectory(dir: string, source: "user" | "project"): AgentDefinition[] {
	if (!existsSync(dir)) return [];
	const definitions: AgentDefinition[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".md")) continue;
		const filePath = join(dir, file);
		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(readFileSync(filePath, "utf-8"));
		// One malformed file must not hide every other agent in the directory.
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
		definitions.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}
	return definitions;
}

/** Accepts `tools: read, bash` and `tools: [read, bash]`; anything else yields the default tool set. */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((tool): tool is string => typeof tool === "string")
		.map((tool) => tool.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function findProjectAgentsDir(cwd: string, configDirName: string): string | undefined {
	for (let dir = cwd; ; dir = dirname(dir)) {
		const candidate = join(dir, configDirName, "agents");
		if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
		if (dirname(dir) === dir) return undefined;
	}
}
