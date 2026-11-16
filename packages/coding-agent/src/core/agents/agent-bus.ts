// Addressed messaging between agents: resolve the recipient, revive it if needed, and deliver without waiting for a reply.

import type { PromptDisposition } from "../agent-session.ts";
import type { AgentLifecycle } from "./agent-lifecycle.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { AgentEnvelope, AgentSessionHandle, DeliveryMode, DeliveryReceipt } from "./agent-types.ts";

export class AgentBus {
	private readonly registry: AgentRegistry;
	private readonly lifecycle: AgentLifecycle;

	constructor(registry: AgentRegistry, lifecycle: AgentLifecycle) {
		this.registry = registry;
		this.lifecycle = lifecycle;
	}

	/** Deliver one message. Resolves once the recipient has accepted it, not when it has answered. */
	async send(envelope: AgentEnvelope): Promise<DeliveryReceipt> {
		const { from, to, body } = envelope;
		if (!to) return failed(to, "A recipient is required.");
		if (!body.trim()) return failed(to, "A non-empty message is required.");
		if (to === from) return failed(to, "Cannot send a message to yourself.");
		const ref = this.registry.get(to);
		if (!ref) return failed(to, `Agent "${to}" not found.`);

		const wasStopped = ref.status === "parked" || ref.status === "aborted";
		let session: AgentSessionHandle;
		try {
			session = await this.lifecycle.ensureLive(to);
		} catch (error) {
			return failed(to, errorMessage(error));
		}
		try {
			const mode = await deliverAgentMessage(session, envelope);
			return { outcome: wasStopped ? "revived" : "injected", to, mode };
		} catch (error) {
			return failed(to, errorMessage(error));
		}
	}

	/** Send to every running or idle agent. Only the main agent may broadcast. */
	async broadcast(from: string, body: string): Promise<DeliveryReceipt[]> {
		if (this.registry.get(from)?.kind !== "main") {
			return [failed("all", "Only the main agent can broadcast. Message the one agent that can answer.")];
		}
		const targets = this.registry.listVisibleTo(from);
		return Promise.all(targets.map((target) => this.send({ from, to: target.id, body })));
	}
}

/**
 * Hand a message to a session by its own state: start a run when idle, steer when running, or queue a
 * follow-up when running and `interrupt` is false. Resolves when the session accepts the message; the run
 * it starts continues in the background.
 */
export async function deliverAgentMessage(session: AgentSessionHandle, envelope: AgentEnvelope): Promise<DeliveryMode> {
	const streamingBehavior = envelope.interrupt === false ? "followUp" : "steer";
	return new Promise<DeliveryMode>((resolve, reject) => {
		let accepted = false;
		const run = session.prompt(formatAgentMessage(envelope), {
			source: "extension",
			// The body is agent-authored, so it must never run as an extension command or expand as a template.
			expandPromptTemplates: false,
			streamingBehavior,
			preflightResult: (disposition: PromptDisposition) => {
				accepted = true;
				if (disposition === "handled") reject(new Error("An input handler consumed the message."));
				else if (disposition === "started") resolve("prompted");
				else resolve(streamingBehavior === "steer" ? "steered" : "followed-up");
			},
		});
		// Before acceptance a rejection means the message was refused. After it, the run's own failure
		// belongs to the recipient's event stream, not to the sender.
		run.catch((error: unknown) => {
			if (!accepted) reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}

function formatAgentMessage(envelope: AgentEnvelope): string {
	return `Message from agent "${envelope.from}":\n\n${envelope.body}`;
}

function failed(to: string, error: string): DeliveryReceipt {
	return { outcome: "failed", to, error };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
