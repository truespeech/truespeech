// Abstract syntax tree for True Speech statements.
//
// Statement is a discriminated union — phase 1 has only ComputeStatement,
// but the structure makes adding RegisterStatement / CheckStatement (and
// any future statement kinds) a matter of new variants and parsing rules,
// not restructuring.
//
// Every node carries a `span` referring back to its source range. This
// is what makes Rust-style error rendering possible — the validator can
// point precisely at the offending sub-expression.

import type { Span } from "./source.js";

// ===== Top-level =====

export type Statement = ComputeStatement | RegisterStatement | CheckStatement;

export interface ComputeStatement {
  kind: "compute";
  metrics: MetricRef[];
  over: OverClause;
  groupBy?: GroupByClause[];
  orderBy?: OrderByClause[];
  limit?: NumberLiteral;
  span: Span;
}

// REGISTER <name> IMPACTING <metric>[, <metric>...] OVER <region>
//                 [IMPACTING ... OVER ...]...
//                 WITH <description-string>
//
// Each ImpactClause may carry multiple metrics (the multi-metric
// shorthand) — the validator enforces that those metrics share a
// primary time dimension. The parser stores the raw structure;
// expansion to per-metric Impacts happens at execute time.
export interface RegisterStatement {
  kind: "register";
  // The lexicon entry kind being registered. Currently only "region";
  // future work will add other shapes (e.g. "boundary" for cuts that
  // partition the dimensional space rather than patches within it).
  // Made explicit at parse time so the language can grow without a
  // retroactive break.
  entryKind: "region";
  name: Identifier;
  impactClauses: ImpactClause[];
  description: StringLiteral;
  span: Span;
}

export interface ImpactClause {
  metrics: MetricRef[];
  over: OverClause;
  span: Span;
}

// CHECK <metric>[, <metric>...] OVER <region>
//
// Always requires OVER (use `OVER all time` for unbounded). Multi-
// metric form requires shared primary time, same rule as COMPUTE.
export interface CheckStatement {
  kind: "check";
  metrics: MetricRef[];
  over: OverClause;
  span: Span;
}

export interface StringLiteral {
  value: string; // unquoted
  text: string; // including quotes (' or ")
  span: Span;
}

// ===== References =====

export interface MetricRef {
  name: string;
  span: Span;
}

export interface Identifier {
  name: string;
  span: Span;
}

// ===== OVER clause =====

export interface OverClause {
  primaryTime: TimeRegion;
  constraints: Constraint[];
  span: Span;
}

export type TimeRegion =
  | AllTimeRegion
  | CalendarRegion
  | RangeRegion
  | UntilRegion
  | SinceRegion;

export interface AllTimeRegion {
  kind: "all-time";
  span: Span;
}

export interface CalendarRegion {
  kind: "calendar";
  literal: TimeLiteral;
  span: Span;
}

export interface RangeRegion {
  kind: "range";
  start: TimeLiteral;
  end: TimeLiteral;
  span: Span;
}

export interface UntilRegion {
  kind: "until";
  bound: TimeLiteral;
  span: Span;
}

export interface SinceRegion {
  kind: "since";
  bound: TimeLiteral;
  span: Span;
}

// Parsed time literal. The tokenizer captures the lexical text; the
// parser turns it into this structured form. Validator checks that
// quarter is 1-4, month is 1-12, and day is valid for the given month.

export type CalendarUnit = "year" | "quarter" | "month" | "day";

export interface TimeLiteral {
  unit: CalendarUnit;
  year: number;
  quarter?: number;
  month?: number;
  day?: number;
  text: string;
  span: Span;
}

// ===== Additional constraints (everything in OVER after the primary time clause) =====

export interface Constraint {
  dimension: Identifier;
  predicate: ConstraintPredicate;
  span: Span;
}

export type ConstraintPredicate =
  | ComparisonPredicate
  | InSetPredicate
  | InTimeRegionPredicate
  | NotInSetPredicate;

export type ComparisonOperator = "=" | "!=" | ">" | "<" | ">=" | "<=";

export interface ComparisonPredicate {
  kind: "comparison";
  operator: ComparisonOperator;
  value: ConstraintValue;
  span: Span;
}

export interface InSetPredicate {
  kind: "in-set";
  values: ConstraintValue[];
  span: Span;
}

export interface InTimeRegionPredicate {
  kind: "in-time-region";
  region: CalendarRegion | RangeRegion;
  span: Span;
}

export interface NotInSetPredicate {
  kind: "not-in-set";
  values: ConstraintValue[];
  span: Span;
}

export type ConstraintValue =
  | StringValue
  | NumberValue
  | TimeLiteralValue;

export interface StringValue {
  kind: "string";
  value: string; // unquoted
  text: string; // original including quotes
  span: Span;
}

export interface NumberValue {
  kind: "number";
  value: number;
  text: string;
  span: Span;
}

export interface TimeLiteralValue {
  kind: "time-literal";
  literal: TimeLiteral;
  span: Span;
}

// ===== GROUP BY =====

export type GroupByClause =
  | BareGrainGroupBy
  | DimensionGroupBy
  | TimeDimensionGroupBy;

export type Grain = "day" | "week" | "month" | "quarter" | "year";

// `GROUP BY month` — bare grain implicitly references the metric's
// primary time dimension at that grain.
export interface BareGrainGroupBy {
  kind: "bare-grain";
  grain: Grain;
  span: Span;
}

// `GROUP BY region`
export interface DimensionGroupBy {
  kind: "dimension";
  dimension: Identifier;
  span: Span;
}

// `GROUP BY ship_date:week` — explicit time dimension with grain
export interface TimeDimensionGroupBy {
  kind: "time-dimension";
  dimension: Identifier;
  grain: Grain;
  span: Span;
}

// ===== ORDER BY / LIMIT =====

export type OrderDirection = "asc" | "desc";

export interface OrderByClause {
  field: Identifier;
  direction: OrderDirection;
  span: Span;
}

export interface NumberLiteral {
  value: number;
  text: string;
  span: Span;
}
