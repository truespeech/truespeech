// Executor: validated AST × adapters → ExecuteResult.
//
// Translates the True Speech AST into the semantic-layer's SemanticQuery,
// hands it to the adapter to get SQL, executes the SQL via the database
// adapter, and returns a structured result that exposes every step of
// the pipeline. The demo cascade visualizer relies on having all four
// (your statement, the semantic query, the SQL, the rows) in the result.
//
// Bare-grain GROUP BY ("month") is sugar for the metric's primary time
// at that grain. The OSI runtime names that result column after the
// underlying field (e.g. order_date_month). We post-process: rename
// the column back to "month" in the returned QueryResult so the user
// sees what they wrote.

import type {
  Statement,
  ComputeStatement,
  RegisterStatement,
  CheckStatement,
  TimeRegion,
  TimeLiteral,
  Constraint,
  GroupByClause,
  CalendarRegion,
  RangeRegion,
} from "./ast.js";
import type {
  SemanticLayerAdapter,
  DatabaseAdapter,
  LexiconAdapter,
  LexiconEntry,
  LexiconMatch,
  Impact,
  SemanticQuery,
  WhereClause,
  GroupByClause as OsiGroupBy,
  OrderByClause as OsiOrderBy,
  QueryResult,
  Grain,
  DimensionInfo,
} from "./adapters.js";
import { resolveRegion, intersectRegions } from "./region.js";

export interface ExecuteOpts {
  semanticLayer: SemanticLayerAdapter;
  database: DatabaseAdapter;
  lexicon?: LexiconAdapter;
}

export type ExecuteResult = ComputeResult | RegisterResult | CheckResult;

export interface ComputeResult {
  statement: "compute";
  semanticQuery: SemanticQuery;
  sql: string;
  results: QueryResult;
  reconciliation: LexiconMatch[];
}

export interface RegisterResult {
  statement: "register";
  entry: LexiconEntry;
}

export interface CheckResult {
  statement: "check";
  matches: LexiconMatch[];
}

export async function execute(
  stmt: Statement,
  opts: ExecuteOpts
): Promise<ExecuteResult> {
  switch (stmt.kind) {
    case "compute":
      return executeCompute(stmt, opts);
    case "register":
      return executeRegister(stmt, opts);
    case "check":
      return executeCheck(stmt, opts);
  }
}

async function executeCompute(
  stmt: ComputeStatement,
  opts: ExecuteOpts
): Promise<ComputeResult> {
  const { semanticLayer, database, lexicon } = opts;
  const metric = stmt.metrics[0];
  const primaryTime = semanticLayer.primaryTimeForMetric(metric.name);

  // We require a primary time when there's any time clause that needs to
  // bind to one. Validation should already have flagged this, but guard
  // here too — execution shouldn't crash on null.
  const needsPrimary =
    stmt.over.primaryTime.kind !== "all-time" ||
    (stmt.groupBy?.some((g) => g.kind === "bare-grain") ?? false);
  if (needsPrimary && !primaryTime) {
    throw new Error(
      `Cannot execute COMPUTE on metric "${metric.name}": no primary time dimension`
    );
  }

  // 1. Build WHERE clauses from the OVER clause
  const whereClauses: WhereClause[] = [];
  if (primaryTime) {
    whereClauses.push(...timeRegionToWhere(stmt.over.primaryTime, primaryTime.name));
  }
  for (const c of stmt.over.constraints) {
    whereClauses.push(...constraintToWhere(c));
  }

  // 2. Build GROUP BY (translate bare-grain to primary time + grain)
  // and a rename map for the result columns afterwards.
  const renameMap = new Map<string, string>();
  const groupBy: OsiGroupBy[] = [];
  if (stmt.groupBy && primaryTime) {
    for (const g of stmt.groupBy) {
      if (g.kind === "bare-grain") {
        groupBy.push({ dimension: primaryTime.name, grain: g.grain });
        renameMap.set(`${primaryTime.name}_${g.grain}`, g.grain);
      } else if (g.kind === "dimension") {
        groupBy.push({ dimension: g.dimension.name });
      } else {
        groupBy.push({ dimension: g.dimension.name, grain: g.grain });
      }
    }
  } else if (stmt.groupBy) {
    // No primary time: bare-grain caught by validation; pass others through.
    for (const g of stmt.groupBy) {
      if (g.kind === "dimension") {
        groupBy.push({ dimension: g.dimension.name });
      } else if (g.kind === "time-dimension") {
        groupBy.push({ dimension: g.dimension.name, grain: g.grain });
      }
    }
  }

  // 3. Build ORDER BY, mapping any user-facing names through the rename map.
  const orderBy: OsiOrderBy[] = [];
  if (stmt.orderBy) {
    const reverseMap = new Map<string, string>();
    for (const [osi, user] of renameMap) reverseMap.set(user, osi);
    for (const o of stmt.orderBy) {
      const fieldName = reverseMap.get(o.field.name) ?? o.field.name;
      orderBy.push({ field: fieldName, direction: o.direction });
    }
  }

  const semanticQuery: SemanticQuery = {
    metric: metric.name,
    where: whereClauses.length > 0 ? whereClauses : undefined,
    groupBy: groupBy.length > 0 ? groupBy : undefined,
    orderBy: orderBy.length > 0 ? orderBy : undefined,
    limit: stmt.limit?.value,
  };

  // 4. Generate SQL and execute
  const sql = semanticLayer.toSQL(semanticQuery);
  const rawResults = await database.execute(sql);

  // 5. Apply the rename map to column headers
  const results = applyRename(rawResults, renameMap);

  // 6. Reconciliation against the lexicon (no-op if no lexicon configured).
  const reconciliation = lexicon
    ? await reconcile(metric.name, primaryTime, stmt, lexicon)
    : [];

  return {
    statement: "compute",
    semanticQuery,
    sql,
    results,
    reconciliation,
  };
}

