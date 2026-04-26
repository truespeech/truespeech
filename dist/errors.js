// Error model for True Speech.
//
// Errors are data, not exceptions. The tokenizer, parser, and validator
// all collect TrueSpeechError values rather than throwing — the editor
// surface needs them as data, and execute() composes them and only
// throws (via TrueSpeechExecutionError) at the boundary where a caller
// asked for a result.
//
// Every error carries a span (so the renderer can produce Rust-style
// caret diagnostics) and an optional help message (for actionable
// suggestions like "did you mean X?").
import { positionAt } from "./source.js";
export function makeError(args) {
    const error = {
        code: args.code,
        message: args.message,
        span: args.span,
    };
    if (args.notes && args.notes.length > 0)
        error.notes = args.notes;
    if (args.help !== undefined)
        error.help = args.help;
    if (args.relatedSpans && args.relatedSpans.length > 0) {
        error.relatedSpans = args.relatedSpans;
    }
    return error;
}
// Thrown by TrueSpeech.execute() when any phase produced errors.
// Wraps the full error list so callers can inspect or re-render them.
export class TrueSpeechExecutionError extends Error {
    errors;
    constructor(errors) {
        super(summarize(errors));
        this.name = "TrueSpeechExecutionError";
        this.errors = errors;
    }
}
function summarize(errors) {
    if (errors.length === 0)
        return "no errors";
    if (errors.length === 1) {
        return `${errors[0].code}: ${errors[0].message}`;
    }
    return `${errors.length} errors (first: ${errors[0].code}: ${errors[0].message})`;
}
// Render a single error in a Rust-style caret diagnostic.
//
// Output format (rough):
//
//   error[unknown_metric]: Unknown metric "total_sals"
//     --> 1:9
//   1 | COMPUTE total_sals OVER 2026-02
//     |         ^^^^^^^^^^
//     = help: did you mean "total_sales"?
//
export function renderError(error, source) {
    const start = positionAt(source, error.span.start);
    const end = positionAt(source, Math.max(error.span.start, error.span.end - 1));
    const lines = source.split("\n");
    const out = [];
    out.push(`error[${error.code}]: ${error.message}`);
    out.push(`  --> ${start.line}:${start.column}`);
    // Render the affected line(s) with a caret underline.
    // For multi-line spans we underline only the first line and note continuation.
    const line = lines[start.line - 1] ?? "";
    const lineNumStr = String(start.line);
    const gutter = " ".repeat(lineNumStr.length);
    out.push(`${gutter} |`);
    out.push(`${lineNumStr} | ${line}`);
    // start.column / end.column are 1-indexed positions of the first and
    // last characters in the span; caretStart is 0-indexed.
    const caretStart = start.column - 1;
    const caretEnd = start.line === end.line ? end.column : line.length;
    const caretLen = Math.max(1, caretEnd - caretStart);
    out.push(`${gutter} | ${" ".repeat(caretStart)}${"^".repeat(caretLen)}`);
    if (error.notes) {
        for (const note of error.notes) {
            out.push(`${gutter} = note: ${note}`);
        }
    }
    if (error.help) {
        out.push(`${gutter} = help: ${error.help}`);
    }
    if (error.relatedSpans) {
        for (const related of error.relatedSpans) {
            const rp = positionAt(source, related.span.start);
            out.push(`${gutter} = ${related.label} (at ${rp.line}:${rp.column})`);
        }
    }
    return out.join("\n");
}
export function renderErrors(errors, source) {
    return errors.map((e) => renderError(e, source)).join("\n\n");
}
