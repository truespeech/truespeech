import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parse.js";
import { tokenize } from "../src/tokenize.js";
import type { ComputeStatement } from "../src/ast.js";

function parseSrc(src: string) {
  return parse(tokenize(src));
}

function compute(src: string): ComputeStatement {
  const r = parseSrc(src);
  assert.equal(r.errors.length, 0, `unexpected errors: ${JSON.stringify(r.errors)}`);
  assert.ok(r.ast);
  assert.equal(r.ast!.kind, "compute");
  return r.ast as ComputeStatement;
}

// ===========================================================================
// Happy paths
// ===========================================================================

describe("parse — minimal COMPUTE", () => {
  it("parses single metric with year region", () => {
    const ast = compute("COMPUTE total_sales OVER 2026");
    assert.equal(ast.metrics.length, 1);
    assert.equal(ast.metrics[0].name, "total_sales");
    assert.equal(ast.over.primaryTime.kind, "calendar");
    if (ast.over.primaryTime.kind === "calendar") {
      assert.equal(ast.over.primaryTime.literal.unit, "year");
      assert.equal(ast.over.primaryTime.literal.year, 2026);
    }
  });

  it("parses with month region", () => {
    const ast = compute("COMPUTE total_sales OVER 2026-02");
    if (ast.over.primaryTime.kind === "calendar") {
      assert.equal(ast.over.primaryTime.literal.unit, "month");
      assert.equal(ast.over.primaryTime.literal.month, 2);
    } else {
      assert.fail("expected calendar region");
    }
  });

  it("parses with quarter region", () => {
    const ast = compute("COMPUTE total_sales OVER 2026-Q1");
    if (ast.over.primaryTime.kind === "calendar") {
      assert.equal(ast.over.primaryTime.literal.unit, "quarter");
      assert.equal(ast.over.primaryTime.literal.quarter, 1);
    } else {
      assert.fail("expected calendar region");
    }
  });

  it("parses with day region", () => {
    const ast = compute("COMPUTE total_sales OVER 2026-02-15");
    if (ast.over.primaryTime.kind === "calendar") {
      assert.equal(ast.over.primaryTime.literal.unit, "day");
      assert.equal(ast.over.primaryTime.literal.day, 15);
    } else {
      assert.fail("expected calendar region");
    }
  });
});

describe("parse — time region forms", () => {
  it("parses 'all time'", () => {
    const ast = compute("COMPUTE total_sales OVER all time");
    assert.equal(ast.over.primaryTime.kind, "all-time");
  });

  it("parses 'until <bound>'", () => {
    const ast = compute("COMPUTE total_sales OVER until 2026-Q1");
    assert.equal(ast.over.primaryTime.kind, "until");
    if (ast.over.primaryTime.kind === "until") {
      assert.equal(ast.over.primaryTime.bound.unit, "quarter");
    }
  });

  it("parses 'since <bound>'", () => {
    const ast = compute("COMPUTE total_sales OVER since 2026-01-15");
    assert.equal(ast.over.primaryTime.kind, "since");
    if (ast.over.primaryTime.kind === "since") {
      assert.equal(ast.over.primaryTime.bound.unit, "day");
    }
  });

  it("parses range form", () => {
    const ast = compute("COMPUTE total_sales OVER 2026-02-03 to 2026-02-10");
    assert.equal(ast.over.primaryTime.kind, "range");
    if (ast.over.primaryTime.kind === "range") {
      assert.equal(ast.over.primaryTime.start.day, 3);
      assert.equal(ast.over.primaryTime.end.day, 10);
    }
  });

  it("parses year range", () => {
    const ast = compute("COMPUTE total_sales OVER 2025 to 2026");
    if (ast.over.primaryTime.kind === "range") {
      assert.equal(ast.over.primaryTime.start.year, 2025);
      assert.equal(ast.over.primaryTime.end.year, 2026);
    } else {
      assert.fail("expected range");
    }
  });
});

describe("parse — multiple metrics", () => {
  it("parses comma-separated metrics", () => {
    const ast = compute("COMPUTE total_sales, order_count OVER 2026");
    assert.equal(ast.metrics.length, 2);
    assert.equal(ast.metrics[0].name, "total_sales");
    assert.equal(ast.metrics[1].name, "order_count");
  });
});

