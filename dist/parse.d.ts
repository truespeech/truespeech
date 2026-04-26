import type { Statement, TimeLiteral } from "./ast.js";
import type { Token } from "./tokens.js";
import type { Span } from "./source.js";
import type { TrueSpeechError } from "./errors.js";
export interface ParseResult {
    ast: Statement | null;
    errors: TrueSpeechError[];
}
export declare function parse(tokens: Token[]): ParseResult;
export declare function parseTimeLiteralText(text: string, span: Span): TimeLiteral | {
    error: string;
};
export declare const RESERVED_GRAINS: Set<string>;
