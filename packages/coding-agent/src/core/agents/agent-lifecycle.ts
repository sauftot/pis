// Owns the live/parked/killed lifecycle of subagent sessions: idle-TTL parking, revival, kill and release.

import type { AgentRegistry } from "./agent-registry.ts";
import type { AgentRef, AgentSessionHandle } from "./agent-types.ts";

/** Rebuilds a live session for a parked or killed agent from its transcript. */
export type AgentReviver = (ref: AgentRef) => Promise<AgentSessionHandle>;

export interface AdoptOptions {
	reviver: AgentReviver;
}

export interface AgentLifecycleOptions {
	/** Idle time before an agent is parked. Read each time a timer is armed; <= 0 disables parking. */
	idleParkMs: () => number;
}

interface Managed {
	reviver: AgentReviver;
	timer: ReturnType<typeof setTimeout> | undefined;
	unsyncStatus: (() => void) | undefined;
	/** Bumped by park, kill and release; a revive that started under an older epoch is discarded. */
	epoch: number;
	reviving: Promise<AgentSessionHandle> | undefined;
}

export class AgentLifecycle {
	private readonly managed = new Map<string, Managed>();
	private readonly registry: AgentRegistry;
	private readonly options: AgentLifecycleOptions;
	private readonly unsubscribeRegistry: () => void;

	constructor(registry: AgentRegistry, options: AgentLifecycleOptions) {
		this.registry = registry;
		this.options = options;
		this.unsubscribeRegistry = registry.onChange((event) => {
			if (event.type !== "status_changed") return;
			const entry = this.managed.get(event.ref.id);
			if (!entry) return;
			if (event.ref.status === "idle") this.armTimer(event.ref.id, entry);
			else this.clearTimer(entry);
		});
	}

	/** Take ownership of an agent: mirror its run status, remember how to revive it, and arm its idle timer. */
	adopt(id: string, options: AdoptOptions): void {
		const ref = this.registry.get(id);
		if (!ref) throw new Error(`Cannot adopt unknown agent "${id}"`);
		const entry: Managed = {
			reviver: options.reviver,
			timer: undefined,
			unsyncStatus: undefined,
			epoch: 0,
			reviving: undefined,
		};
		this.managed.get(id)?.unsyncStatus?.();
		this.managed.set(id, entry);
		if (ref.session) entry.unsyncStatus = this.registry.syncSessionStatus(id, ref.session);
		if (ref.status === "idle") this.armTimer(id, entry);
	}

	/**
	 * Park an idle agent: dispose its session and keep the transcript for revival. Returns whether it parked.
	 * A session that is already streaming is never parked: a message accepted just before its run emits
	 * `agent_start` would otherwise be lost to the idle timer.
	 */
	park(id: string): boolean {
		const ref = this.registry.get(id);
		const entry = this.managed.get(id);
		if (!ref || !entry || ref.status !== "idle" || !ref.session || !ref.sessionFile) return false;
		if (ref.session.isStreaming) return false;
		const session = ref.session;
		entry.epoch++;
		this.teardownBinding(entry);
		this.registry.detachSession(id, ref);
		this.registry.setStatus(id, "parked", ref);
		session.dispose();
		return true;
	}

	/**
	 * Return a live session for `id`, reviving a parked or killed agent from its transcript.
	 * Concurrent calls for one agent share a single revive.
	 */
	async ensureLive(id: string): Promise<AgentSessionHandle> {
		const ref = this.registry.get(id);
		if (!ref) throw new Error(`Agent "${id}" not found`);
		if (ref.session && (ref.status === "idle" || ref.status === "running")) return ref.session;
		const entry = this.managed.get(id);
		if (!entry) throw new Error(`Agent "${id}" is not managed and cannot be revived`);
		if (!ref.sessionFile) throw new Error(`Agent "${id}" has no transcript and cannot be revived`);
		entry.reviving ??= this.revive(id, ref, entry).finally(() => {
			entry.reviving = undefined;
		});
		return entry.reviving;
	}

	/** Abort a running agent and release its session. It stays registered as `aborted` until revived. */
	async kill(id: string): Promise<boolean> {
		const ref = this.registry.get(id);
		const entry = this.managed.get(id);
		if (!ref || !entry) return false;
		entry.epoch++;
		await this.endSession(id, ref, entry);
		this.registry.setStatus(id, "aborted", ref);
		return true;
	}

	/** Kill an agent and remove it from the registry. It cannot be revived afterwards. */
	async release(id: string): Promise<boolean> {
		const ref = this.registry.get(id);
		const entry = this.managed.get(id);
		if (!ref || !entry) return false;
		entry.epoch++;
		await this.endSession(id, ref, entry);
		this.managed.delete(id);
		this.registry.unregister(id, ref);
		return true;
	}

	/** Release every managed agent and stop listening to the registry. */
	async dispose(): Promise<void> {
		this.unsubscribeRegistry();
		await Promise.all([...this.managed.keys()].map((id) => this.release(id)));
	}

	private async revive(id: string, ref: AgentRef, entry: Managed): Promise<AgentSessionHandle> {
		const epoch = entry.epoch;
		const session = await entry.reviver(ref);
		if (entry.epoch !== epoch || this.registry.get(id) !== ref) {
			session.dispose();
			throw new Error(`Agent "${id}" was released or changed while it was being revived`);
		}
		this.registry.attachSession(id, session, undefined, ref);
		entry.unsyncStatus = this.registry.syncSessionStatus(id, session);
		this.registry.setStatus(id, "idle", ref);
		return session;
	}

	private async endSession(id: string, ref: AgentRef, entry: Managed): Promise<void> {
		this.teardownBinding(entry);
		const session = ref.session;
		this.registry.detachSession(id, ref);
		if (!session) return;
		try {
			await session.abort();
		} finally {
			session.dispose();
		}
	}

	private teardownBinding(entry: Managed): void {
		this.clearTimer(entry);
		entry.unsyncStatus?.();
		entry.unsyncStatus = undefined;
	}

	private armTimer(id: string, entry: Managed): void {
		this.clearTimer(entry);
		const ttl = this.options.idleParkMs();
		if (ttl <= 0) return;
		entry.timer = setTimeout(() => {
			entry.timer = undefined;
			this.park(id);
		}, ttl);
		entry.timer.unref();
	}

	private clearTimer(entry: Managed): void {
		if (entry.timer === undefined) return;
		clearTimeout(entry.timer);
		entry.timer = undefined;
	}
}
