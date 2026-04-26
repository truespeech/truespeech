// Tokenize a True Speech source string into a Token stream.
//
// The tokenizer is permissive about lexical-vs-semantic correctness:
// it emits time-literal tokens for any digit-run that looks roughly
// like a time literal (e.g. "2026-Q9" or "2026-13"), letting the
// parser/validator produce more informative errors. Genuinely
// unrecognized characters become "error" tokens — they have a span
// so the editor can still highlight them.
//
// String literals use single quotes only and do not support escapes.
// Whitespace is consumed and discarded; tokens carry exact spans so
// the original source can always be reconstructed.
import { classifyWord } from "./tokens.js";
export function tokenize(source) {
    const tokens = [];
    let pos = 0;
    while (pos < source.length) {
        const ch = source[pos];
        // Whitespace
        if (isWhitespace(ch)) {
            pos++;
            continue;
        }
        // Word: identifier / keyword / grain / time-keyword
        if (isWordStart(ch)) {
            const start = pos;
            while (pos < source.length && isWordCont(source[pos]))
                pos++;
            const text = source.slice(start, pos);
            const kind = classifyWord(text.toLowerCase());
            tokens.push({ kind, text, span: { start, end: pos } });
            continue;
        }
        // Number or time literal (begins with digit)
        if (isDigit(ch)) {
            const start = pos;
            while (pos < source.length && isDigit(source[pos]))
                pos++;
            const afterDigits = pos;
            // Time literal continuation: "-Q\d+" or "-\d+(-\d+)?"
            if (source[pos] === "-" &&
                (source[pos + 1] === "Q" ||
                    source[pos + 1] === "q" ||
                    isDigit(source[pos + 1]))) {
                pos++; // consume "-"
                if (source[pos] === "Q" || source[pos] === "q") {
                    pos++; // consume Q
                    while (pos < source.length && isDigit(source[pos]))
                        pos++;
                }
                else {
                    while (pos < source.length && isDigit(source[pos]))
                        pos++;
                    // optional second segment for day form
                    if (source[pos] === "-" && isDigit(source[pos + 1])) {
                        pos++;
                        while (pos < source.length && isDigit(source[pos]))
                            pos++;
                    }
                }
                tokens.push({
                    kind: "time-literal",
                    text: source.slice(start, pos),
                    span: { start, end: pos },
                });
            }
            else {
                tokens.push({
                    kind: "number",
                    text: source.slice(start, afterDigits),
                    span: { start, end: afterDigits },
                });
            }
            continue;
        }
        // String literal
        if (ch === "'") {
            const start = pos;
            pos++; // opening quote
            while (pos < source.length && source[pos] !== "'")
                pos++;
            if (pos >= source.length) {
                // Unterminated — emit an error token covering everything from
                // the opening quote onward.
                tokens.push({
                    kind: "error",
                    text: source.slice(start, pos),
                    span: { start, end: pos },
                });
            }
            else {
                pos++; // closing quote
                tokens.push({
                    kind: "string",
                    text: source.slice(start, pos),
                    span: { start, end: pos },
                });
            }
            continue;
        }
        // Operators
        if (ch === "!") {
            if (source[pos + 1] === "=") {
                tokens.push({
                    kind: "operator",
                    text: "!=",
                    span: { start: pos, end: pos + 2 },
                });
                pos += 2;
            }
            else {
                tokens.push({
                    kind: "error",
                    text: ch,
                    span: { start: pos, end: pos + 1 },
                });
                pos++;
            }
            continue;
        }
        if (ch === "=") {
            tokens.push({
                kind: "operator",
                text: "=",
                span: { start: pos, end: pos + 1 },
            });
            pos++;
            continue;
        }
        if (ch === ">" || ch === "<") {
            if (source[pos + 1] === "=") {
                tokens.push({
                    kind: "operator",
                    text: ch + "=",
                    span: { start: pos, end: pos + 2 },
                });
                pos += 2;
            }
            else {
                tokens.push({
                    kind: "operator",
                    text: ch,
                    span: { start: pos, end: pos + 1 },
                });
                pos++;
            }
            continue;
        }
        // Punctuation
        if (ch === "(" ||
            ch === ")" ||
            ch === "," ||
            ch === ";" ||
            ch === ":") {
            tokens.push({
                kind: "punctuation",
                text: ch,
                span: { start: pos, end: pos + 1 },
            });
            pos++;
            continue;
        }
        // Unrecognized
        tokens.push({
            kind: "error",
            text: ch,
            span: { start: pos, end: pos + 1 },
        });
        pos++;
    }
    // EOF marker — convenient for the parser, zero-width span at the end
    tokens.push({ kind: "eof", text: "", span: { start: pos, end: pos } });
    return tokens;
}
function isWhitespace(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}
function isWordStart(ch) {
    return ((ch >= "A" && ch <= "Z") ||
        (ch >= "a" && ch <= "z") ||
        ch === "_");
}
function isWordCont(ch) {
    return isWordStart(ch) || isDigit(ch);
}
function isDigit(ch) {
    return ch !== undefined && ch >= "0" && ch <= "9";
}
