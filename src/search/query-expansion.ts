import { containsCjk } from "./cjk-analyzer.js";

export type ExpansionMode = "auto" | "force" | "skip";
export type ExpansionAction = "expand" | "skip";
export type ExpansionReason =
  | "cjk-default"
  | "strong-signal"
  | "explicit-skip"
  | "explicit-force"
  | "auto-expand";

export type ExpansionDirective = {
  directive: "force" | "skip" | null;
  query: string;
};

export type ExpansionDecision = {
  action: ExpansionAction;
  reason: ExpansionReason;
  query: string;
};

export class ExpansionPolicyError extends Error {
  readonly reason: "conflicting-directives";

  constructor(reason: "conflicting-directives", message: string) {
    super(message);
    this.name = "ExpansionPolicyError";
    this.reason = reason;
  }
}

export function parseExpansionDirective(input: string): ExpansionDirective {
  const trimmed = input.trim();
  const match = /^(lex|expand)\s*:\s*(.*)$/isu.exec(trimmed);
  if (!match) return { directive: null, query: trimmed };

  const query = (match[2] ?? "").trim();
  if (!query) throw new Error(`${match[1]?.toLowerCase()}: requires a non-empty query`);
  return {
    directive: match[1]?.toLowerCase() === "lex" ? "skip" : "force",
    query,
  };
}

export function resolveExpansionPolicy(options: {
  query: string;
  mode: ExpansionMode;
  strongSignal: boolean;
  allowCjkExpand?: boolean;
}): ExpansionDecision {
  const parsed = parseExpansionDirective(options.query);
  if (!parsed.query) throw new Error("query must not be empty");

  if (options.mode === "force" && parsed.directive === "skip") {
    throw new ExpansionPolicyError(
      "conflicting-directives",
      "conflicting expansion directives: force cannot be combined with lex:",
    );
  }

  if (options.mode === "skip" || parsed.directive === "skip") {
    return { action: "skip", reason: "explicit-skip", query: parsed.query };
  }
  if (options.mode === "force" || parsed.directive === "force") {
    return { action: "expand", reason: "explicit-force", query: parsed.query };
  }
  if (containsCjk(parsed.query) && !options.allowCjkExpand) {
    return { action: "skip", reason: "cjk-default", query: parsed.query };
  }
  if (options.strongSignal) {
    return { action: "skip", reason: "strong-signal", query: parsed.query };
  }
  return { action: "expand", reason: "auto-expand", query: parsed.query };
}
