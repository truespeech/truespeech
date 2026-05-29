import type { Statement } from "./ast.js";
import type { SemanticLayerAdapter, DatabaseAdapter, LexiconAdapter } from "./adapters.js";
import type { TrueSpeechError } from "./errors.js";
import type { ExecuteResult } from "./execute.js";
import type { Token } from "./tokens.js";
import type { CompletionResult } from "./adapters.js";
export type { Statement, ComputeStatement, RegisterStatement, RegisterRegionStatement, RegisterBoundaryStatement, ImpactClause, RegimeDescription as AstRegimeDescription, StringLiteral, CheckStatement, ShowStatement, UnregisterStatement, MetricRef, Identifier, OverClause, TimeRegion, AllTimeRegion, CalendarRegion, RangeRegion, UntilRegion, SinceRegion, TimeLiteral, CalendarUnit, Constraint, ConstraintPredicate, ComparisonPredicate, ComparisonOperator, InSetPredicate, InTimeRegionPredicate, NotInSetPredicate, ConstraintValue, StringValue, NumberValue, TimeLiteralValue, GroupByClause, Grain, BareGrainGroupBy, DimensionGroupBy, TimeDimensionGroupBy, OrderByClause, OrderDirection, NumberLiteral, } from "./ast.js";
export type { SemanticLayerAdapter, DatabaseAdapter, LexiconAdapter, LexiconEntry, RegionLexiconEntry, BoundaryLexiconEntry, RegimeDescription, Impact, ResolvedRegion, ResolvedConstraint, LexiconMatch, RegionMatch, BoundaryMatch, BoundarySide, RowDecoration, HistoricalNote, MetricInfo, DimensionInfo, SemanticQuery, WhereClause, WhereOperator, GroupByClause as SemanticGroupByClause, OrderByClause as SemanticOrderByClause, QueryResult, Completion, CompletionKind, CompletionResult, } from "./adapters.js";
export type { Token, TokenKind } from "./tokens.js";
export type { Span, Position } from "./source.js";
export type { TrueSpeechError, ErrorCode, RelatedSpan, } from "./errors.js";
export type { ExecuteResult, ExecuteOpts, ComputeResult, RegisterResult, CheckResult, ShowLexiconResult, ShowSchemaResult, MetricSummary, UnregisterResult, } from "./execute.js";
export { TrueSpeechExecutionError, renderError, renderErrors, } from "./errors.js";
export { resultColumnNames } from "./validate.js";
export { resolveRegion, intersectRegions, renderRegion, renderTimeRegion, formatTimeBucket, endOfBucket, buildRowRegion, rowMatchesImpact, crossesBoundary, classifyRowAgainstBoundary, decorationsFor, } from "./region.js";
export type { RowRegion } from "./region.js";
export { osiAdapter } from "./osi-adapter.js";
export type { OsiLikeRuntime } from "./osi-adapter.js";
export interface TrueSpeechOptions {
    semanticLayer: SemanticLayerAdapter;
    database: DatabaseAdapter;
    lexicon?: LexiconAdapter;
    timeLiteralYears?: number[];
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
    complete(source: string, position: number): Promise<CompletionResult>;
    execute(source: string): Promise<ExecuteResult>;
}
export declare const VERSION = "0.7.0";
