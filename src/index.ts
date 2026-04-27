// Public API for the True Speech runtime.
//
// Phase 1 supports the COMPUTE statement only. The runtime is composed
// from four pure phases (tokenize → parse → validate → execute) which
// are all exposed individually so editor surfaces (syntax highlighting,
// inline error squigglies, completions) can plug in without re-running
// execute() on every keystroke.

import type { Statement } from "./ast.js";
import type {
  SemanticLayerAdapter,
  DatabaseAdapter,
  LexiconAdapter,
} from "./adapters.js";
import type { TrueSpeechError } from "./errors.js";
import type { ExecuteResult } from "./execute.js";
import type { Token } from "./tokens.js";

import { tokenize as tokenizeSource } from "./tokenize.js";
import { parse as parseTokens } from "./parse.js";
import { validate as validateAst } from "./validate.js";
import { execute as executeAst } from "./execute.js";
import { TrueSpeechExecutionError } from "./errors.js";

// ===== Re-exports =====

export type {
  Statement,
  ComputeStatement,
  MetricRef,
  Identifier,
  OverClause,
  TimeRegion,
  AllTimeRegion,
  CalendarRegion,
  RangeRegion,
  UntilRegion,
  SinceRegion,
  TimeLiteral,
  CalendarUnit,
  Constraint,
  ConstraintPredicate,
  ComparisonPredicate,
  ComparisonOperator,
  InSetPredicate,
  InTimeRegionPredicate,
  NotInSetPredicate,
  ConstraintValue,
  StringValue,
  NumberValue,
  TimeLiteralValue,
  GroupByClause,
  Grain,
  BareGrainGroupBy,
  DimensionGroupBy,
  TimeDimensionGroupBy,
  OrderByClause,
  OrderDirection,
  NumberLiteral,
} from "./ast.js";

export type {
  SemanticLayerAdapter,
  DatabaseAdapter,
  LexiconAdapter,
  LexiconEntry,
  Impact,
  ResolvedRegion,
  ResolvedConstraint,
  LexiconMatch,
  MetricInfo,
  DimensionInfo,
  SemanticQuery,
  WhereClause,
  WhereOperator,
  GroupByClause as SemanticGroupByClause,
  OrderByClause as SemanticOrderByClause,
  QueryResult,
} from "./adapters.js";

export type { Token, TokenKind } from "./tokens.js";
export type { Span, Position } from "./source.js";
export type {
  TrueSpeechError,
  ErrorCode,
  RelatedSpan,
} from "./errors.js";
export type {
  ExecuteResult,
  ExecuteOpts,
  ComputeResult,
  RegisterResult,
  CheckResult,
} from "./execute.js";

export {
  TrueSpeechExecutionError,
  renderError,
  renderErrors,
} from "./errors.js";

export { resultColumnNames } from "./validate.js";

export {
  resolveRegion,
  intersectRegions,
  renderRegion,
  renderTimeRegion,
  formatTimeBucket,
  endOfBucket,
} from "./region.js";

export { osiAdapter } from "./osi-adapter.js";
export type { OsiLikeRuntime } from "./osi-adapter.js";

// ===== TrueSpeech class =====

export interface TrueSpeechOptions {
  semanticLayer: SemanticLayerAdapter;
  database: DatabaseAdapter;
  lexicon?: LexiconAdapter;
}

export interface ParseResult {
  ast: Statement | null;
  errors: TrueSpeechError[];
}

export interface ValidateResult {
  errors: TrueSpeechError[];
}

export class TrueSpeech {
  constructor(private opts: TrueSpeechOptions) {}

  // Lexical analysis. Pure. Always returns a Token[] (with error tokens
  // for unrecognized characters and an EOF token at the end).
  tokenize(source: string): Token[] {
    return tokenizeSource(source);
  }

  // Syntactic parsing. Pure. Always returns both an AST (or null if the
  // structure was unrecoverable) and the list of parse errors.
  parse(source: string): ParseResult {
    return parseTokens(this.tokenize(source));
  }

  // Semantic validation against the configured semantic-layer model.
  // Pure. Always returns a list (possibly empty) of validation errors.
  validate(ast: Statement): ValidateResult {
    return { errors: validateAst(ast, this.opts.semanticLayer) };
  }

  // Compose all four phases. Throws TrueSpeechExecutionError if any
  // phase produced errors — the editor should call the individual
  // phase methods if it needs errors-as-data.
  async execute(source: string): Promise<ExecuteResult> {
    const { ast, errors: parseErrors } = this.parse(source);
    if (parseErrors.length > 0) {
      throw new TrueSpeechExecutionError(parseErrors);
    }
    if (!ast) {
      throw new TrueSpeechExecutionError([
        {
          code: "unexpected_eof",
          message: "Source produced no statement",
          span: { start: 0, end: source.length },
        },
      ]);
    }
    const { errors: validateErrors } = this.validate(ast);
    if (validateErrors.length > 0) {
      throw new TrueSpeechExecutionError(validateErrors);
    }
    return executeAst(ast, {
      semanticLayer: this.opts.semanticLayer,
      database: this.opts.database,
      lexicon: this.opts.lexicon,
    });
  }
}

export const VERSION = "0.1.0";
