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

export type Statement =
  | ComputeStatement
  | RegisterStatement
  | CheckStatement
  | ShowStatement
  | UnregisterStatement;

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
// REGISTER comes in multiple shapes, discriminated by `entryKind`.
//
// `region`: a patch of dimensional space (time interval + optional
// categorical constraints) over which one or more metrics are affected.
// May carry multiple IMPACTING clauses — the multi-metric shorthand
// requires the listed metrics to share a primary time dimension.
//
// `boundary`: a cut at an instant that partitions the dimensional space.
// A single AT date applies to all impacted metrics. Optional categorical
// constraints scope the cut to a sub-population (e.g. "LTV calculation
// changed Jan 1 for the government tier"). Triggers when a query's
// computed value mixes inputs from both sides of the cut.
export type RegisterStatement =
  | RegisterRegionStatement
  | RegisterBoundaryStatement;

export interface RegisterRegionStatement {
  kind: "register";
  entryKind: "region";
  name: Identifier;
  impactClauses: ImpactClause[];
  description: StringLiteral;
  span: Span;
}

export interface RegisterBoundaryStatement {
  kind: "register";
  entryKind: "boundary";
  name: Identifier;
  // The instant the cut sits at. Day-form only for v1 (a quarter or
  // month wouldn't be a literal cut — it's a range).
  at: TimeLiteral;
  // Optional categorical scoping for the cut (e.g. AND product_tier =
  // 'government'). Empty array if the cut applies across all dim values.
  constraints: Constraint[];
  // Metrics affected by this cut. Single AT applies to all of them.
  metrics: MetricRef[];
  // Mandatory regime descriptions. Two string literals each: a short
  // label (rendered inline in tables) and a long-form description
  // (rendered in reconciliation/historical footers).
  before: RegimeDescription;
  after: RegimeDescription;
  // Optional WITH "<change>": overrides the runtime-composed change
  // sentence in straddling/spanning footers. When absent, the runtime
  // composes the wording from `before` and `after`.
  changeDescription?: StringLiteral;
  span: Span;
}

export interface RegimeDescription {
  label: StringLiteral;       // short — e.g. "old definition"
  description: StringLiteral; // long-form prose
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

// SHOW LEXICON [<name>[, <name>...]]    — list every lexicon entry,
//                                          or narrow to the named
//                                          ones (one or more).
// SHOW SCHEMA                            — list metrics and the
//                                          dimensions available on
//                                          each.
//
// `subject` is a soft keyword (identifier-classified at tokenize time)
// dispatched here by text, mirroring how REGISTER picks region /
// boundary. `filters` is only meaningful for `subject === "lexicon"`;
// omitted means "every entry," a non-empty list narrows to those
// specific names. Names that don't match any entry are silently
// dropped from the result (consistent with the v0.4 single-name
// "no entry" behavior).
export interface ShowStatement {
  kind: "show";
  subject: "lexicon" | "schema";
  filters?: Identifier[];
  span: Span;
}

// UNREGISTER <name> — drop a lexicon entry by name. Kind is not
// required; the runtime matches by name regardless of region vs.
// boundary. Non-throwing — the result carries `found: false` if no
// entry by that name existed.
export interface UnregisterStatement {
  kind: "unregister";
  name: Identifier;
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