// ===== REGISTER =====

async function executeRegister(
  stmt: RegisterStatement,
  opts: ExecuteOpts
): Promise<RegisterResult> {
  const { semanticLayer, lexicon } = opts;
  if (!lexicon) {
    throw new Error(
      "REGISTER requires a lexicon adapter; none was configured"
    );
  }

  // Expand multi-metric IMPACTING shorthand into one Impact per metric,
  // resolving each region against the metric's primary time field.
  const impacts: Impact[] = [];
  for (const clause of stmt.impactClauses) {
    for (const metricRef of clause.metrics) {
      const primaryTime = semanticLayer.primaryTimeForMetric(metricRef.name);
      if (!primaryTime) {
        // Should have been caught by validate(); guard so the runtime
        // never silently produces an entry that can never match.
        throw new Error(
          `Cannot register: metric "${metricRef.name}" has no primary time`
        );
      }
      const region = resolveRegion(clause.over, primaryTime.name);
      impacts.push({ metric: metricRef.name, region });
    }
  }

  const entry: LexiconEntry = {
    name: stmt.name.name,
    impacts,
    description: stmt.description.value,
  };

  await lexicon.add(entry);

  return { statement: "register", entry };
}

// ===== CHECK =====

async function executeCheck(
  stmt: CheckStatement,
  opts: ExecuteOpts
): Promise<CheckResult> {
  const { semanticLayer, lexicon } = opts;
  if (!lexicon) {
    throw new Error(
      "CHECK requires a lexicon adapter; none was configured"
    );
  }

  const entries = await lexicon.list();
  const matches: LexiconMatch[] = [];

  for (const metricRef of stmt.metrics) {
    const primaryTime = semanticLayer.primaryTimeForMetric(metricRef.name);
    if (!primaryTime) continue; // validation should have flagged
    const queryRegion = resolveRegion(stmt.over, primaryTime.name);

    for (const entry of entries) {
      for (const impact of entry.impacts) {
        if (impact.metric !== metricRef.name) continue;
        const overlap = intersectRegions(queryRegion, impact.region);
        if (!overlap) continue;
        matches.push({ entry, impact, overlap });
      }
    }
  }

  return { statement: "check", matches };
}

// ===== Reconciliation (used by COMPUTE) =====

async function reconcile(
  metric: string,
  primaryTime: DimensionInfo | null,
  stmt: ComputeStatement,
  lexicon: LexiconAdapter
): Promise<LexiconMatch[]> {
  if (!primaryTime) return [];
  const entries = await lexicon.list();
  const queryRegion = resolveRegion(stmt.over, primaryTime.name);
  const matches: LexiconMatch[] = [];
  for (const entry of entries) {
    for (const impact of entry.impacts) {
      if (impact.metric !== metric) continue;
      const overlap = intersectRegions(queryRegion, impact.region);
      if (!overlap) continue;
      matches.push({ entry, impact, overlap });
    }
  }
  return matches;
}

// ===== Time region → WHERE clauses =====

function timeRegionToWhere(
  region: TimeRegion,
  dimension: string
): WhereClause[] {
  switch (region.kind) {
    case "all-time":
      return [];
    case "calendar":
      return inclusiveInterval(region.literal, dimension);
    case "range":
      return [
        { dimension, operator: ">=", value: firstDayOf(region.start) },
        { dimension, operator: "<=", value: lastDayOf(region.end) },
      ];
    case "until":
      return [
        { dimension, operator: "<=", value: lastDayOf(region.bound) },
      ];
    case "since":
      return [
        { dimension, operator: ">=", value: firstDayOf(region.bound) },
      ];
  }
}

function inclusiveInterval(
  lit: TimeLiteral,
  dimension: string
): WhereClause[] {
  return [
    { dimension, operator: ">=", value: firstDayOf(lit) },
    { dimension, operator: "<=", value: lastDayOf(lit) },
  ];
}

function firstDayOf(lit: TimeLiteral): string {
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

function lastDayOf(lit: TimeLiteral): string {
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

function iso(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

// ===== Constraint → WHERE clauses =====

function constraintToWhere(c: Constraint): WhereClause[] {
  const dim = c.dimension.name;
  const pred = c.predicate;
  switch (pred.kind) {
    case "comparison": {
      const value =
        pred.value.kind === "string"
          ? pred.value.value
          : pred.value.kind === "number"
          ? pred.value.value
          : firstDayOf(pred.value.literal); // for time-literal compare we use the first instant
      return [{ dimension: dim, operator: pred.operator, value }];
    }
    case "in-set": {
      const values = pred.values.map((v) =>
        v.kind === "string" ? v.value : v.kind === "number" ? v.value : firstDayOf(v.literal)
      );
      return [{ dimension: dim, operator: "in", value: values }];
    }
    case "not-in-set": {
      const values = pred.values.map((v) =>
        v.kind === "string" ? v.value : v.kind === "number" ? v.value : firstDayOf(v.literal)
      );
      return [{ dimension: dim, operator: "not_in", value: values }];
    }
    case "in-time-region": {
      const r = pred.region;
      if (r.kind === "calendar") return inclusiveInterval(r.literal, dim);
      return [
        { dimension: dim, operator: ">=", value: firstDayOf(r.start) },
        { dimension: dim, operator: "<=", value: lastDayOf(r.end) },
      ];
    }
  }
}

// ===== Rename =====

function applyRename(
  result: QueryResult,
  renameMap: Map<string, string>
): QueryResult {
  if (renameMap.size === 0) return result;
  const columns = result.columns.map((c) => renameMap.get(c) ?? c);
  return { columns, rows: result.rows };
}
