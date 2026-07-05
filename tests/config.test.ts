import { afterEach, describe, expect, it } from "vitest";
import { MODELS, hasOpenAIKey, requireOpenAIKey } from "@/lib/config";

const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

afterEach(() => {
  // Restore whatever the environment started with so tests don't leak state.
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
});

describe("config — cost guard", () => {
  it("locks the text/eval model to the mini tier", () => {
    expect(MODELS.text).toBe("gpt-4o-mini");
  });

  it("locks the voice model to the mini realtime tier", () => {
    // GA mini realtime model served by /v1/realtime/calls (the beta gpt-4o-mini-realtime-preview
    // mints a token but 404s on the actual call). Must stay a MINI tier per the cost guard.
    expect(MODELS.realtime).toBe("gpt-realtime-mini");
    expect(MODELS.realtime).toContain("mini");
  });
});

describe("config — API key handling", () => {
  it("hasOpenAIKey() is false when unset or blank", () => {
    delete process.env.OPENAI_API_KEY;
    expect(hasOpenAIKey()).toBe(false);
    process.env.OPENAI_API_KEY = "   ";
    expect(hasOpenAIKey()).toBe(false);
  });

  it("hasOpenAIKey() is true when a non-blank key is present", () => {
    process.env.OPENAI_API_KEY = "sk-test-123";
    expect(hasOpenAIKey()).toBe(true);
  });

  it("requireOpenAIKey() throws a helpful error when missing (and never leaks the key)", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => requireOpenAIKey()).toThrowError(/OPENAI_API_KEY is not set/);
  });

  it("requireOpenAIKey() returns the trimmed key when present", () => {
    process.env.OPENAI_API_KEY = "  sk-test-abc  ";
    expect(requireOpenAIKey()).toBe("sk-test-abc");
  });
});
