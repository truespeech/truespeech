import type { Span } from "./source.js";
export type ErrorCode = "unexpected_character" | "unterminated_string" | "malformed_time_literal" | "malformed_number" | "unexpected_token" | "expected_token" | "unexpected_eof" | "unknown_metric" | "unknown_dimension" | "missing_primary_time" | "incompatible_metrics" | "grain_required" | "invalid_calendar_unit" | "range_start_after_end" | "mixed_unit_range" | "order_by_unknown_field" | "duplicate_metric" | "execution_failure";
export interface RelatedSpan {
    span: Span;
    label: string;
}
export interface TrueSpeechError {
    code: ErrorCode;
    message: string;
    span: Span;
    notes?: string[];
    help?: string;
    relatedSpans?: RelatedSpan[];
}
export interface MakeErrorArgs {
    code: ErrorCode;
    message: string;
    span: Span;
    notes?: string[];
    help?: string;
    relatedSpans?: RelatedSpan[];
}
export declare function makeError(args: MakeErrorArgs): TrueSpeechError;
export declare class TrueSpeechExecutionError extends Error {
    readonly errors: readonly TrueSpeechError[];
    constructor(errors: TrueSpeechError[]);
}
export declare function renderError(error: TrueSpeechError, source: string): string;
export declare function renderErrors(errors: TrueSpeechError[], source: string): string;
