/**
 * Tool registry + executor. The executor is the single entry point both the text agent (Step 4)
 * and the voice agent (Step 8) use to run a tool: it validates input/output with Zod, publishes
 * `tool_call` / `tool_result` (and, for terminal tools, `decision`) events to the bus, and never
 * throws to the caller — tool failures become graceful `{ ok: false }` results.
 */
import { z } from "zod";
import { getSession, resolveOrderId } from "@/lib/db";
import { emit, hasDecisionForOrder, hasDecisionOfOutcome } from "@/lib/event-bus";
import { checkRefundEligibilityTool } from "@/lib/tools/check-refund-eligibility";
import { denyRefundTool } from "@/lib/tools/deny-refund";
import { escalateToHumanTool } from "@/lib/tools/escalate-to-human";
import { getOrderDetailsTool } from "@/lib/tools/get-order-details";
import { lookupCustomerTool } from "@/lib/tools/lookup-customer";
import { processRefundTool } from "@/lib/tools/process-refund";
import type { ToolDef, ToolExecutionResult } from "@/lib/tools/types";

export const TOOLS: ToolDef[] = [
  lookupCustomerTool,
  getOrderDetailsTool,
  checkRefundEligibilityTool,
  processRefundTool,
  denyRefundTool,
  escalateToHumanTool,
];

const TOOL_MAP = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDef | undefined {
  return TOOL_MAP.get(name);
}

export interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

function toOpenAITool(tool: ToolDef): OpenAITool {
  const schema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  delete schema.$schema;
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: schema },
  };
}

/** The tools array to hand to the OpenAI Chat Completions API (text agent, Step 4). */
export const openaiTools: OpenAITool[] = TOOLS.map(toOpenAITool);

/** A Realtime API function tool: the SAME schema as {@link OpenAITool}, but flattened (name/description/
 *  parameters at the top level rather than nested under `function`) as the Realtime API expects. */
export interface RealtimeTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * The tools array to hand to the OpenAI Realtime API (voice agent, Step 8). Derived from the exact
 * same {@link ToolDef} list + Zod schemas as {@link openaiTools}, so the voice agent and the text agent
 * expose identical tools — voice tool calls run server-side through the same {@link executeTool} path.
 */
export const realtimeTools: RealtimeTool[] = TOOLS.map((tool) => {
  const schema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  delete schema.$schema;
  return { type: "function", name: tool.name, description: tool.description, parameters: schema };
});

/**
 * Execute a tool by name within a session. Emits observability events and returns a normalized
 * result. Unknown tools, unknown sessions, invalid input/output, and thrown errors all degrade to
 * `{ ok: false, error }` after emitting the appropriate events.
 */
export async function executeTool(
  sessionId: string,
  name: string,
  rawInput: unknown,
): Promise<ToolExecutionResult> {
  // Guard a blank sessionId up front: emitting an event with an empty sessionId would fail schema
  // validation and throw, breaking the "never throws to the caller" contract.
  if (!sessionId || sessionId.trim() === "") {
    return { ok: false, tool: name, error: "unknown_session" };
  }

  const tool = TOOL_MAP.get(name);
  if (!tool) {
    emit("error", sessionId, { message: `Unknown tool: ${name}`, where: "executeTool" });
    return { ok: false, tool: name, error: `unknown_tool: ${name}` };
  }

  const session = getSession(sessionId);
  if (!session) {
    emit("error", sessionId, { message: "Unknown session", where: name });
    return { ok: false, tool: name, error: "unknown_session" };
  }

  const ctx = { sessionId, now: session.now };
  const start = Date.now();
  emit("tool_call", sessionId, { tool: name, args: rawInput });

  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const error = `invalid_input: ${z.prettifyError(parsed.error)}`;
    emit("tool_result", sessionId, {
      tool: name,
      ok: false,
      error,
      durationMs: Date.now() - start,
    });
    return { ok: false, tool: name, error };
  }

  try {
    const output = tool.run(ctx, parsed.data);
    const checked = tool.outputSchema.safeParse(output);
    if (!checked.success) {
      const error = `invalid_output: ${z.prettifyError(checked.error)}`;
      emit("error", sessionId, { message: error, where: name });
      emit("tool_result", sessionId, {
        tool: name,
        ok: false,
        error,
        durationMs: Date.now() - start,
      });
      return { ok: false, tool: name, error };
    }
    emit("tool_result", sessionId, {
      tool: name,
      ok: true,
      result: checked.data,
      durationMs: Date.now() - start,
    });
    if (tool.toDecision) {
      const decision = tool.toDecision(parsed.data, checked.data);
      if (decision) {
        // Normalize the order id (spoken forms) to the canonical stored id; an absent OR unresolvable
        // order id yields no order key. Emit EXACTLY ONE decision per resolved request: dedupe by the
        // canonical order when we have one, else by outcome (so an order-less escalate can't double-emit
        // after the eligibility check already recorded the escalation).
        const canonical = decision.orderId
          ? resolveOrderId(sessionId, decision.orderId)
          : undefined;
        const payload = { ...decision, orderId: canonical };
        const already = canonical
          ? hasDecisionForOrder(sessionId, canonical)
          : hasDecisionOfOutcome(sessionId, decision.outcome);
        if (!already) emit("decision", sessionId, payload);
      }
    }
    return { ok: true, tool: name, result: checked.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit("error", sessionId, { message, where: name });
    emit("tool_result", sessionId, {
      tool: name,
      ok: false,
      error: message,
      durationMs: Date.now() - start,
    });
    return { ok: false, tool: name, error: message };
  }
}
