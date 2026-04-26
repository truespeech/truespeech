// Adapter interfaces.
//
// True Speech is decoupled from any specific semantic layer, database,
// or lexicon storage via these three adapter contracts. The runtime
// calls into them — never imports from a specific implementation — so
// the same runtime works against OSI, dbt MetricFlow, Cube, an
// in-memory mock, or anything else that can be wrapped to fit these
// shapes.
//
// The semantic-layer types deliberately mirror the OSI runtime's
// public shapes so the OsiAdapter wrapper is a near-identity. Future
// semantic-layer adapters can do more translation work as needed.

// ===== Semantic layer =====

export interface MetricInfo {
  name: string;
  description?: string;
}

export interface DimensionInfo {
  name: string;
  isTime: boolean;
  dataset: string;
}

export type Grain = "day" | "week" | "month" | "quarter" | "year";

export type WhereOperator =
  | "="
  | "!="
  | ">"
  | "<"
  | ">="
  | "<="
  | "in"
  | "not_in";

export type GroupByClause =
  | { dimension: string; grain?: undefined }
  | { dimension: string; grain: Grain };

export interface WhereClause {
  dimension: string;
  operator: WhereOperator;
  value: string | number | (string | number)[];
}

export interface OrderByClause {
  field: string;
  direction?: "asc" | "desc";
}

export interface SemanticQuery {
  metric: string;
  groupBy?: GroupByClause[];
  where?: WhereClause[];
  orderBy?: OrderByClause[];
  limit?: number;
}

export interface SemanticLayerAdapter {
  // Discovery — used at validation time to check references.
  listMetrics(): MetricInfo[];
  dimensionsForMetric(metricName: string): DimensionInfo[];
  primaryTimeForMetric(metricName: string): DimensionInfo | null;

  // Translation — used at execution time.
  toSQL(query: SemanticQuery): string;
}

// ===== Database =====

export interface QueryResult {
  columns: string[];
  rows: (string | number | null)[][];
}

export interface DatabaseAdapter {
  execute(sql: string): Promise<QueryResult>;
}

// ===== Lexicon =====
//
// The lexicon stores curated entries — typically annotations of known
// data-quality issues, anomalies, or contextual notes that consumers of
// the data should be aware of. Each entry has one or more "impacts": a
// (metric, region) pair stating that this entry is relevant to that
// metric within that region.
//
// Storage is left to the application: in-memory for a demo, a file or
// database for persistence, etc. The runtime treats the lexicon as a
// flat list — query/filter logic happens in the runtime itself.

export interface LexiconEntry {
  name: string;
  impacts: Impact[];
  description: string;
}

export interface Impact {
  metric: string;
  region: ResolvedRegion;
}

export interface ResolvedRegion {
  // ISO YYYY-MM-DD, both ends inclusive (matches the closed-interval
  // semantics of the language). The interval is in the calendar of the
  // metric's primary time field.
  timeStart: string;
  timeEnd: string;
  constraints: ResolvedConstraint[];
}

export interface ResolvedConstraint {
  dimension: string;
  operator: WhereOperator;
  value: string | number | (string | number)[];
}

// A successful match between a query (CHECK or COMPUTE reconciliation)
// and a lexicon entry. The `impact` is the specific IMPACTING clause
// that matched; the `overlap` is the actual region intersection
// computed at match time, useful for surfacing the *why*.
export interface LexiconMatch {
  entry: LexiconEntry;
  impact: Impact;
  overlap: ResolvedRegion;
}

export interface LexiconAdapter {
  add(entry: LexiconEntry): Promise<void>;
  list(): Promise<LexiconEntry[]>;
}
