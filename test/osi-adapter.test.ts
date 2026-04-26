import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { osiAdapter } from "../src/osi-adapter.js";
import type { OsiLikeRuntime } from "../src/osi-adapter.js";
import type {
  MetricInfo,
  DimensionInfo,
  SemanticQuery,
} from "../src/adapters.js";

function fakeOsi(): {
  runtime: OsiLikeRuntime;
  calls: { method: string; arg: unknown }[];
} {
  const calls: { method: string; arg: unknown }[] = [];
  const runtime: OsiLikeRuntime = {
    listMetrics(): MetricInfo[] {
      calls.push({ method: "listMetrics", arg: undefined });
      return [{ name: "total_sales" }];
    },
    dimensionsForMetric(name: string): DimensionInfo[] {
      calls.push({ method: "dimensionsForMetric", arg: name });
      return [{ name: "region", isTime: false, dataset: "orders" }];
    },
    primaryTimeForMetric(name: string): DimensionInfo | null {
      calls.push({ method: "primaryTimeForMetric", arg: name });
      return { name: "order_date", isTime: true, dataset: "orders" };
    },
    toSQL(query: SemanticQuery): string {
      calls.push({ method: "toSQL", arg: query });
      return `SELECT mock(${query.metric})`;
    },
  };
  return { runtime, calls };
}

describe("osiAdapter", () => {
  it("proxies listMetrics", () => {
    const { runtime, calls } = fakeOsi();
    const adapter = osiAdapter(runtime);
    const result = adapter.listMetrics();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "listMetrics");
    assert.equal(result[0].name, "total_sales");
  });

  it("proxies dimensionsForMetric with the metric name", () => {
    const { runtime, calls } = fakeOsi();
    const adapter = osiAdapter(runtime);
    adapter.dimensionsForMetric("total_sales");
    assert.equal(calls[0].method, "dimensionsForMetric");
    assert.equal(calls[0].arg, "total_sales");
  });

  it("proxies primaryTimeForMetric", () => {
    const { runtime, calls } = fakeOsi();
    const adapter = osiAdapter(runtime);
    const result = adapter.primaryTimeForMetric("total_sales");
    assert.equal(calls[0].method, "primaryTimeForMetric");
    assert.equal(result?.name, "order_date");
  });

  it("proxies toSQL with the query", () => {
    const { runtime, calls } = fakeOsi();
    const adapter = osiAdapter(runtime);
    const sql = adapter.toSQL({ metric: "total_sales" });
    assert.equal(calls[0].method, "toSQL");
    assert.deepEqual(calls[0].arg, { metric: "total_sales" });
    assert.equal(sql, "SELECT mock(total_sales)");
  });
});
