import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DecisionBanner } from "@/components/chat/decision-banner";
import { MessageBubble } from "@/components/chat/message-bubble";
import { decisionStyle, toolLabel } from "@/lib/client/labels";
import { SseParser } from "@/lib/client/sse";

afterEach(cleanup);

describe("SseParser", () => {
  it("parses frames, skips heartbeats, and joins data split across chunks", () => {
    const p = new SseParser();
    expect(p.feed(": keep-alive\n\n")).toEqual([]); // heartbeat comment
    const f1 = p.feed(`event: tool_call\ndata: {"tool":"x"}\n\n`);
    expect(f1).toHaveLength(1);
    expect(f1[0].event).toBe("tool_call");
    expect(f1[0].data).toEqual({ tool: "x" });

    expect(p.feed("event: done\nda")).toHaveLength(0); // partial frame buffered
    const f2 = p.feed(`ta: {"reply":"hi"}\n\n`);
    expect(f2[0].data).toEqual({ reply: "hi" });
  });

  it("falls back to a string when data is not JSON", () => {
    expect(new SseParser().feed("data: not json\n\n")[0].data).toBe("not json");
  });
});

describe("labels", () => {
  it("maps known tools and falls back for unknown", () => {
    expect(toolLabel("get_order_details")).toMatch(/order/i);
    expect(toolLabel("unknown_tool")).toBe("Working on it…");
  });
  it("styles each decision outcome", () => {
    expect(decisionStyle("approved").label).toMatch(/approved/i);
    expect(decisionStyle("denied").label).toMatch(/denied/i);
    expect(decisionStyle("escalated").label).toMatch(/escalat/i);
  });
});

describe("MessageBubble", () => {
  it("renders user text literally (no markdown)", () => {
    const { container } = render(
      <MessageBubble message={{ id: "1", role: "user", text: "**not bold**" }} />,
    );
    expect(container.textContent).toContain("**not bold**");
    expect(container.querySelector("strong")).toBeNull();
  });

  it("renders assistant markdown: bold, inline code, and a fenced code block", () => {
    const { container } = render(
      <MessageBubble
        message={{
          id: "2",
          role: "assistant",
          text: "Refund **approved** under `R1`.\n\n```\nsome code\n```",
        }}
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("approved");
    expect(container.querySelector("code")).not.toBeNull();
    expect(container.querySelector("pre")).not.toBeNull();
  });
});

describe("DecisionBanner", () => {
  it("shows the outcome, amount, and clause chips", () => {
    const { container } = render(
      <DecisionBanner
        decision={{ outcome: "approved", clauses: ["R1", "R7"], amount: 129, summary: "ok" }}
      />,
    );
    expect(container.textContent).toContain("Refund approved");
    expect(container.textContent).toContain("$129.00");
    expect(container.textContent).toContain("R1");
    expect(container.textContent).toContain("R7");
    // Announced assertively (reliably surfaced to screen readers on insertion).
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
