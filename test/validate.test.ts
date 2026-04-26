import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../src/tokenize.js";
import { parse } from "../src/parse.js";
import { validate, resultColumnNames } from "../src/validate.js";
import type { Statement, ComputeStatement } from "../src/ast.js";
import type { TrueSpeechError } from "../src/errors.js";
import { mockSemanticLayer, retailSalesMock } from "./helpers/mocks.js";

function parseAndValidate(src: string, adapter = retailSalesMock()) {
  const { ast, errors: parseErrors } = parse(tokenize(src));
  assert.equal(
    parseErrors.length,
    0,
    `unexpected parse errors: ${JSON.stringify(parseErrors)}`
  );
  assert.ok(ast, "expected AST");
  const errors = validate(ast as Statement, adapter);
  return { ast: ast as ComputeStatement, errors };
}

function findError(
  errors: TrueSpeechError[],
  code: string
): TrueSpeechError | undefined {
  return errors.find((e) => e.code === code);
}

// ===========================================================================
// Happy paths
// ===========================================================================

describe("validate — happy paths", () => {
  it("validates a simple COMPUTE", () => {
    const { errors } = parseAndValidate("COMPUTE total_sales OVER 2026");
    assert.deepEqual(errors, []);
  });

  it("validates with constraints", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 AND region = 'northeast' AND product_tier IN ('enterprise', 'consumer')"
    );
    assert.deepEqual(errors, []);
  });

  it("validates with secondary time constraint", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 AND ship_date IN 2026-Q1"
    );
    assert.deepEqual(errors, []);
  });

  it("validates GROUP BY with bare grain", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 GROUP BY month"
    );
    assert.deepEqual(errors, []);
  });

  it("validates GROUP BY with categorical dim", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 GROUP BY region"
    );
    assert.deepEqual(errors, []);
  });

  it("validates GROUP BY with time-dimension form", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 GROUP BY ship_date:week"
    );
    assert.deepEqual(errors, []);
  });

  it("validates fully loaded COMPUTE", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026-Q1 AND region = 'northeast' GROUP BY region, month ORDER BY total_sales DESC LIMIT 10"
    );
    assert.deepEqual(errors, []);
  });

  it("validates 'all time' region", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER all time"
    );
    assert.deepEqual(errors, []);
  });

  it("validates 'until' region", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER until 2026-Q1"
    );
    assert.deepEqual(errors, []);
  });

  it("validates 'since' region", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER since 2026-01-01"
    );
    assert.deepEqual(errors, []);
  });

  it("validates closed range", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026-02-03 to 2026-02-10"
    );
    assert.deepEqual(errors, []);
  });
});

// ===========================================================================
// Unknown metric / dimension
// ===========================================================================

describe("validate — unknown_metric", () => {
  it("flags unknown metric", () => {
    const { errors } = parseAndValidate("COMPUTE bogus_metric OVER 2026");
    const e = findError(errors, "unknown_metric");
    assert.ok(e);
    assert.match(e!.message, /Unknown metric "bogus_metric"/);
  });

  it("includes available metrics in help text", () => {
    const { errors } = parseAndValidate("COMPUTE bogus_metric OVER 2026");
    const e = findError(errors, "unknown_metric");
    assert.match(e!.help ?? "", /total_sales/);
  });

  it("error span points at the metric token", () => {
    const src = "COMPUTE bogus_metric OVER 2026";
    const { errors } = parseAndValidate(src);
    const e = findError(errors, "unknown_metric");
    assert.equal(src.slice(e!.span.start, e!.span.end), "bogus_metric");
  });
});

describe("validate — unknown_dimension", () => {
  it("flags unknown dim in constraint", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 AND bogus_dim = 'x'"
    );
    const e = findError(errors, "unknown_dimension");
    assert.ok(e);
    assert.match(e!.message, /Unknown dimension "bogus_dim"/);
  });

  it("flags unknown dim in GROUP BY", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 GROUP BY bogus_dim"
    );
    const e = findError(errors, "unknown_dimension");
    assert.ok(e);
  });

  it("flags unknown dim in time-dimension GROUP BY", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 GROUP BY bogus_dim:week"
    );
    const e = findError(errors, "unknown_dimension");
    assert.ok(e);
  });
});

// ===========================================================================
// Multi-metric (current limitation)
// ===========================================================================

describe("validate — multi-metric", () => {
  it("flags multi-metric COMPUTE as unsupported", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales, order_count OVER 2026"
    );
    const e = findError(errors, "incompatible_metrics");
    assert.ok(e);
    assert.match(e!.message, /Multi-metric/);
  });
});

// ===========================================================================
// Time literals
// ===========================================================================

describe("validate — malformed_time_literal", () => {
  it("rejects quarter Q5", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026-Q5"
    );
    const e = findError(errors, "malformed_time_literal");
    assert.ok(e);
    assert.match(e!.message, /Quarter must be 1-4/);
  });

  it("rejects month 13", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026-13"
    );
    const e = findError(errors, "malformed_time_literal");
    assert.match(e!.message, /Month must be 1-12/);
  });

  it("rejects Feb 30", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026-02-30"
    );
    const e = findError(errors, "malformed_time_literal");
    assert.match(e!.message, /Day must be 1-28/);
  });

  it("accepts Feb 29 in a leap year", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2024-02-29"
    );
    assert.deepEqual(errors, []);
  });

  it("rejects Feb 29 in a non-leap year", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2025-02-29"
    );
    assert.ok(findError(errors, "malformed_time_literal"));
  });
});

