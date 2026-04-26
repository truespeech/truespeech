import type { Span } from "./source.js";
export type TokenKind = "keyword" | "grain" | "time-keyword" | "identifier" | "time-literal" | "string" | "number" | "operator" | "punctuation" | "eof" | "error";
export interface Token {
    kind: TokenKind;
    text: string;
    span: Span;
}
export declare const KEYWORDS: ReadonlySet<string>;
export declare const GRAINS: ReadonlySet<string>;
export declare const TIME_KEYWORDS: ReadonlySet<string>;
export declare function classifyWord(lowered: string): TokenKind;
