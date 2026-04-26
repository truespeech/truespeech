// Adapter interfaces.
//
// True Speech is decoupled from any specific semantic layer or database
// via these two adapter contracts. The runtime calls into them — never
// imports from a specific implementation — so the same runtime works
// against OSI, dbt MetricFlow, Cube, an in-memory mock, or anything
// else that can be wrapped to fit these shapes.
//
// These types deliberately mirror the OSI runtime's public shapes so the
// OsiAdapter wrapper is a near-identity. Future semantic-layer adapters
// can do more translation work as needed.

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
