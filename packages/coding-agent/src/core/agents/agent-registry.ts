// Directory of every agent in a session tree (the main agent and its subagents), keyed by stable id.

import type {
	AgentRef,
	AgentRefExpectation,
	AgentSessionHandle,
	AgentStatus,
	RegisterInput,
	RegistryEvent,
	RegistryListener,
} from "./agent-types.ts";

export class AgentRegistry {
	private readonly refs = new Map<string, AgentRef>();
	private readonly listeners = new Set<RegistryListener>();
	private nextGeneration = 1;

	/** Register `input.id`, replacing any earlier ref. Always mints a new generation. */
	register(input: RegisterInput): AgentRef {
		const now = Date.now();
		const ref: AgentRef = {
			id: input.id,
			generation: this.nextGeneration++,
			displayName: input.displayName,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? (input.session ? "idle" : "parked"),
			session: input.session,
			sessionFile: input.sessionFile ?? input.session?.sessionFile ?? null,
			createdAt: input.createdAt ?? now,
			lastActivity: input.lastActivity ?? now,
			activity: undefined,
		};
		this.refs.set(ref.id, ref);
		this.emit({ type: "registered", ref });
		return ref;
	}

	get(id: string): AgentRef | undefined {
		return this.refs.get(id);
	}

	list(): AgentRef[] {
		return [...this.refs.values()];
	}

	/** Agents `id` can address in a broadcast: running or idle, so a broadcast never revives a parked agent. */
	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter((ref) => ref.id !== id && (ref.status === "running" || ref.status === "idle"));
	}

	/** Set the status when `expected` is still the registered ref. Returns false when it is not. */
	setStatus(id: string, status: AgentStatus, expected?: AgentRefExpectation): boolean {
		const ref = this.match(id, expected);
		if (!ref) return false;
		if (ref.status === status) return true;
		const previous = ref.status;
		ref.status = status;
		ref.lastActivity = Date.now();
		if (status !== "running") ref.activity = undefined;
		this.emit({ type: "status_changed", ref, previous });
		return true;
	}

	setActivity(id: string, activity: string | undefined, expected?: AgentRefExpectation): boolean {
		const ref = this.match(id, expected);
		if (!ref) return false;
		ref.activity = activity;
		ref.lastActivity = Date.now();
		this.emit({ type: "metadata_changed", ref });
		return true;
	}

	/** Attach a live session. `sessionFile` overrides the ref's transcript path when given. */
	attachSession(
		id: string,
		session: AgentSessionHandle,
		sessionFile?: string | null,
		expected?: AgentRefExpectation,
	): boolean {
		const ref = this.match(id, expected);
		if (!ref) return false;
		ref.session = session;
		ref.sessionFile = sessionFile ?? session.sessionFile ?? ref.sessionFile;
		this.emit({ type: "metadata_changed", ref });
		return true;
	}

	detachSession(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.match(id, expected);
		if (!ref) return false;
		ref.session = null;
		this.emit({ type: "metadata_changed", ref });
		return true;
	}

	unregister(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.match(id, expected);
		if (!ref) return false;
		this.refs.delete(id);
		this.emit({ type: "removed", ref });
		return true;
	}

	/**
	 * Mirror a session's run events into the ref `id`: running while a run is open, idle once it settles,
	 * and the current tool as the activity. Returns the unsubscribe function. Events that arrive after the
	 * ref was parked, aborted or given another session are ignored, so a late settle cannot undo a kill.
	 */
	syncSessionStatus(id: string, session: AgentSessionHandle): () => void {
		const ref = this.refs.get(id);
		if (!ref) return () => {};
		return session.subscribe((event) => {
			if (ref.session !== session || ref.status === "parked" || ref.status === "aborted") return;
			switch (event.type) {
				case "agent_start":
					this.setStatus(id, "running", ref);
					break;
				case "agent_settled":
					this.setStatus(id, "idle", ref);
					break;
				case "tool_execution_start":
					this.setActivity(id, event.toolName, ref);
					break;
				case "tool_execution_end":
					this.setActivity(id, undefined, ref);
					break;
				default:
					break;
			}
		});
	}

	/** Subscribe to registry events. Returns the unsubscribe function. */
	onChange(listener: RegistryListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private match(id: string, expected: AgentRefExpectation | undefined): AgentRef | undefined {
		const ref = this.refs.get(id);
		if (!ref) return undefined;
		if (expected === undefined) return ref;
		if (expected === ref || (ref.session !== null && expected === ref.session)) return ref;
		return undefined;
	}

	private emit(event: RegistryEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}