describe("parse — additional constraints", () => {
  it("parses single equality constraint", () => {
    const ast = compute(
      "COMPUTE total_sales OVER 2026 AND region = 'northeast'"
    );
    assert.equal(ast.over.constraints.length, 1);
    const c = ast.over.constraints[0];
    assert.equal(c.dimension.name, "region");
    assert.equal(c.predicate.kind, "comparison");
    if (c.predicate.kind === "comparison") {
      assert.equal(c.predicate.operator, "=");
      assert.equal(c.predicate.value.kind, "string");
      if (c.predicate.value.kind === "string") {
        assert.equal(c.predicate.value.value, "northeast");
      }
    }
  });

  it("parses multiple constraints", () => {
    const ast = compute(
      "COMPUTE total_sales OVER 2026 AND region = 'west' AND product_tier != 'consumer'"
    );
    assert.equal(ast.over.constraints.length, 2);
  });

  it("parses IN with set", () => {
    const ast = compute(
      "COMPUTE total_sales OVER 2026 AND region IN ('northeast', 'west')"
    );
    const pred = ast.over.constraints[0].predicate;
    assert.equal(pred.kind, "in-set");
    if (pred.kind === "in-set") {
      assert.equal(pred.values.length, 2);
    }
  });

  it("parses NOT IN with set", () => {
    const ast = compute(
      "COMPUTE total_sales OVER 2026 AND region NOT IN ('midwest')"
    );
    const pred = ast.over.constraints[0].predicate;
    assert.equal(pred.kind, "not-in-set");
  });

  it("parses IN with time region (containment)", () => {
    const ast = compute(
      "COMPUTE total_sales OVER 2026 AND ship_date IN 2026-Q1"
    );
    const pred = ast.over.constraints[0].predicate;
    assert.equal(pred.kind, "in-time-region");
    if (pred.kind === "in-time-region") {
      assert.equal(pred.region.kind, "calendar");
    }
  });

  it("parses IN with time range", () => {
    const ast = compute(
      "COMPUTE total_sales OVER 2026 AND ship_date IN 2026-02-01 to 2026-02-28"
    );
    const pred = ast.over.constraints[0].predicate;
    assert.equal(pred.kind, "in-time-region");
    if (pred.kind === "in-time-region") {
      assert.equal(pred.region.kind, "range");
    }
  });

  it("parses comparison with numeric value", () => {
    const ast = compute(
      "COMPUTE total_sales OVER 2026 AND amount > 100"
    );
    const pred = ast.over.constraints[0].predicate;
    if (pred.kind === "comparison") {
      assert.equal(pred.value.kind, "number");
      if (pred.value.kind === "number") {
        assert.equal(pred.value.value, 100);
      }
    } else {
      assert.fail("expected comparison");
    }
  });

  it("parses comparison with date value (secondary time)", () => {
    const ast = compute(
      "COMPUTE total_sales OVER 2026 AND ship_date >= 2026-02-01"
    );
    const pred = ast.over.constraints[0].predicate;
    if (pred.kind === "comparison") {
      assert.equal(pred.value.kind, "time-literal");
    } else {
      assert.fail("expected comparison");
    }
  });

  it("supports all comparison operators", () => {
    for (const op of ["=", "!=", ">", "<", ">=", "<="]) {
      const r = parseSrc(`COMPUTE total_sales OVER 2026 AND amount ${op} 100`);
      assert.equal(r.errors.length, 0, op);
    }
  });
});

describe("parse — GROUP BY", () => {
  it("parses bare grain (implicit primary time)", () => {
    const ast = compute("COMPUTE total_sales OVER 2026 GROUP BY month");
    assert.equal(ast.groupBy?.length, 1);
    assert.equal(ast.groupBy?.[0].kind, "bare-grain");
    if (ast.groupBy?.[0].kind === "bare-grain") {
      assert.equal(ast.groupBy[0].grain, "month");
    }
  });

  it("parses categorical dimension", () => {
    const ast = compute("COMPUTE total_sales OVER 2026 GROUP BY region");
    assert.equal(ast.groupBy?.[0].kind, "dimension");
  });

  it("parses time dimension with grain", () => {
    const ast = compute(
      "COMPUTE total_sales OVER 2026 GROUP BY ship_date:week"
    );
    assert.equal(ast.groupBy?.[0].kind, "time-dimension");
    if (ast.groupBy?.[0].kind === "time-dimension") {
      assert.equal(ast.groupBy[0].dimension.name, "ship_date");
      assert.equal(ast.groupBy[0].grain, "week");
    }
  });

  it("parses multiple group-by items", () => {
    const ast = compute(
      "COMPUTE total_sales OVER 2026 GROUP BY region, month, ship_date:week"
    );
    assert.equal(ast.groupBy?.length, 3);
    assert.equal(ast.groupBy?.[0].kind, "dimension");
    assert.equal(ast.groupBy?.[1].kind, "bare-grain");
    assert.equal(ast.groupBy?.[2].kind, "time-dimension");
  });
});

