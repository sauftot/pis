import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { resolveChildModel } from "../../../src/core/agents/index.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../../model-runtime-test-utils.ts";

describe("resolveChildModel", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	/**
	 * A runtime whose provider offers `piss-fast` and `piss-smart`. With `otherProvider`, a second authenticated
	 * provider also offers `piss-fast`, so that bare name is ambiguous.
	 */
	async function runtime(
		options: { authenticated?: boolean; otherProvider?: boolean } = {},
	): Promise<{ runtime: ModelRuntime; provider: string; other: string | undefined }> {
		const authStorage = AuthStorage.inMemory();
		const rt = getModelRuntime(await createInMemoryModelRegistry(authStorage));
		const register = async (modelIds: string[], provider: string | undefined, authenticated: boolean) => {
			const faux = registerFauxProvider({ provider, models: modelIds.map((id) => ({ id, reasoning: true })) });
			cleanups.push(() => faux.unregister());
			const name = faux.getModel().provider;
			if (authenticated) await authStorage.modify(name, async () => ({ type: "api_key", key: "k" }));
			// Register the provider the way an extension does, so the runtime's catalogue lists these models.
			rt.registerProvider(name, {
				baseUrl: faux.getModel().baseUrl,
				// A provider registered with a key counts as authenticated, so the unauthenticated case leaves it out.
				apiKey: authenticated ? "k" : undefined,
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
			return name;
		};
		const provider = await register(["piss-fast", "piss-smart"], undefined, options.authenticated !== false);
		const other = options.otherProvider ? await register(["piss-fast"], "other-faux", true) : undefined;
		await rt.refresh({ allowNetwork: false });
		return { runtime: rt, provider, other };
	}

	it("resolves a bare id, a provider-qualified id and a partial match to the model", async () => {
		const { runtime: rt, provider } = await runtime();
		expect(resolveChildModel(rt, "piss-fast").model.id).toBe("piss-fast");
		expect(resolveChildModel(rt, `${provider}/piss-smart`).model.id).toBe("piss-smart");
		expect(resolveChildModel(rt, "smart").model.id).toBe("piss-smart");
	});

	it("reads a thinking level from a suffix", async () => {
		const { runtime: rt } = await runtime();
		const resolved = resolveChildModel(rt, "piss-fast:low");
		expect(resolved.model.id).toBe("piss-fast");
		expect(resolved.thinkingLevel).toBe("low");
		expect(resolveChildModel(rt, "piss-fast").thinkingLevel).toBeUndefined();
	});

	it("refuses an unknown model and lists the ones that would work", async () => {
		const { runtime: rt, provider } = await runtime();
		const attempt = () => resolveChildModel(rt, "no-such-model");
		expect(attempt).toThrow('Model "no-such-model" not found');
		expect(attempt).toThrow(`Available: ${provider}/piss-fast, ${provider}/piss-smart`);
	});

	it("refuses an id the provider does not list instead of inventing a custom model", async () => {
		const { runtime: rt, provider } = await runtime();
		expect(() => resolveChildModel(rt, `${provider}/not-a-real-id`)).toThrow("not found");
	});

	it("refuses a model whose provider has no credentials", async () => {
		const { runtime: rt, provider } = await runtime({ authenticated: false });
		expect(() => resolveChildModel(rt, "piss-fast")).toThrow(
			`No credentials are configured for provider "${provider}"`,
		);
	});

	describe("provider preference", () => {
		it("leaves a name that several authenticated providers offer ambiguous when there is no preference", async () => {
			const { runtime: rt } = await runtime({ otherProvider: true });
			expect(() => resolveChildModel(rt, "piss-fast")).toThrow("ambiguous");
		});

		it("resolves a bare name in the parent's provider, whichever provider that is", async () => {
			const { runtime: rt, provider, other } = await runtime({ otherProvider: true });
			expect(resolveChildModel(rt, "piss-fast", { preferProvider: provider }).model.provider).toBe(provider);
			expect(resolveChildModel(rt, "piss-fast", { preferProvider: other }).model.provider).toBe(other);
		});

		it("lets an explicit provider override the preference", async () => {
			const { runtime: rt, provider, other } = await runtime({ otherProvider: true });
			expect(resolveChildModel(rt, `${other}/piss-fast`, { preferProvider: provider }).model.provider).toBe(other);
		});

		it("falls back to the other providers when the preferred one does not offer the model", async () => {
			const { runtime: rt, other } = await runtime({ otherProvider: true });
			// `piss-smart` exists only in the first provider; preferring the other one must not make it unreachable.
			expect(resolveChildModel(rt, "piss-smart", { preferProvider: other }).model.id).toBe("piss-smart");
		});

		it("lists the preferred provider's models first when a model is not found", async () => {
			const { runtime: rt, provider, other } = await runtime({ otherProvider: true });
			const message = (preferProvider: string | undefined) => {
				try {
					resolveChildModel(rt, "nope", { preferProvider });
				} catch (error) {
					return (error as Error).message;
				}
				return "";
			};
			expect(message(other)).toContain(
				`Available: ${other}/piss-fast, ${provider}/piss-fast, ${provider}/piss-smart.`,
			);
			expect(message(provider)).toContain(
				`Available: ${provider}/piss-fast, ${provider}/piss-smart, ${other}/piss-fast.`,
			);
		});

		it("keeps the allowlist and the existence check in force", async () => {
			const { runtime: rt, provider } = await runtime({ otherProvider: true });
			expect(() =>
				resolveChildModel(rt, "piss-fast", { preferProvider: provider, allowed: ["piss-smart"] }),
			).toThrow("not allowed");
			expect(() => resolveChildModel(rt, "nope", { preferProvider: provider })).toThrow("not found");
		});
	});

	describe("allowlist", () => {
		it("accepts a model any allowed pattern resolves to, however it is spelled", async () => {
			const { runtime: rt, provider } = await runtime();
			expect(resolveChildModel(rt, "piss-fast", { allowed: ["piss-fast"] }).model.id).toBe("piss-fast");
			expect(resolveChildModel(rt, `${provider}/piss-fast`, { allowed: ["piss-fast"] }).model.id).toBe("piss-fast");
			expect(resolveChildModel(rt, "piss-fast", { allowed: [`${provider}/piss-smart`, "piss-fast"] }).model.id).toBe(
				"piss-fast",
			);
		});

		it("refuses a model outside the list and names what is allowed", async () => {
			const { runtime: rt } = await runtime();
			expect(() => resolveChildModel(rt, "piss-smart", { allowed: ["piss-fast"] })).toThrow(
				'Model "piss-smart" is not allowed for subagents. Allowed: piss-fast.',
			);
		});

		it("allows nothing for an empty list", async () => {
			const { runtime: rt } = await runtime();
			expect(() => resolveChildModel(rt, "piss-fast", { allowed: [] })).toThrow("not allowed");
		});

		it("ignores allowed entries that resolve to nothing", async () => {
			const { runtime: rt } = await runtime();
			expect(() => resolveChildModel(rt, "piss-fast", { allowed: ["typo"] })).toThrow("not allowed");
			expect(resolveChildModel(rt, "piss-fast", { allowed: ["typo", "piss-fast"] }).model.id).toBe("piss-fast");
		});

		it("checks existence before the list, so a typo says not found", async () => {
			const { runtime: rt } = await runtime();
			expect(() => resolveChildModel(rt, "nope", { allowed: ["piss-fast"] })).toThrow("not found");
		});
	});
});
