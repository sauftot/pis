// Decides which agent the chat view shows: the main agent, or one subagent whose live session the view is retargeted at.

import type { AgentSession } from "../../../core/agent-session.ts";
import {
	type AgentSessionHandle,
	type AgentsHost,
	buildRoster,
	MAIN_AGENT_ID,
	type RegistryEvent,
} from "../../../core/agents/index.ts";

/** What the controller needs from the interactive mode. */
export interface AgentFocusContext {
	getHost(): AgentsHost | undefined;
	/** Show the controller's current target: its transcript, status line and editor. */
	retargetView(): void;
	notify(message: string): void;
	/** The full session behind a registry handle, or undefined when it cannot be viewed. */
	asViewSession(handle: AgentSessionHandle): AgentSession | undefined;
}

interface Target {
	id: string;
	handle: AgentSessionHandle;
	session: AgentSession;
	unpin: () => void;
	unwatch: () => void;
}

export class AgentFocusController {
	private readonly context: AgentFocusContext;
	private target: Target | undefined;
	/** Monotonic request id: a focus that finishes after a newer one started is dropped, not applied. */
	private requestSeq = 0;

	constructor(context: AgentFocusContext) {
		this.context = context;
	}

	/** Id of the focused subagent, or undefined while the main agent is shown. */
	get focusedId(): string | undefined {
		return this.target?.id;
	}

	/** Session of the focused subagent, or undefined while the main agent is shown. */
	get session(): AgentSession | undefined {
		return this.target?.session;
	}

	/**
	 * Show agent `id`. A parked or killed agent is revived from its transcript first. Focusing `main` returns
	 * to the main agent. Throws an Error with a message fit to show the user.
	 */
	async focus(id: string): Promise<void> {
		if (id === MAIN_AGENT_ID) return this.unfocus();
		const host = this.context.getHost();
		if (!host) throw new Error("Agents are not enabled. Set agents.enabled to true in settings.");
		const ref = host.registry.get(id);
		if (!ref || ref.kind !== "sub") throw new Error(`No agent named "${id}". Open the agent hub to see the agents.`);
		if (this.target?.id === id) return;

		const request = ++this.requestSeq;
		const wasStopped = ref.status === "parked" || ref.status === "aborted";
		const handle = await host.lifecycle.ensureLive(id);
		if (request !== this.requestSeq) return;
		const session = this.context.asViewSession(handle);
		if (!session) throw new Error(`Agent "${id}" cannot be viewed from here.`);

		this.detach();
		// Pinned from the same tick as the revive, so the idle timer cannot park it while it is on screen.
		this.target = {
			id,
			handle,
			session,
			unpin: host.lifecycle.pin(id),
			unwatch: host.registry.onChange((event) => this.onRegistryEvent(event)),
		};
		this.context.retargetView();
		if (wasStopped) this.context.notify(`Revived ${id} from its transcript.`);
	}

	/** Return to the main agent. Does nothing when it is already shown. */
	unfocus(): void {
		if (!this.target) return;
		this.requestSeq++;
		this.detach();
		this.context.retargetView();
	}

	/** Move the view to the next or previous agent, treating the main agent as one stop in the cycle. */
	async cycle(direction: 1 | -1): Promise<void> {
		const host = this.context.getHost();
		if (!host) throw new Error("Agents are not enabled. Set agents.enabled to true in settings.");
		const stops = [
			MAIN_AGENT_ID,
			...buildRoster(host.registry, (id) => host.describe(id))
				.filter((row) => row.status !== "aborted")
				.map((row) => row.id),
		];
		if (stops.length === 1) {
			this.context.notify("There are no agents to switch to.");
			return;
		}
		const at = Math.max(0, stops.indexOf(this.target?.id ?? MAIN_AGENT_ID));
		await this.focus(stops[(at + direction + stops.length) % stops.length]!);
	}

	/** Drop the focus without redrawing, for when the session underneath was replaced. */
	reset(): void {
		this.requestSeq++;
		this.detach();
	}

	private detach(): void {
		if (!this.target) return;
		this.target.unpin();
		this.target.unwatch();
		this.target = undefined;
	}

	private onRegistryEvent(event: RegistryEvent): void {
		const target = this.target;
		if (!target || event.ref.id !== target.id) return;
		const stopped = event.type === "removed" || (event.type === "status_changed" && event.ref.status === "aborted");
		if (!stopped) return;
		this.unfocus();
		this.context.notify(`${target.id} was stopped. Back on the main agent.`);
	}
}