describe("parse — ORDER BY", () => {
  it("parses single field ascending by default", () => {
    const ast = compute(
      "COMPUTE total_sales OVER 2026 GROUP BY region ORDER BY region"
    );
    assert.equal(ast.orderBy?.length, 1);
    assert.equal(ast.orderBy?.[0].direction, "asc");
  });

  it("respects ASC and DESC", () => {
    const a = compute(
      "COMPUTE total_sales OVER 2026 GROUP BY region ORDER BY region ASC"
    );
    const b = compute(
      "COMPUTE total_sales OVER 2026 GROUP BY region ORDER BY region DESC"
    );
    assert.equal(a.orderBy?.[0].direction, "asc");
    assert.equal(b.orderBy?.[0].direction, "desc");
  });

  it("parses multiple order fields", () => {
    const ast = compute(
      "COMPUTE total_sales OVER 2026 GROUP BY region, month ORDER BY region ASC, month DESC"
    );
    assert.equal(ast.orderBy?.length, 2);
  });

  it("allows ordering by bare-grain result column", () => {
    const ast = compute(
      "COMPUTE total_sales OVER 2026 GROUP BY month ORDER BY month"
    );
    assert.equal(ast.orderBy?.[0].field.name, "month");
  });
});

describe("parse — LIMIT", () => {
  it("parses LIMIT n", () => {
    const ast = compute("COMPUTE total_sales OVER 2026 LIMIT 10");
    assert.equal(ast.limit?.value, 10);
  });
});

describe("parse — combined", () => {
  it("parses a fully-loaded statement", () => {
    const ast = compute(
      "COMPUTE total_sales, order_count OVER 2026-Q1 AND region = 'northeast' AND ship_date IN 2026-02 GROUP BY region, week ORDER BY week ASC LIMIT 50"
    );
    assert.equal(ast.metrics.length, 2);
    assert.equal(ast.over.constraints.length, 2);
    assert.equal(ast.groupBy?.length, 2);
    assert.equal(ast.orderBy?.length, 1);
    assert.equal(ast.limit?.value, 50);
  });

  it("accepts trailing semicolon", () => {
    compute("COMPUTE total_sales OVER 2026;");
  });

  it("accepts case-insensitive keywords", () => {
    compute("compute total_sales over 2026 group by month order by month");
  });
});

// ===========================================================================
// Spans
// ===========================================================================

describe("parse — spans", () => {
  it("statement span covers entire input", () => {
    const src = "COMPUTE total_sales OVER 2026";
    const ast = compute(src);
    assert.equal(ast.span.start, 0);
    assert.equal(ast.span.end, src.length);
  });

  it("metric ref span points at metric token", () => {
    const ast = compute("COMPUTE total_sales OVER 2026");
    assert.deepEqual(ast.metrics[0].span, { start: 8, end: 19 });
  });

  it("constraint dimension span points at dimension token", () => {
    const src = "COMPUTE total_sales OVER 2026 AND region = 'northeast'";
    const ast = compute(src);
    const c = ast.over.constraints[0];
    assert.equal(src.slice(c.dimension.span.start, c.dimension.span.end), "region");
  });
});

// ===========================================================================
// Errors
// ===========================================================================

describe("parse — errors", () => {
  it("errors on empty input", () => {
    const r = parseSrc("");
    assert.ok(r.errors.length > 0);
    assert.equal(r.errors[0].code, "unexpected_eof");
  });

  it("errors when statement does not start with COMPUTE", () => {
    const r = parseSrc("SELECT * FROM orders");
    assert.equal(r.errors[0].code, "unexpected_token");
  });

  it("errors when COMPUTE is not followed by metric", () => {
    const r = parseSrc("COMPUTE OVER 2026");
    assert.ok(r.errors.length > 0);
    assert.equal(r.errors[0].code, "expected_token");
  });

  it("errors when OVER is missing", () => {
    const r = parseSrc("COMPUTE total_sales 2026");
    assert.ok(r.errors.length > 0);
  });

  it("errors when 'all' is not followed by 'time'", () => {
    const r = parseSrc("COMPUTE total_sales OVER all bogus");
    assert.ok(r.errors.length > 0);
  });

  it("errors on invalid time region", () => {
    const r = parseSrc("COMPUTE total_sales OVER bogus_region");
    assert.ok(r.errors.length > 0);
  });

  it("errors on bare 3-digit year", () => {
    const r = parseSrc("COMPUTE total_sales OVER 202");
    assert.ok(r.errors.some((e) => e.code === "malformed_time_literal"));
  });

  it("errors when GROUP missing BY", () => {
    const r = parseSrc("COMPUTE total_sales OVER 2026 GROUP region");
    assert.ok(r.errors.length > 0);
  });

  it("errors on unsupported operator", () => {
    // ~ is not even tokenized as operator — gets error token
    const r = parseSrc("COMPUTE total_sales OVER 2026 AND amount ~ 100");
    assert.ok(r.errors.length > 0);
  });

  it("error span points at the offending token", () => {
    const src = "SELECT total_sales OVER 2026";
    const r = parseSrc(src);
    assert.equal(src.slice(r.errors[0].span.start, r.errors[0].span.end), "SELECT");
  });
});
