// Region utilities — the pure-math layer beneath CHECK, REGISTER, and
// COMPUTE reconciliation.
//
// Three operations:
//   - resolveRegion: AST OverClause × primary-time-field-name → ResolvedRegion
//                    (the time mini-language gets expanded to a date interval;
//                    constraints get normalized.)
//   - intersectRegions: two ResolvedRegions → ResolvedRegion | null
//                    (returns null if the time intervals don't overlap.)
//   - renderTimeRegion / renderRegion: ResolvedRegion → human-friendly DSL text
//                    (find the coarsest calendar unit at which both endpoints
//                    align; fall through to day-level when they don't.)

import type {
  OverClause,
  TimeRegion,
  TimeLiteral,
  Constraint,
  ConstraintValue,
} from "./ast.js";
import type {
  ResolvedRegion,
  ResolvedConstraint,
  WhereOperator,
} from "./adapters.js";

// ===== Resolution: AST → ResolvedRegion =====

export function resolveRegion(
  over: OverClause,
  primaryTimeField: string | null
): ResolvedRegion {
  const { start, end } = resolveTime(over.primaryTime);
  const constraints: ResolvedConstraint[] = [];
  for (const c of over.constraints) {
    constraints.push(resolveConstraint(c));
  }
  return {
    timeStart: start,
    timeEnd: end,
    constraints,
  };
  // Note: primaryTimeField is accepted for symmetry with how callers
  // think about regions (per-metric, anchored to the metric's primary
  // time). The ResolvedRegion itself doesn't store the field name —
  // the binding lives at the Impact level via the metric reference.
  // The parameter is here to make the call site self-documenting.
  void primaryTimeField;
}

function resolveTime(region: TimeRegion): { start: string; end: string } {
  switch (region.kind) {
    case "all-time":
      // Sentinel range covering everything we'd plausibly see. The
      // executor uses this for SQL filtering only when needed; for
      // reconciliation it just behaves as "any interval intersects this".
      return { start: "0001-01-01", end: "9999-12-31" };
    case "calendar":
      return { start: firstDayOf(region.literal), end: lastDayOf(region.literal) };
    case "range":
      return { start: firstDayOf(region.start), end: lastDayOf(region.end) };
    case "until":
      return { start: "0001-01-01", end: lastDayOf(region.bound) };
    case "since":
      return { start: firstDayOf(region.bound), end: "9999-12-31" };
  }
}

function resolveConstraint(c: Constraint): ResolvedConstraint {
  const dim = c.dimension.name;
  const pred = c.predicate;
  switch (pred.kind) {
    case "comparison": {
      const value = resolveValue(pred.value);
      return { dimension: dim, operator: pred.operator, value };
    }
    case "in-set": {
      const values = pred.values.map(resolveValue) as (string | number)[];
      return { dimension: dim, operator: "in", value: values };
    }
    case "not-in-set": {
      const values = pred.values.map(resolveValue) as (string | number)[];
      return { dimension: dim, operator: "not_in", value: values };
    }
    case "in-time-region": {
      // Time-containment translates to a closed-interval pair, but for
      // a *secondary* dim we surface it as a range. We collapse to a
      // single >=/<= pair via two constraints — but ResolvedConstraint
      // is a single predicate. Easiest: emit start as ">=" and treat
      // end via a sibling constraint at the executor level. For region
      // resolution we keep it as a single descriptor for display, with
      // value as the inclusive interval start; executor expands to a
      // pair of WHERE clauses.
      const r = pred.region;
      const start = r.kind === "calendar" ? firstDayOf(r.literal) : firstDayOf(r.start);
      const end = r.kind === "calendar" ? lastDayOf(r.literal) : lastDayOf(r.end);
      return {
        dimension: dim,
        operator: "in",
        value: [start, end],
      };
    }
  }
}

function resolveValue(v: ConstraintValue): string | number {
  if (v.kind === "string") return v.value;
  if (v.kind === "number") return v.value;
  return firstDayOf(v.literal);
}

// ===== Intersection =====
//
// Two regions overlap if their time intervals overlap. The intersected
// region's time is the inner bounds (max of starts, min of ends); its
// constraints are the union of both sides' constraints (deduped by
// equality). If time intervals don't overlap, returns null.

export function intersectRegions(
  a: ResolvedRegion,
  b: ResolvedRegion
): ResolvedRegion | null {
  const start = a.timeStart > b.timeStart ? a.timeStart : b.timeStart;
  const end = a.timeEnd < b.timeEnd ? a.timeEnd : b.timeEnd;
  if (start > end) return null;

  const seen = new Set<string>();
  const constraints: ResolvedConstraint[] = [];
  for (const c of [...a.constraints, ...b.constraints]) {
    const key = constraintKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    constraints.push(c);
  }

  return { timeStart: start, timeEnd: end, constraints };
}

