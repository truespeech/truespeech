import type { OverClause, TimeLiteral, Constraint, Grain } from "./ast.js";
import type { ResolvedRegion, ResolvedConstraint, LexiconMatch, RowDecoration, GroupByClause } from "./adapters.js";
export declare function resolveRegion(over: OverClause, primaryTimeField: string | null): ResolvedRegion;
export declare function resolveConstraint(c: Constraint): ResolvedConstraint;
export declare function intersectRegions(a: ResolvedRegion, b: ResolvedRegion): ResolvedRegion | null;
export declare function renderTimeRegion(start: string, end: string): string;
export declare function renderRegion(region: ResolvedRegion): string;
export declare function formatTimeBucket(isoStart: string, grain: Grain): string;
export declare function endOfBucket(isoStart: string, grain: Grain): string;
export declare function firstDayOf(lit: TimeLiteral): string;
export declare function lastDayOf(lit: TimeLiteral): string;
export declare function pad2(n: number): string;
export declare function daysInMonth(year: number, month: number): number;
export interface RowRegion {
    timeStart: string;
    timeEnd: string;
    dimValues: Record<string, string | number>;
}
export declare function buildRowRegion(row: (string | number | null)[], groupBys: GroupByClause[], queryRegion: ResolvedRegion): RowRegion;
export declare function rowMatchesImpact(row: RowRegion, impact: ResolvedRegion): boolean;
export declare function crossesBoundary(row: RowRegion, boundary: {
    at: string;
    constraints: ResolvedConstraint[];
}): boolean;
export declare function decorationsFor(rows: (string | number | null)[][], matches: LexiconMatch[], groupBys: GroupByClause[], queryRegion: ResolvedRegion): RowDecoration[];
