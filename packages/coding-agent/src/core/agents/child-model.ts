// Resolves the model a subagent runs on from a model pattern, and refuses anything unknown, unauthenticated or not allowed.

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveCliModel } from "../model-resolver.ts";
import type { ModelRuntime } from "../model-runtime.ts";

export interface ResolvedChildModel {
	model: Model<Api>;
	/** From a `:level` suffix on the pattern, such as `haiku:low`. */
	thinkingLevel: ThinkingLevel | undefined;
}

/** How many available models an error lists, so the caller can correct itself without a wall of text. */
const MAX_LISTED = 12;

export interface ResolveChildModelOptions {
	/** When set, the resolved model must be one of the models these patterns resolve to. */
	allowed?: readonly string[];
	/**
	 * Provider to look in first when the pattern names none. A bare `haiku` then means the parent's provider's
	 * haiku, whose credentials are known to work, rather than whichever authenticated provider also has one.
	 */
	preferProvider?: string;
}

/**
 * Resolve `pattern` (`haiku`, `anthropic/claude-haiku-4-5`, `claude-haiku-4-5:low`) to a model. Throws an Error
 * whose message names the problem and lists models that would work, so a model that chose the pattern can retry.
 */
export function resolveChildModel(
	modelRuntime: ModelRuntime,
	pattern: string,
	options: ResolveChildModelOptions = {},
): ResolvedChildModel {
	const { allowed, preferProvider } = options;
	// The preferred provider only wins when it really lists the model: for an id it lacks, the resolver
	// invents a custom model instead of failing, and that must not shadow another provider's real one.
	const preferred =
		preferProvider && !pattern.includes("/")
			? resolveCliModel({ cliProvider: preferProvider, cliModel: pattern, modelRuntime })
			: undefined;
	const resolved =
		preferred && !preferred.error && isListed(modelRuntime, preferred.model)
			? preferred
			: resolveCliModel({ cliModel: pattern, modelRuntime });
	// An ambiguous pattern lists its candidates, which is the useful part. Other errors advise `--list-models`,
	// which the caller cannot run, so they become the not-found message below.
	if (resolved.error?.includes("ambiguous")) throw new Error(resolved.error);
	const model = resolved.model;
	// For an id the catalogue does not know, the resolver invents a "custom model" and only warns. A subagent
	// must not run on a guess: a typo would silently run on whatever that provider does with the unknown id.
	if (!model || !isListed(modelRuntime, model))
		throw new Error(`Model "${pattern}" not found. ${availableHint(modelRuntime, preferProvider)}`);

	if (!modelRuntime.hasConfiguredAuth(model.provider)) {
		throw new Error(
			`No credentials are configured for provider "${model.provider}", so "${pattern}" cannot run. ${availableHint(modelRuntime, preferProvider)}`,
		);
	}
	if (allowed && !isAllowed(modelRuntime, model, allowed)) {
		throw new Error(`Model "${pattern}" is not allowed for subagents. Allowed: ${allowed.join(", ")}.`);
	}
	return { model, thinkingLevel: resolved.thinkingLevel };
}

function isListed(modelRuntime: ModelRuntime, model: Model<Api> | undefined): boolean {
	return (
		model !== undefined && modelRuntime.getModels().some((m) => m.provider === model.provider && m.id === model.id)
	);
}

function isAllowed(modelRuntime: ModelRuntime, model: Model<Api>, allowed: readonly string[]): boolean {
	return allowed.some((pattern) => {
		const entry = resolveCliModel({ cliModel: pattern, modelRuntime }).model;
		return entry !== undefined && entry.provider === model.provider && entry.id === model.id;
	});
}

/** Models that would work, the preferred provider's first so a long catalogue does not bury the likely choices. */
function availableHint(modelRuntime: ModelRuntime, preferProvider: string | undefined): string {
	const available = modelRuntime.getAvailableSnapshot();
	const ordered = [
		...available.filter((m) => m.provider === preferProvider),
		...available.filter((m) => m.provider !== preferProvider),
	];
	const names = ordered.map((m) => `${m.provider}/${m.id}`);
	if (names.length === 0) return "No models are available.";
	const listed = names.slice(0, MAX_LISTED).join(", ");
	return `Available: ${listed}${names.length > MAX_LISTED ? `, and ${names.length - MAX_LISTED} more` : ""}.`;
}
