import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { AdminDashboard } from "@/components/admin/admin-dashboard";
import { ErrorBoundary } from "@/components/admin/error-boundary";
import { EventRow } from "@/components/admin/event-row";
import { isReasoningEvent } from "@/lib/client/events-stream";
import type { ReasoningEvent } from "@/lib/events";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Minimal controllable EventSource stand-in (jsdom has none) so we can drive the dashboard's feed. */
class MockEventSource {
  static last: MockEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((ev: { data: string }) => void)[]>();
  constructor(public url: string) {
    MockEventSource.last = this;
  }
  addEventListener(type: string, cb: (ev: { data: string }) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }
  dispatch(event: Record<string, unknown>) {
    for (const cb of this.listeners.get(event.type as string) ?? [])
      cb({ data: JSON.stringify(event) });
  }
  close() {}
}

describe("isReasoningEvent shape guard (malformed frames dropped at the client boundary)", () => {
  const good = {
    id: "e1",
    sessionId: "s1",
    ts: 1,
    type: "decision",
    payload: { outcome: "approved", clauses: ["R1"], summary: "ok" },
  };
  it("accepts a well-formed event", () => expect(isReasoningEvent(good)).toBe(true));
  it("rejects a decision frame with no payload (the reported crash vector)", () =>
    expect(isReasoningEvent({ ...good, payload: undefined })).toBe(false));
  it("rejects unknown types, bad base fields, and non-objects", () => {
    expect(isReasoningEvent({ ...good, type: "bogus" })).toBe(false);
    expect(isReasoningEvent({ ...good, id: 123 })).toBe(false);
    expect(isReasoningEvent({ ...good, ts: "nope" })).toBe(false);
    expect(isReasoningEvent(null)).toBe(false);
    expect(isReasoningEvent("nope")).toBe(false);
  });
});

const base = { id: "e1", sessionId: "sess_abc123def", ts: Date.parse("2027-06-01T12:00:00Z") };
const rowOf = (type: string, payload: unknown) =>
  render(<EventRow event={{ ...base, type, payload } as unknown as ReasoningEvent} />).container;

describe("EventRow renders each type distinctly", () => {
  it("tool_call → title + collapsible JSON args", () => {
    const c = rowOf("tool_call", { tool: "lookup_customer", args: { customerId: "cus_01" } });
    expect(c.textContent).toContain("Tool call");
    expect(c.textContent).toContain("lookup_customer");
    expect(c.querySelector("details")).not.toBeNull(); // collapsible JSON
  });

  it("tool_result (failed) → prominent + error message", () => {
    const c = rowOf("tool_result", { tool: "process_refund", ok: false, error: "boom" });
    expect(c.textContent).toContain("failed");
    expect(c.textContent).toContain("boom");
  });

  it("decision → outcome, amount, and clause chips", () => {
    const c = rowOf("decision", {
      outcome: "approved",
      clauses: ["R1"],
      amount: 129,
      summary: "ok",
    });
    expect(c.textContent).toContain("Decision");
    expect(c.textContent).toContain("approved");
    expect(c.textContent).toContain("R1");
    expect(c.textContent).toContain("$129.00");
  });

  it("decision → row tinted by outcome (approved=emerald, denied=rose, escalated=amber) [M1]", () => {
    const tone = (outcome: string) => {
      const c = rowOf("decision", { outcome, clauses: ["R1"], summary: "x" });
      const row = [...c.querySelectorAll("div")].find((d) =>
        (d.className as string).includes("border-l-4"),
      );
      return (row?.className as string) ?? "";
    };
    expect(tone("approved")).toContain("emerald");
    expect(tone("denied")).toContain("rose");
    expect(tone("escalated")).toContain("amber");
  });

  it("error → message + where", () => {
    const c = rowOf("error", { message: "kaboom", where: "agent-loop" });
    expect(c.textContent).toContain("Error");
    expect(c.textContent).toContain("kaboom");
  });

  it("retry → attempt count + reason (the failure/retry surface)", () => {
    const c = rowOf("retry", { attempt: 1, maxAttempts: 3, reason: "network blip" });
    expect(c.textContent).toContain("attempt 1/3");
    expect(c.textContent).toContain("network blip");
  });

  it("thought → text", () => {
    expect(rowOf("thought", { text: "considering the policy" }).textContent).toContain(
      "considering the policy",
    );
  });

  it("decision → renders a chip for EVERY clause even when ids repeat (no key-collision drop)", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = rowOf("decision", {
      outcome: "denied",
      clauses: ["R1", "R1", "R2"],
      summary: "x",
    });
    const chips = [...c.querySelectorAll(".rounded-full")];
    expect(chips).toHaveLength(3);
    expect(chips.filter((n) => n.textContent === "R1")).toHaveLength(2);
    // The index-qualified key means no React duplicate-key warning is emitted.
    expect(warn.mock.calls.some((args) => /same key/.test(String(args[0])))).toBe(false);
  });
});

describe("AdminDashboard (integration via a mocked EventSource)", () => {
  const decision = (id: string, sessionId: string, payload: Record<string, unknown>) => ({
    id,
    sessionId,
    ts: 1,
    type: "decision",
    payload,
  });

  it("outcome stats count only well-formed decisions (a malformed frame can't corrupt totals)", () => {
    vi.stubGlobal("EventSource", MockEventSource);
    render(<AdminDashboard />);
    const es = MockEventSource.last!;
    act(() => {
      es.dispatch(decision("d1", "s1", { outcome: "approved", clauses: ["R1"], summary: "ok" }));
      // Envelope-valid but payload missing `outcome` — must be ignored by the guarded stats memo.
      es.dispatch(decision("d2", "s1", { clauses: ["R1"], summary: "bad" }));
    });
    expect(screen.getByText("Approved", { exact: true }).parentElement?.textContent).toMatch(/1/);
    // And it did not crash the dashboard (heading still present).
    expect(screen.getByText(/Agent reasoning dashboard/i)).toBeTruthy();
  });

  it("paginates a >400-event session with a Show older control that reveals the rest", () => {
    vi.stubGlobal("EventSource", MockEventSource);
    render(<AdminDashboard />);
    const es = MockEventSource.last!;
    act(() => {
      // PAGE_SIZE is 400; 450 events => one page hidden behind "Show older".
      for (let i = 0; i < 450; i++) {
        es.dispatch({
          id: `e${i}`,
          sessionId: "s1",
          ts: i,
          type: "thought",
          payload: { text: String(i) },
        });
      }
    });
    expect(screen.getByText(/450 events \(showing latest 400\)/)).toBeTruthy();
    const older = screen.getByRole("button", { name: /Show 50 older/ });
    act(() => older.click());
    // All revealed: the "showing latest" cap note collapses and the Show-older button is gone.
    expect(screen.queryByText(/showing latest/)).toBeNull();
    expect(screen.queryByRole("button", { name: /older/ })).toBeNull();
  });
});

describe("ErrorBoundary", () => {
  it("renders a safe fallback when a child throws (malformed payload cannot crash the dashboard)", () => {
    const Boom = (): never => {
      throw new Error("bad payload");
    };
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain("could not render");
  });
});
