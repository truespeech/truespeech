import type { Span } from "./source.js";
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
export interface RegisterStatement {
    kind: "register";
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
export interface CheckStatement {
    kind: "check";
    metrics: MetricRef[];
    over: OverClause;
    span: Span;
}
export interface StringLiteral {
    value: string;
    text: string;
    span: Span;
}
export interface MetricRef {
    name: string;
    span: Span;
}
export interface Identifier {
    name: string;
    span: Span;
}
export interface OverClause {
    primaryTime: TimeRegion;
    constraints: Constraint[];
    span: Span;
}
export type TimeRegion = AllTimeRegion | CalendarRegion | RangeRegion | UntilRegion | SinceRegion;
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
export interface Constraint {
    dimension: Identifier;
    predicate: ConstraintPredicate;
    span: Span;
}
export type ConstraintPredicate = ComparisonPredicate | InSetPredicate | InTimeRegionPredicate | NotInSetPredicate;
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
export type ConstraintValue = StringValue | NumberValue | TimeLiteralValue;
export interface StringValue {
    kind: "string";
    value: string;
    text: string;
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
export type GroupByClause = BareGrainGroupBy | DimensionGroupBy | TimeDimensionGroupBy;
export type Grain = "day" | "week" | "month" | "quarter" | "year";
export interface BareGrainGroupBy {
    kind: "bare-grain";
    grain: Grain;
    span: Span;
}
export interface DimensionGroupBy {
    kind: "dimension";
    dimension: Identifier;
    span: Span;
}
export interface TimeDimensionGroupBy {
    kind: "time-dimension";
    dimension: Identifier;
    grain: Grain;
    span: Span;
}
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
