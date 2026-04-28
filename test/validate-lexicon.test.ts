import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../src/tokenize.js";
import { parse } from "../src/parse.js";
import { validate } from "../src/validate.js";
import type { Statement } from "../src/ast.js";
import type { TrueSpeechError } from "../src/errors.js";
import type { DimensionInfo } from "../src/adapters.js";
import { mockSemanticLayer, retailSalesMock } from "./helpers/mocks.js";

function parseAndValidate(src: string, adapter = retailSalesMock()) {
  const r = parse(tokenize(src));
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  return validate(r.ast as Statement, adapter);
}

function findError(
  errors: TrueSpeechError[],
  code: string
): TrueSpeechError | undefined {
  return errors.find((e) => e.code === code);
}

// A semantic layer where total_sales has order_date as primary and
// hypothetical "ship_count" has ship_date as primary — useful for
// testing the shared-primary-time rule.
function multiTimeMock() {
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
  return mockSemanticLayer({
    metrics: [
      { name: "total_sales" },
      { name: "ship_count" },
      { name: "order_count" },
    ],
    dimensionsByMetric: {
      total_sales: [orderDate, shipDate, region],
      ship_count: [orderDate, shipDate, region],
      order_count: [orderDate, shipDate, region],
    },
    primaryTimeByMetric: {
      total_sales: orderDate,
      ship_count: shipDate,
      order_count: orderDate,
    },
  });
}

// ===========================================================================
// REGISTER — happy paths
// ===========================================================================

describe("validate REGISTER — happy paths", () => {
  it("validates a single-impact entry", () => {
    const errors = parseAndValidate(
      `REGISTER region bot IMPACTING total_sales OVER 2026-02-03 to 2026-02-04 WITH "x"`
    );
    assert.deepEqual(errors, []);
  });

  it("validates multi-IMPACTING with different per-metric regions", () => {
    const errors = parseAndValidate(
      `REGISTER region bot
         IMPACTING total_sales OVER 2026-02-03 to 2026-02-04
         IMPACTING order_count OVER 2026-02-03 to 2026-02-04
         WITH "x"`
    );
    assert.deepEqual(errors, []);
  });

  it("validates multi-metric IMPACTING shorthand when primary times match", () => {
    const errors = parseAndValidate(
      `REGISTER region bot
         IMPACTING total_sales, average_order_value OVER 2026-02
         WITH "x"`
    );
    assert.deepEqual(errors, []);
  });

  it("validates with categorical constraints", () => {
    const errors = parseAndValidate(
      `REGISTER region bot
         IMPACTING total_sales OVER 2026-02 AND region = 'northeast'
         WITH "x"`
    );
    assert.deepEqual(errors, []);
  });
});

// ===========================================================================
// REGISTER — errors
// ===========================================================================

describe("validate REGISTER — errors", () => {
  it("flags unknown metric in IMPACTING", () => {
    const errors = parseAndValidate(
      `REGISTER region bot IMPACTING bogus OVER 2026 WITH "x"`
    );
    assert.ok(findError(errors, "unknown_metric"));
  });

  it("flags missing primary time on impacted metric", () => {
    const adapter = mockSemanticLayer({
      metrics: [{ name: "snapshot" }],
      dimensionsByMetric: { snapshot: [] },
      primaryTimeByMetric: { snapshot: null },
    });
    const errors = parseAndValidate(
      `REGISTER region bot IMPACTING snapshot OVER 2026 WITH "x"`,
      adapter
    );
    assert.ok(findError(errors, "missing_primary_time"));
  });

  it("flags multi-metric shorthand with mismatched primary times", () => {
    const errors = parseAndValidate(
      `REGISTER region bot
         IMPACTING total_sales, ship_count OVER 2026-02
         WITH "x"`,
      multiTimeMock()
    );
    assert.ok(findError(errors, "incompatible_metrics"));
  });

  it("permits multi-IMPACTING with different primaries (one metric per clause)", () => {
    const errors = parseAndValidate(
      `REGISTER region bot
         IMPACTING total_sales OVER 2026-02-03 to 2026-02-04
         IMPACTING ship_count  OVER 2026-02-05 to 2026-02-07
         WITH "x"`,
      multiTimeMock()
    );
    assert.deepEqual(errors, []);
  });

  it("flags unknown dimension in IMPACTING constraint", () => {
    const errors = parseAndValidate(
      `REGISTER region bot
         IMPACTING total_sales OVER 2026 AND bogus_dim = 'x'
         WITH "x"`
    );
    assert.ok(findError(errors, "unknown_dimension"));
  });

  it("flags malformed time literal in IMPACTING region", () => {
    const errors = parseAndValidate(
      `REGISTER region bot IMPACTING total_sales OVER 2026-Q9 WITH "x"`
    );
    assert.ok(findError(errors, "malformed_time_literal"));
  });
});

// ===========================================================================
// CHECK — happy paths
// ===========================================================================

describe("validate CHECK — happy paths", () => {
  it("validates single metric over all time", () => {
    const errors = parseAndValidate(`CHECK total_sales OVER all time`);
    assert.deepEqual(errors, []);
  });

  it("validates single metric with calendar region", () => {
    const errors = parseAndValidate(`CHECK total_sales OVER 2026-02`);
    assert.deepEqual(errors, []);
  });

  it("validates with constraints", () => {
    const errors = parseAndValidate(
      `CHECK total_sales OVER 2026 AND region = 'northeast'`
    );
    assert.deepEqual(errors, []);
  });

  it("validates multi-metric when primary times match", () => {
    const errors = parseAndValidate(
      `CHECK total_sales, average_order_value OVER 2026`
    );
    assert.deepEqual(errors, []);
  });
});

// ===========================================================================
// CHECK — errors
// ===========================================================================

describe("validate CHECK — errors", () => {
  it("flags unknown metric", () => {
    const errors = parseAndValidate(`CHECK bogus OVER all time`);
    assert.ok(findError(errors, "unknown_metric"));
  });

  it("flags missing primary time on metric", () => {
    const adapter = mockSemanticLayer({
      metrics: [{ name: "snapshot" }],
      dimensionsByMetric: { snapshot: [] },
      primaryTimeByMetric: { snapshot: null },
    });
    const errors = parseAndValidate(
      `CHECK snapshot OVER all time`,
      adapter
    );
    assert.ok(findError(errors, "missing_primary_time"));
  });

  it("flags multi-metric with mismatched primary times", () => {
    const errors = parseAndValidate(
      `CHECK total_sales, ship_count OVER 2026`,
      multiTimeMock()
    );
    assert.ok(findError(errors, "incompatible_metrics"));
  });

  it("flags unknown dimension in OVER constraint", () => {
    const errors = parseAndValidate(
      `CHECK total_sales OVER 2026 AND bogus_dim = 'x'`
    );
    assert.ok(findError(errors, "unknown_dimension"));
  });

  it("flags malformed time literal", () => {
    const errors = parseAndValidate(`CHECK total_sales OVER 2026-13`);
    assert.ok(findError(errors, "malformed_time_literal"));
  });
});
