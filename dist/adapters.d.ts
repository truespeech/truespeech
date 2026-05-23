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
export type WhereOperator = "=" | "!=" | ">" | "<" | ">=" | "<=" | "in" | "not_in";
export type GroupByClause = {
    dimension: string;
    grain?: undefined;
} | {
    dimension: string;
    grain: Grain;
};
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
    listMetrics(): MetricInfo[];
    dimensionsForMetric(metricName: string): DimensionInfo[];
    primaryTimeForMetric(metricName: string): DimensionInfo | null;
    toSQL(query: SemanticQuery): string;
}
export interface QueryResult {
    columns: string[];
    rows: (string | number | null)[][];
}
export interface DatabaseAdapter {
    execute(sql: string): Promise<QueryResult>;
}
export type LexiconEntry = RegionLexiconEntry | BoundaryLexiconEntry;
export interface RegionLexiconEntry {
    kind: "region";
    name: string;
    impacts: Impact[];
    description: string;
}
export interface BoundaryLexiconEntry {
    kind: "boundary";
    name: string;
    at: string;
    constraints: ResolvedConstraint[];
    metrics: string[];
    description: string;
}
export interface Impact {
    metric: string;
    region: ResolvedRegion;
}
export interface ResolvedRegion {
    timeStart: string;
    timeEnd: string;
    constraints: ResolvedConstraint[];
}
export interface ResolvedConstraint {
    dimension: string;
    operator: WhereOperator;
    value: string | number | (string | number)[];
}
export type LexiconMatch = RegionMatch | BoundaryMatch;
export interface RegionMatch {
    kind: "region";
    entry: RegionLexiconEntry;
    impact: Impact;
    overlap: ResolvedRegion;
}
export interface BoundaryMatch {
    kind: "boundary";
    entry: BoundaryLexiconEntry;
    metric: string;
    crossedAt: string;
}
export interface RowDecoration {
    matches: LexiconMatch[];
}
export interface LexiconAdapter {
    add(entry: LexiconEntry): Promise<void>;
    list(): Promise<LexiconEntry[]>;
}
