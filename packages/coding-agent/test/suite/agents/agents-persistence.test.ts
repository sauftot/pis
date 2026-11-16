import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentDefinition,
	AgentStore,
	AgentsHost,
	type ChildSessionRequest,
} from "../../../src/core/agents/index.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

const worker: AgentDefinition = {
	name: "worker",
	description: "General purpose",
	tools: undefined,
	model: undefined,
	systemPrompt: "",
	source: "builtin",
	filePath: undefined,
};

/**
 * Subagents backed by real AgentSessions writing real transcript files, so a second host built on the same
 * directory behaves like a restarted process.
 */
describe("agent persistence across a restart", () => {
	const harnesses: Harness[] = [];
	const hosts: AgentsHost[] = [];
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(hosts.splice(0).map((host) => host.dispose()));
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function boot(root: string, childScripts: FauxResponseStep[][], mainScript: FauxResponseStep[]) {
		const requests: ChildSessionRequest[] = [];
		const children: Harness[] = [];
		const host = new AgentsHost({
			store: new AgentStore(join(root, "agents")),
			definitions: () => [worker],
			settings: () => ({ idleParkMs: 0, maxConcurrency: 4, maxDepth: 1 }),
			createChildSession: async (request) => {
				requests.push(request);
				const sessionManager = request.sessionFile
					? SessionManager.open(request.sessionFile)
					: SessionManager.create(root, request.sessionDir);
				const child = await createHarness({ sessionManager });
				harnesses.push(child);
				children.push(child);
				// The test harness does not replay the transcript; createAgentSession does. Do the same here.
				child.session.agent.state.messages = sessionManager.buildSessionContext().messages;
				child.setResponses(childScripts.shift() ?? []);
				return child.session;
			},
			deliveryRetryMs: 1,
		});
		hosts.push(host);
		const main = await createHarness();
		harnesses.push(main);
		main.setResponses(mainScript);
		host.attachMain(main.session);
		return { host, main, requests, children };
	}

	const newRoot = () => {
		const dir = mkdtempSync(join(tmpdir(), "piss-persist-"));
		dirs.push(dir);
		return dir;
	};

	it("writes the transcript and meta under the agent's directory and reports to main", async () => {
		const root = newRoot();
		const { host, main } = await boot(
			root,
			[[fauxAssistantMessage("alpha is done")]],
			[fauxAssistantMessage("noted")],
		);

		await host.spawn({ callerId: "main", agent: undefined, name: "Alpha", task: "inspect auth", context: undefined });
		await vi.waitFor(() => expect(getAssistantTexts(main)).toContain("noted"));
		expect(getUserTexts(main)).toEqual(['Agent "Alpha" finished:\n\nalpha is done']);

		const dir = join(root, "agents", "Alpha");
		expect(readdirSync(dir).some((file) => file.endsWith(".jsonl"))).toBe(true);
		expect(existsSync(join(dir, "meta.json"))).toBe(true);
		expect(host.registry.get("Alpha")?.sessionFile?.startsWith(dir)).toBe(true);
	});

	it("restores a parked agent in a new host and revives it with its history when messaged", async () => {
		const root = newRoot();
		const first = await boot(root, [[fauxAssistantMessage("alpha is done")]], [fauxAssistantMessage("noted")]);
		await first.host.spawn({
			callerId: "main",
			agent: undefined,
			name: "Alpha",
			task: "inspect auth",
			context: undefined,
		});
		await vi.waitFor(() => expect(getAssistantTexts(first.main)).toContain("noted"));
		await vi.waitFor(() => expect(first.host.registry.get("Alpha")?.status).toBe("idle"));
		expect(first.host.lifecycle.park("Alpha")).toBe(true);
		await first.host.dispose();

		// A new process: fresh registry and host, same directory on disk.
		const second = await boot(root, [[fauxAssistantMessage("still here")]], [fauxAssistantMessage("welcome back")]);
		expect(second.host.restorePersisted()).toBe(1);
		expect(second.host.registry.get("Alpha")).toMatchObject({ status: "parked", parentId: "main", kind: "sub" });
		expect(second.requests).toEqual([]);

		const receipt = await second.host.bus.send({ from: "main", to: "Alpha", body: "are you there?" });
		expect(receipt).toMatchObject({ outcome: "revived", mode: "prompted" });
		expect(second.requests[0]?.sessionFile).toBe(second.host.registry.get("Alpha")?.sessionFile);

		await vi.waitFor(() => expect(getAssistantTexts(second.main)).toContain("welcome back"));
		const revived = second.children[0]!;
		expect(getUserTexts(revived)[0]).toContain("inspect auth");
		expect(getAssistantTexts(revived)).toEqual(["alpha is done", "still here"]);
		expect(getUserTexts(second.main)).toEqual(['Agent "Alpha" finished:\n\nstill here']);
	});

	it("keeps a killed agent dead across a restart until it is messaged", async () => {
		const root = newRoot();
		const first = await boot(root, [[fauxAssistantMessage("done")]], [fauxAssistantMessage("noted")]);
		await first.host.spawn({ callerId: "main", agent: undefined, name: "Alpha", task: "work", context: undefined });
		await vi.waitFor(() => expect(getAssistantTexts(first.main)).toContain("noted"));
		await vi.waitFor(() => expect(first.host.registry.get("Alpha")?.status).toBe("idle"));
		await first.host.lifecycle.kill("Alpha");
		expect(new AgentStore(join(root, "agents")).read("Alpha")?.killed).toBe(true);
		await first.host.dispose();

		const second = await boot(root, [[fauxAssistantMessage("revived")]], [fauxAssistantMessage("ok")]);
		second.host.restorePersisted();
		expect(second.host.registry.get("Alpha")?.status).toBe("aborted");

		await second.host.bus.send({ from: "main", to: "Alpha", body: "wake up" });
		await vi.waitFor(() => expect(second.host.registry.get("Alpha")?.status).toBe("running"));
		expect(new AgentStore(join(root, "agents")).read("Alpha")?.killed).toBe(false);
	});

	it("does not reuse the id of an agent saved earlier", async () => {
		const root = newRoot();
		const first = await boot(root, [[fauxAssistantMessage("done")]], [fauxAssistantMessage("noted")]);
		await first.host.spawn({ callerId: "main", agent: undefined, name: "Alpha", task: "work", context: undefined });
		await vi.waitFor(() => expect(getAssistantTexts(first.main)).toContain("noted"));
		await first.host.dispose();

		const second = await boot(root, [[fauxAssistantMessage("done")]], [fauxAssistantMessage("noted")]);
		const spawned = await second.host.spawn({
			callerId: "main",
			agent: undefined,
			name: "Alpha",
			task: "other",
			context: undefined,
		});
		expect(spawned.id).toBe("Alpha2");
	});

	it("does not restore agents that have no transcript", async () => {
		const root = newRoot();
		const store = new AgentStore(join(root, "agents"));
		store.write({
			id: "Ghost",
			displayName: "Ghost",
			agent: "worker",
			parentId: "main",
			task: "x",
			sessionFile: null,
			createdAt: 1,
			killed: false,
		});
		const { host } = await boot(root, [], []);
		expect(host.restorePersisted()).toBe(0);
		expect(host.registry.get("Ghost")).toBeUndefined();
	});
});
