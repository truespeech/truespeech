// Test mocks for adapters.
//
// Use mockSemanticLayer({...}) to configure a SemanticLayerAdapter from
// plain data — what metrics it knows about, what dimensions per metric,
// what primary time, and a hook to assert/transform toSQL calls.
//
// Use mockDatabase({...}) to get a DatabaseAdapter that records every
// SQL string it sees and returns a canned QueryResult.
//
// retailSalesMock() returns a default semantic layer that mirrors the
// OSI runtime's example model — good baseline for executor/validator tests.

import type {
  SemanticLayerAdapter,
  DatabaseAdapter,
  LexiconAdapter,
  LexiconEntry,
  MetricInfo,
  DimensionInfo,
  SemanticQuery,
  QueryResult,
} from "../../src/adapters.js";

export interface MockSemanticLayerOpts {
  metrics?: MetricInfo[];
  dimensionsByMetric?: Record<string, DimensionInfo[]>;
  primaryTimeByMetric?: Record<string, DimensionInfo | null>;
  toSQL?: (query: SemanticQuery) => string;
}

export function mockSemanticLayer(
  opts: MockSemanticLayerOpts = {}
): SemanticLayerAdapter {
  const metrics = opts.metrics ?? [];
  const dims = opts.dimensionsByMetric ?? {};
  const primary = opts.primaryTimeByMetric ?? {};
  const toSQL = opts.toSQL ?? ((q: SemanticQuery) => `-- mock SQL for ${q.metric}`);

  return {
    listMetrics: () => metrics,
    dimensionsForMetric: (name) => {
      if (!metrics.find((m) => m.name === name)) {
        throw new Error(`Unknown metric "${name}"`);
      }
      return dims[name] ?? [];
    },
    primaryTimeForMetric: (name) => {
      if (!metrics.find((m) => m.name === name)) {
        throw new Error(`Unknown metric "${name}"`);
      }
      return primary[name] ?? null;
    },
    toSQL: (query) => toSQL(query),
  };
}

export interface MockDatabase extends DatabaseAdapter {
  readonly executed: string[];
  setResult(result: QueryResult): void;
}

export function mockDatabase(
  initialResult: QueryResult = { columns: [], rows: [] }
): MockDatabase {
  let result = initialResult;
  const executed: string[] = [];
  return {
    executed,
    setResult(r: QueryResult) {
      result = r;
    },
    execute: async (sql: string) => {
      executed.push(sql);
      return result;
    },
  };
}

export interface MockLexicon extends LexiconAdapter {
  readonly entries: LexiconEntry[];
}

export function mockLexicon(seed: LexiconEntry[] = []): MockLexicon {
  const entries: LexiconEntry[] = [...seed];
  return {
    entries,
    add: async (entry: LexiconEntry) => {
      entries.push(entry);
    },
    list: async () => entries,
  };
}

// A baseline semantic-layer mock that mirrors the OSI runtime's
// retail_sales example. Useful for tests that exercise multiple
// metrics/dimensions without rebuilding the configuration each time.
export function retailSalesMock(): SemanticLayerAdapter {
  const orderDate: DimensionInfo = {
    name: "order_date",
    isTime: true,
    dataset: "orders",
  };
  const shipDate: DimensionInfo = {
    name: "ship_date",
    isTime: true,
    dataset: "orders",
  };
  const region: DimensionInfo = {
    name: "region",
    isTime: false,
    dataset: "orders",
  };
  const productTier: DimensionInfo = {
    name: "product_tier",
    isTime: false,
    dataset: "orders",
  };
  const allDims = [orderDate, shipDate, region, productTier];

  return mockSemanticLayer({
    metrics: [
      { name: "total_sales", description: "Sum of order amounts" },
      { name: "average_order_value", description: "Average order amount" },
      { name: "order_count", description: "Number of orders" },
    ],
    dimensionsByMetric: {
      total_sales: allDims,
      average_order_value: allDims,
      order_count: allDims,
    },
    primaryTimeByMetric: {
      total_sales: orderDate,
      average_order_value: orderDate,
      order_count: orderDate,
    },
  });
}