// ===========================================================================
// Ranges
// ===========================================================================

describe("validate — ranges", () => {
  it("rejects mixed-unit range", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026-01 to 2026-Q2"
    );
    assert.ok(findError(errors, "mixed_unit_range"));
  });

  it("rejects start > end", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026-02-10 to 2026-02-03"
    );
    assert.ok(findError(errors, "range_start_after_end"));
  });

  it("rejects start > end across years", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 to 2025"
    );
    assert.ok(findError(errors, "range_start_after_end"));
  });

  it("accepts equal start and end", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026-02-15 to 2026-02-15"
    );
    assert.deepEqual(errors, []);
  });

  it("accepts ranges in IN-time-region constraints", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 AND ship_date IN 2026-02-01 to 2026-02-28"
    );
    assert.deepEqual(errors, []);
  });

  it("flags malformed range ends in IN-time-region", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 AND ship_date IN 2026-Q5 to 2026-Q2"
    );
    // both: malformed Q5, and mixed-or-bad-range
    assert.ok(findError(errors, "malformed_time_literal"));
  });
});

// ===========================================================================
// Constraint type rules
// ===========================================================================

describe("validate — constraint dim/value compatibility", () => {
  it("flags IN time-region against categorical dim", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 AND region IN 2026-Q1"
    );
    const e = findError(errors, "unknown_dimension");
    // we use unknown_dimension code for this; message clarifies
    assert.ok(e);
    assert.match(e!.message, /requires a time dimension|categorical/);
  });

  it("flags time-literal compared against categorical dim", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 AND region >= 2026-02-01"
    );
    assert.ok(errors.length > 0);
  });
});

// ===========================================================================
// GROUP BY rules
// ===========================================================================

describe("validate — GROUP BY rules", () => {
  it("requires grain on time dim used as bare dim", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 GROUP BY ship_date"
    );
    const e = findError(errors, "grain_required");
    assert.ok(e);
    assert.match(e!.message, /requires a grain/);
  });

  it("rejects grain on non-time dim", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 GROUP BY region:week"
    );
    const e = findError(errors, "grain_required");
    assert.ok(e);
    assert.match(e!.message, /non-time/);
  });

  it("flags bare grain when metric has no primary time", () => {
    const adapter = mockSemanticLayer({
      metrics: [{ name: "snapshot_count" }],
      dimensionsByMetric: { snapshot_count: [] },
      primaryTimeByMetric: { snapshot_count: null },
    });
    const { errors } = parseAndValidate(
      "COMPUTE snapshot_count OVER all time GROUP BY month",
      adapter
    );
    assert.ok(findError(errors, "missing_primary_time"));
  });
});

// ===========================================================================
// ORDER BY rules
// ===========================================================================

describe("validate — ORDER BY rules", () => {
  it("rejects ORDER BY field not in result", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 GROUP BY region ORDER BY product_tier"
    );
    const e = findError(errors, "order_by_unknown_field");
    assert.ok(e);
  });

  it("accepts ORDER BY of group-by dim", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 GROUP BY region ORDER BY region"
    );
    assert.deepEqual(errors, []);
  });

  it("accepts ORDER BY of metric name", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 GROUP BY region ORDER BY total_sales DESC"
    );
    assert.deepEqual(errors, []);
  });

  it("accepts ORDER BY of bare-grain result column", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 GROUP BY month ORDER BY month"
    );
    assert.deepEqual(errors, []);
  });

  it("accepts ORDER BY of time-dim result column (auto-named)", () => {
    const { errors } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 GROUP BY ship_date:week ORDER BY ship_date_week"
    );
    assert.deepEqual(errors, []);
  });
});

// ===========================================================================
// missing_primary_time
// ===========================================================================

describe("validate — missing_primary_time", () => {
  it("flags missing primary time on the metric", () => {
    const adapter = mockSemanticLayer({
      metrics: [{ name: "anonymous_metric" }],
      dimensionsByMetric: { anonymous_metric: [] },
      primaryTimeByMetric: { anonymous_metric: null },
    });
    const { errors } = parseAndValidate(
      "COMPUTE anonymous_metric OVER 2026",
      adapter
    );
    assert.ok(findError(errors, "missing_primary_time"));
  });
});

// ===========================================================================
// resultColumnNames helper
// ===========================================================================

describe("resultColumnNames", () => {
  it("reflects bare-grain, dim, and time-dim group-by entries plus the metric", () => {
    const { ast } = parseAndValidate(
      "COMPUTE total_sales OVER 2026 GROUP BY region, month, ship_date:week"
    );
    assert.deepEqual(resultColumnNames(ast), [
      "region",
      "month",
      "ship_date_week",
      "total_sales",
    ]);
  });
});
