// Token types for the True Speech lexer.
//
// Token kinds are lexical only — the tokenizer doesn't know about
// metrics or dimensions, just about the shape of input characters.
// Semantic enrichment (is this identifier a metric vs a dimension?)
// happens at validation time, not tokenization.

import type { Span } from "./source.js";

export type TokenKind =
  | "keyword"
  | "grain"
  | "time-keyword"
  | "identifier"
  | "time-literal"
  | "string"
  | "number"
  | "operator"
  | "punctuation"
  | "eof"
  | "error";

export interface Token {
  kind: TokenKind;
  text: string; // original source text (case-preserving)
  span: Span;
}

// Reserved word sets. Matching is case-insensitive at tokenize time;
// downstream consumers can rely on token.kind without re-checking text.

export const KEYWORDS: ReadonlySet<string> = new Set([
  "compute",
  "over",
  "and",
  "group",
  "by",
  "order",
  "limit",
  "in",
  "not",
  "asc",
  "desc",
  "register",
  "check",
  "impacting",
  "with",
]);

export const GRAINS: ReadonlySet<string> = new Set([
  "day",
  "week",
  "month",
  "quarter",
  "year",
]);

export const TIME_KEYWORDS: ReadonlySet<string> = new Set([
  "until",
  "since",
  "all",
  "time",
  "to",
]);

export function classifyWord(lowered: string): TokenKind {
  if (KEYWORDS.has(lowered)) return "keyword";
  if (GRAINS.has(lowered)) return "grain";
  if (TIME_KEYWORDS.has(lowered)) return "time-keyword";
  return "identifier";
}
