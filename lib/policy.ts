import { readFileSync } from "node:fs";
import { join } from "node:path";

let cached: string | null = null;

/** The refund policy markdown, read once and cached. Embedded verbatim in the agent system prompt. */
export function getPolicyText(): string {
  if (cached === null) {
    cached = readFileSync(join(process.cwd(), "data", "refund-policy.md"), "utf8");
  }
  return cached;
}
