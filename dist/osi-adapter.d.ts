import type { SemanticLayerAdapter, MetricInfo, DimensionInfo, SemanticQuery } from "./adapters.js";
export interface OsiLikeRuntime {
    listMetrics(): MetricInfo[];
    dimensionsForMetric(metricName: string): DimensionInfo[];
    primaryTimeForMetric(metricName: string): DimensionInfo | null;
    toSQL(query: SemanticQuery): string;
}
export declare function osiAdapter(runtime: OsiLikeRuntime): SemanticLayerAdapter;