function constraintKey(c: ResolvedConstraint): string {
  return `${c.dimension}|${c.operator}|${JSON.stringify(c.value)}`;
}

// ===== Pretty-printing =====
//
// Find the coarsest calendar unit at which both endpoints align. When
// nothing coarser than days fits, fall through to day-level. Matches
// the surface mini-language exactly.

export function renderTimeRegion(start: string, end: string): string {
  if (start === end) return start;

  // Year alignment
  if (isFirstDayOfYear(start) && isLastDayOfYear(end)) {
    const sy = year(start);
    const ey = year(end);
    return sy === ey ? `${sy}` : `${sy} to ${ey}`;
  }

  // Quarter alignment
  if (isFirstDayOfQuarter(start) && isLastDayOfQuarter(end)) {
    const sq = quarterLabel(start);
    const eq = quarterLabel(end);
    return sq === eq ? sq : `${sq} to ${eq}`;
  }

  // Month alignment
  if (isFirstDayOfMonth(start) && isLastDayOfMonth(end)) {
    const sm = monthLabel(start);
    const em = monthLabel(end);
    return sm === em ? sm : `${sm} to ${em}`;
  }

  // Day-level fallthrough
  return `${start} to ${end}`;
}

export function renderRegion(region: ResolvedRegion): string {
  const time = renderTimeRegion(region.timeStart, region.timeEnd);
  if (region.constraints.length === 0) return time;
  return [time, ...region.constraints.map(renderConstraint)].join(" AND ");
}

function renderConstraint(c: ResolvedConstraint): string {
  if (c.operator === "in" || c.operator === "not_in") {
    const op = c.operator === "in" ? "IN" : "NOT IN";
    const values = Array.isArray(c.value) ? c.value : [c.value];
    return `${c.dimension} ${op} (${values.map(formatValue).join(", ")})`;
  }
  // Comparison operators are always single-valued.
  const v = Array.isArray(c.value) ? c.value[0] : c.value;
  return `${c.dimension} ${c.operator} ${formatValue(v)}`;
}

function formatValue(v: string | number): string {
  if (typeof v === "number") return String(v);
  // Heuristic: ISO date passes through unquoted; everything else quoted.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return `'${v}'`;
}

// ===== Date helpers =====

export function firstDayOf(lit: TimeLiteral): string {
  switch (lit.unit) {
    case "year":
      return iso(lit.year, 1, 1);
    case "quarter": {
      const q = lit.quarter ?? 1;
      const month = (q - 1) * 3 + 1;
      return iso(lit.year, month, 1);
    }
    case "month":
      return iso(lit.year, lit.month ?? 1, 1);
    case "day":
      return iso(lit.year, lit.month ?? 1, lit.day ?? 1);
  }
}

export function lastDayOf(lit: TimeLiteral): string {
  switch (lit.unit) {
    case "year":
      return iso(lit.year, 12, 31);
    case "quarter": {
      const q = lit.quarter ?? 1;
      const lastMonth = q * 3;
      return iso(lit.year, lastMonth, daysInMonth(lit.year, lastMonth));
    }
    case "month": {
      const m = lit.month ?? 1;
      return iso(lit.year, m, daysInMonth(lit.year, m));
    }
    case "day":
      return iso(lit.year, lit.month ?? 1, lit.day ?? 1);
  }
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function year(iso: string): number {
  return parseInt(iso.slice(0, 4), 10);
}

function month(iso: string): number {
  return parseInt(iso.slice(5, 7), 10);
}

function day(iso: string): number {
  return parseInt(iso.slice(8, 10), 10);
}

function isFirstDayOfYear(iso: string): boolean {
  return month(iso) === 1 && day(iso) === 1;
}

function isLastDayOfYear(iso: string): boolean {
  return month(iso) === 12 && day(iso) === 31;
}

function isFirstDayOfQuarter(iso: string): boolean {
  const m = month(iso);
  return day(iso) === 1 && (m === 1 || m === 4 || m === 7 || m === 10);
}

function isLastDayOfQuarter(iso: string): boolean {
  const m = month(iso);
  return (
    day(iso) === daysInMonth(year(iso), m) &&
    (m === 3 || m === 6 || m === 9 || m === 12)
  );
}

function isFirstDayOfMonth(iso: string): boolean {
  return day(iso) === 1;
}

function isLastDayOfMonth(iso: string): boolean {
  return day(iso) === daysInMonth(year(iso), month(iso));
}

function quarterLabel(iso: string): string {
  const m = month(iso);
  const q = Math.floor((m - 1) / 3) + 1;
  return `${year(iso)}-Q${q}`;
}

function monthLabel(iso: string): string {
  return `${year(iso)}-${pad2(month(iso))}`;
}
