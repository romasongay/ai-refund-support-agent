/**
 * Shared reasoning-event schema. This is the single event vocabulary consumed by the admin
 * dashboard, and it is published identically by the text agent and the voice agent — so it lives
 * BELOW both transports. Every event is Zod-validated.
 *
 * Shape (per the spec): `{ id, sessionId, ts, type, payload }` where `type` is one of a fixed set
 * and `payload` is validated per-type via a discriminated union.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const EVENT_TYPES = [
  "user_message",
  "assistant_message",
  "thought",
  "tool_call",
  "tool_result",
  "decision",
  "error",
  "retry",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// --- Per-type payload schemas ---------------------------------------------------------------

export const UserMessagePayloadSchema = z.object({ text: z.string() });
export const AssistantMessagePayloadSchema = z.object({ text: z.string() });
export const ThoughtPayloadSchema = z.object({ text: z.string() });

export const ToolCallPayloadSchema = z.object({
  tool: z.string(),
  args: z.unknown(),
  callId: z.string().optional(),
});

export const ToolResultPayloadSchema = z.object({
  tool: z.string(),
  callId: z.string().optional(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
});

export const DecisionPayloadSchema = z.object({
  outcome: z.enum(["approved", "denied", "escalated"]),
  // Structural backstop: no decision event (approved/denied/escalated) may lack a clause citation.
  clauses: z.array(z.string()).min(1),
  amount: z.number().nullable().optional(),
  orderId: z.string().optional(),
  customerId: z.string().optional(),
  summary: z.string(),
});

export const ErrorPayloadSchema = z.object({
  message: z.string(),
  where: z.string().optional(),
  detail: z.string().optional(),
});

export const RetryPayloadSchema = z.object({
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  reason: z.string(),
  delayMs: z.number().optional(),
});

export type DecisionPayload = z.infer<typeof DecisionPayloadSchema>;

// --- The event (discriminated union on `type`) ----------------------------------------------

const baseFields = {
  id: z.string().min(1),
  sessionId: z.string().min(1),
  ts: z.number(),
};

export const ReasoningEventSchema = z.discriminatedUnion("type", [
  z.object({ ...baseFields, type: z.literal("user_message"), payload: UserMessagePayloadSchema }),
  z.object({
    ...baseFields,
    type: z.literal("assistant_message"),
    payload: AssistantMessagePayloadSchema,
  }),
  z.object({ ...baseFields, type: z.literal("thought"), payload: ThoughtPayloadSchema }),
  z.object({ ...baseFields, type: z.literal("tool_call"), payload: ToolCallPayloadSchema }),
  z.object({ ...baseFields, type: z.literal("tool_result"), payload: ToolResultPayloadSchema }),
  z.object({ ...baseFields, type: z.literal("decision"), payload: DecisionPayloadSchema }),
  z.object({ ...baseFields, type: z.literal("error"), payload: ErrorPayloadSchema }),
  z.object({ ...baseFields, type: z.literal("retry"), payload: RetryPayloadSchema }),
]);

export type ReasoningEvent = z.infer<typeof ReasoningEventSchema>;

/** Compile-time map from event type to its payload type (used to type the event constructor). */
export interface PayloadByType {
  user_message: z.infer<typeof UserMessagePayloadSchema>;
  assistant_message: z.infer<typeof AssistantMessagePayloadSchema>;
  thought: z.infer<typeof ThoughtPayloadSchema>;
  tool_call: z.infer<typeof ToolCallPayloadSchema>;
  tool_result: z.infer<typeof ToolResultPayloadSchema>;
  decision: z.infer<typeof DecisionPayloadSchema>;
  error: z.infer<typeof ErrorPayloadSchema>;
  retry: z.infer<typeof RetryPayloadSchema>;
}

/** Build a well-formed event, filling `id` and `ts` when not supplied. */
export function createEvent<T extends EventType>(
  type: T,
  sessionId: string,
  payload: PayloadByType[T],
  opts: { id?: string; ts?: number } = {},
): ReasoningEvent {
  return {
    id: opts.id ?? randomUUID(),
    sessionId,
    ts: opts.ts ?? Date.now(),
    type,
    payload,
  } as ReasoningEvent;
}
