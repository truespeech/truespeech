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
