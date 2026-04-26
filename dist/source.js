// Source positions and spans.
//
// A Span is a half-open character range into the source string,
// suitable for slicing and for error rendering.
//
// Position is the human-friendly view (line, column) and is computed
// lazily from a Span via positionAt — we keep Spans cheap and only
// pay for line/column when actually rendering an error.
export function span(start, end) {
    return { start, end };
}
// Combine two spans into one that covers both. Useful in the parser
// when an AST node spans from its first token to its last.
export function spanFrom(first, last) {
    return { start: first.start, end: last.end };
}
export function positionAt(source, offset) {
    let line = 1;
    let column = 1;
    for (let i = 0; i < offset && i < source.length; i++) {
        if (source[i] === "\n") {
            line++;
            column = 1;
        }
        else {
            column++;
        }
    }
    return { offset, line, column };
}
