// OSI adapter: wraps an OSI runtime instance into a SemanticLayerAdapter.
//
// True Speech does not depend on the OSI runtime — this is a convenience
// for the common case where OSI is the underlying semantic layer. The
// shapes already match (because True Speech's adapter types were modeled
// after OSI's public types), so this is a near-identity wrapper.
//
// Typed via OsiLikeRuntime: any object with the four methods we need is
// acceptable. Pass an `OsiRuntime` instance from the osi-runtime package
// directly.

import type {
  SemanticLayerAdapter,
  MetricInfo,
  DimensionInfo,
  SemanticQuery,
} from "./adapters.js";

export interface OsiLikeRuntime {
  listMetrics(): MetricInfo[];
  dimensionsForMetric(metricName: string): DimensionInfo[];
  primaryTimeForMetric(metricName: string): DimensionInfo | null;
  toSQL(query: SemanticQuery): string;
}

export function osiAdapter(runtime: OsiLikeRuntime): SemanticLayerAdapter {
  return {
    listMetrics: () => runtime.listMetrics(),
    dimensionsForMetric: (n) => runtime.dimensionsForMetric(n),
    primaryTimeForMetric: (n) => runtime.primaryTimeForMetric(n),
    toSQL: (q) => runtime.toSQL(q),
  };
}
