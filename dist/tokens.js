// Token types for the True Speech lexer.
//
// Token kinds are lexical only — the tokenizer doesn't know about
// metrics or dimensions, just about the shape of input characters.
// Semantic enrichment (is this identifier a metric vs a dimension?)
// happens at validation time, not tokenization.
// Reserved word sets. Matching is case-insensitive at tokenize time;
// downstream consumers can rely on token.kind without re-checking text.
export const KEYWORDS = new Set([
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
]);
export const GRAINS = new Set([
    "day",
    "week",
    "month",
    "quarter",
    "year",
]);
export const TIME_KEYWORDS = new Set([
    "until",
    "since",
    "all",
    "time",
    "to",
]);
export function classifyWord(lowered) {
    if (KEYWORDS.has(lowered))
        return "keyword";
    if (GRAINS.has(lowered))
        return "grain";
    if (TIME_KEYWORDS.has(lowered))
        return "time-keyword";
    return "identifier";
}
