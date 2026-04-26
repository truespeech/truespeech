import type { Statement } from "./ast.js";
import type { SemanticLayerAdapter, DatabaseAdapter } from "./adapters.js";
import type { TrueSpeechError } from "./errors.js";
import type { ExecuteResult } from "./execute.js";
import type { Token } from "./tokens.js";
export type { Statement, ComputeStatement, MetricRef, Identifier, OverClause, TimeRegion, AllTimeRegion, CalendarRegion, RangeRegion, UntilRegion, SinceRegion, TimeLiteral, CalendarUnit, Constraint, ConstraintPredicate, ComparisonPredicate, ComparisonOperator, InSetPredicate, InTimeRegionPredicate, NotInSetPredicate, ConstraintValue, StringValue, NumberValue, TimeLiteralValue, GroupByClause, Grain, BareGrainGroupBy, DimensionGroupBy, TimeDimensionGroupBy, OrderByClause, OrderDirection, NumberLiteral, } from "./ast.js";
export type { SemanticLayerAdapter, DatabaseAdapter, MetricInfo, DimensionInfo, SemanticQuery, WhereClause, WhereOperator, GroupByClause as SemanticGroupByClause, OrderByClause as SemanticOrderByClause, QueryResult, } from "./adapters.js";
export type { Token, TokenKind } from "./tokens.js";
export type { Span, Position } from "./source.js";
export type { TrueSpeechError, ErrorCode, RelatedSpan, } from "./errors.js";
export type { ExecuteResult } from "./execute.js";
export { TrueSpeechExecutionError, renderError, renderErrors, } from "./errors.js";
export { resultColumnNames } from "./validate.js";
export { osiAdapter } from "./osi-adapter.js";
export type { OsiLikeRuntime } from "./osi-adapter.js";
export interface TrueSpeechOptions {
    semanticLayer: SemanticLayerAdapter;
    database: DatabaseAdapter;
}
export interface ParseResult {
    ast: Statement | null;
    errors: TrueSpeechError[];
}
export interface ValidateResult {
    errors: TrueSpeechError[];
}
export declare class TrueSpeech {
    private opts;
    constructor(opts: TrueSpeechOptions);
    tokenize(source: string): Token[];
    parse(source: string): ParseResult;
    validate(ast: Statement): ValidateResult;
    execute(source: string): Promise<ExecuteResult>;
}
export declare const VERSION = "0.1.0";
