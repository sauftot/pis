// The text form of a message between agents: what the bus writes into the recipient's transcript and the UI recognises.

import type { AgentEnvelope } from "./agent-types.ts";

export interface ParsedEnvelope {
	kind: "message" | "result";
	from: string;
	body: string;
}

const RESULT = /^Agent "([A-Za-z0-9_-]+)" finished:\n\n([\s\S]*)$/;
const MESSAGE = /^Message from agent "([A-Za-z0-9_-]+)":\n\n([\s\S]*)$/;

/** The text delivered to the recipient's session for `envelope`. */
export function formatEnvelope(envelope: AgentEnvelope): string {
	if (envelope.kind === "result") return `Agent "${envelope.from}" finished:\n\n${envelope.body}`;
	return `Message from agent "${envelope.from}":\n\n${envelope.body}`;
}

/**
 * Recognise text written by {@link formatEnvelope}. Used to draw such messages distinctly; the transcript keeps
 * them as ordinary user messages, so a person who types the same words gets the same styling and nothing more.
 */
export function parseEnvelope(text: string): ParsedEnvelope | undefined {
	const result = RESULT.exec(text);
	if (result) return { kind: "result", from: result[1]!, body: result[2]! };
	const message = MESSAGE.exec(text);
	if (message) return { kind: "message", from: message[1]!, body: message[2]! };
	return undefined;
}
