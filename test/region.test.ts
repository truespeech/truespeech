import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRegion,
  intersectRegions,
  renderTimeRegion,
  renderRegion,
  formatTimeBucket,
} from "../src/region.js";
import { tokenize } from "../src/tokenize.js";
import { parse } from "../src/parse.js";
import type { ComputeStatement } from "../src/ast.js";
import type { ResolvedRegion } from "../src/adapters.js";

// Helper: parse `OVER ...` out of a synthetic COMPUTE statement so we
// can pump real OverClauses into resolveRegion.
function overClause(src: string) {
  const r = parse(tokenize(`COMPUTE total_sales OVER ${src}`));
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  return (r.ast as ComputeStatement).over;
}

// Convenient ResolvedRegion builder
function rr(
  start: string,
  end: string,
  constraints: ResolvedRegion["constraints"] = []
): ResolvedRegion {
  return { timeStart: start, timeEnd: end, constraints };
}

// ===========================================================================
// resolveRegion
// ===========================================================================

describe("resolveRegion — time forms", () => {
  it("resolves a year", () => {
    const r = resolveRegion(overClause("2026"), "order_date");
    assert.equal(r.timeStart, "2026-01-01");
    assert.equal(r.timeEnd, "2026-12-31");
  });

  it("resolves a quarter", () => {
    const r = resolveRegion(overClause("2026-Q1"), "order_date");
    assert.equal(r.timeStart, "2026-01-01");
    assert.equal(r.timeEnd, "2026-03-31");
  });

  it("resolves a month", () => {
    const r = resolveRegion(overClause("2026-02"), "order_date");
    assert.equal(r.timeStart, "2026-02-01");
    assert.equal(r.timeEnd, "2026-02-28");
  });

  it("resolves February in a leap year", () => {
    const r = resolveRegion(overClause("2024-02"), "order_date");
    assert.equal(r.timeEnd, "2024-02-29");
  });

  it("resolves a day", () => {
    const r = resolveRegion(overClause("2026-02-15"), "order_date");
    assert.equal(r.timeStart, "2026-02-15");
    assert.equal(r.timeEnd, "2026-02-15");
  });

  it("resolves a range", () => {
    const r = resolveRegion(
      overClause("2026-02-03 to 2026-02-10"),
      "order_date"
    );
    assert.equal(r.timeStart, "2026-02-03");
    assert.equal(r.timeEnd, "2026-02-10");
  });

  it("resolves until <bound>", () => {
    const r = resolveRegion(overClause("until 2026-Q1"), "order_date");
    assert.equal(r.timeEnd, "2026-03-31");
    assert.ok(r.timeStart < r.timeEnd);
  });

  it("resolves since <bound>", () => {
    const r = resolveRegion(overClause("since 2026-01-15"), "order_date");
    assert.equal(r.timeStart, "2026-01-15");
    assert.ok(r.timeStart < r.timeEnd);
  });

  it("resolves all time", () => {
    const r = resolveRegion(overClause("all time"), "order_date");
    assert.ok(r.timeStart < "0002-01-01");
    assert.ok(r.timeEnd > "9000-01-01");
  });
});

describe("resolveRegion — constraints", () => {
  it("resolves equality on a categorical dim", () => {
    const r = resolveRegion(
      overClause("2026 AND region = 'northeast'"),
      "order_date"
    );
    assert.deepEqual(r.constraints, [
      { dimension: "region", operator: "=", value: "northeast" },
    ]);
  });

  it("resolves IN with set", () => {
    const r = resolveRegion(
      overClause("2026 AND region IN ('northeast', 'west')"),
      "order_date"
    );
    assert.deepEqual(r.constraints, [
      { dimension: "region", operator: "in", value: ["northeast", "west"] },
    ]);
  });

  it("resolves NOT IN with set", () => {
    const r = resolveRegion(
      overClause("2026 AND region NOT IN ('midwest')"),
      "order_date"
    );
    assert.deepEqual(r.constraints, [
      { dimension: "region", operator: "not_in", value: ["midwest"] },
    ]);
  });

  it("resolves IN time-region (calendar) on a secondary time dim", () => {
    const r = resolveRegion(
      overClause("2026 AND ship_date IN 2026-Q1"),
      "order_date"
    );
    assert.deepEqual(r.constraints, [
      {
        dimension: "ship_date",
        operator: "in",
        value: ["2026-01-01", "2026-03-31"],
      },
    ]);
  });

  it("resolves comparison with date literal", () => {
    const r = resolveRegion(
      overClause("2026 AND ship_date >= 2026-02-01"),
      "order_date"
    );
    assert.deepEqual(r.constraints, [
      { dimension: "ship_date", operator: ">=", value: "2026-02-01" },
    ]);
  });
});

// ===========================================================================
// intersectRegions
// ===========================================================================

describe("intersectRegions — time", () => {
  it("returns the inner bounds when intervals overlap", () => {
    const a = rr("2026-01-01", "2026-06-30");
    const b = rr("2026-04-01", "2026-12-31");
    assert.deepEqual(intersectRegions(a, b), {
      timeStart: "2026-04-01",
      timeEnd: "2026-06-30",
      constraints: [],
    });
  });

  it("returns the entire smaller interval when one contains the other", () => {
    const a = rr("2026-01-01", "2026-12-31");
    const b = rr("2026-02-03", "2026-02-04");
    assert.deepEqual(intersectRegions(a, b), {
      timeStart: "2026-02-03",
      timeEnd: "2026-02-04",
      constraints: [],
    });
  });

  it("treats touching boundaries as overlap (closed intervals)", () => {
    // a ends Feb 4, b starts Feb 4 — they share that single day.
    const a = rr("2026-02-01", "2026-02-04");
    const b = rr("2026-02-04", "2026-02-10");
    assert.deepEqual(intersectRegions(a, b), {
      timeStart: "2026-02-04",
      timeEnd: "2026-02-04",
      constraints: [],
    });
  });

  it("returns null when intervals do not overlap", () => {
    const a = rr("2026-01-01", "2026-01-31");
    const b = rr("2026-03-01", "2026-03-31");
    assert.equal(intersectRegions(a, b), null);
  });
});

describe("intersectRegions — constraints", () => {
  it("includes constraints from both sides, deduplicated", () => {
    const a = rr("2026-01-01", "2026-12-31", [
      { dimension: "region", operator: "=", value: "northeast" },
    ]);
    const b = rr("2026-01-01", "2026-06-30", [
      { dimension: "region", operator: "=", value: "northeast" }, // same
      { dimension: "product_tier", operator: "=", value: "enterprise" },
    ]);
    const result = intersectRegions(a, b);
    assert.ok(result);
    assert.equal(result!.constraints.length, 2);
  });

  it("preserves distinct constraints across sides", () => {
    const a = rr("2026-01-01", "2026-12-31", [
      { dimension: "region", operator: "=", value: "northeast" },
    ]);
    const b = rr("2026-01-01", "2026-06-30", [
      { dimension: "product_tier", operator: "in", value: ["enterprise"] },
    ]);
    const result = intersectRegions(a, b);
    assert.ok(result);
    assert.equal(result!.constraints.length, 2);
  });
});

// ===========================================================================
// renderTimeRegion
// ===========================================================================

describe("renderTimeRegion", () => {
  it("renders single day when start equals end", () => {
    assert.equal(renderTimeRegion("2026-02-15", "2026-02-15"), "2026-02-15");
  });

  it("renders a single year when both endpoints align", () => {
    assert.equal(renderTimeRegion("2026-01-01", "2026-12-31"), "2026");
  });

  it("renders a range of years when both align", () => {
    assert.equal(
      renderTimeRegion("2025-01-01", "2026-12-31"),
      "2025 to 2026"
    );
  });

  it("renders a single quarter when both endpoints align", () => {
    assert.equal(renderTimeRegion("2026-01-01", "2026-03-31"), "2026-Q1");
    assert.equal(renderTimeRegion("2026-04-01", "2026-06-30"), "2026-Q2");
    assert.equal(renderTimeRegion("2026-07-01", "2026-09-30"), "2026-Q3");
    assert.equal(renderTimeRegion("2026-10-01", "2026-12-31"), "2026-Q4");
  });

  it("renders a range of quarters when both align", () => {
    assert.equal(
      renderTimeRegion("2026-01-01", "2026-06-30"),
      "2026-Q1 to 2026-Q2"
    );
  });

  it("renders a single month when both endpoints align", () => {
    assert.equal(renderTimeRegion("2026-02-01", "2026-02-28"), "2026-02");
  });

  it("renders a single month for February in a leap year", () => {
    assert.equal(renderTimeRegion("2024-02-01", "2024-02-29"), "2024-02");
  });

  it("renders a range of months when both align", () => {
    assert.equal(
      renderTimeRegion("2026-02-01", "2026-04-30"),
      "2026-02 to 2026-04"
    );
  });

  it("falls through to day-level when nothing coarser fits", () => {
    assert.equal(
      renderTimeRegion("2026-02-15", "2026-04-30"),
      "2026-02-15 to 2026-04-30"
    );
    assert.equal(
      renderTimeRegion("2026-02-03", "2026-02-10"),
      "2026-02-03 to 2026-02-10"
    );
  });
});

// ===========================================================================
// renderRegion
// ===========================================================================

describe("renderRegion", () => {
  it("renders just the time portion when no constraints", () => {
    assert.equal(renderRegion(rr("2026-01-01", "2026-12-31")), "2026");
  });

  it("renders time AND each constraint", () => {
    assert.equal(
      renderRegion(
        rr("2026-02-03", "2026-02-04", [
          { dimension: "region", operator: "=", value: "northeast" },
        ])
      ),
      "2026-02-03 to 2026-02-04 AND region = 'northeast'"
    );
  });

  it("renders IN with parenthesized list", () => {
    assert.equal(
      renderRegion(
        rr("2026-01-01", "2026-12-31", [
          {
            dimension: "region",
            operator: "in",
            value: ["northeast", "west"],
          },
        ])
      ),
      "2026 AND region IN ('northeast', 'west')"
    );
  });

  it("renders NOT IN", () => {
    assert.equal(
      renderRegion(
        rr("2026-01-01", "2026-12-31", [
          { dimension: "region", operator: "not_in", value: ["midwest"] },
        ])
      ),
      "2026 AND region NOT IN ('midwest')"
    );
  });

  it("does not quote ISO date values", () => {
    assert.equal(
      renderRegion(
        rr("2026-01-01", "2026-12-31", [
          { dimension: "ship_date", operator: ">=", value: "2026-02-01" },
        ])
      ),
      "2026 AND ship_date >= 2026-02-01"
    );
  });

  it("does not quote numeric values", () => {
    assert.equal(
      renderRegion(
        rr("2026-01-01", "2026-12-31", [
          { dimension: "amount", operator: ">", value: 100 },
        ])
      ),
      "2026 AND amount > 100"
    );
  });
});

describe("formatTimeBucket", () => {
  it("formats year buckets as YYYY", () => {
    assert.equal(formatTimeBucket("2026-01-01", "year"), "2026");
  });

  it("formats quarter buckets as YYYY-QN", () => {
    assert.equal(formatTimeBucket("2026-01-01", "quarter"), "2026-Q1");
    assert.equal(formatTimeBucket("2026-04-01", "quarter"), "2026-Q2");
    assert.equal(formatTimeBucket("2026-07-01", "quarter"), "2026-Q3");
    assert.equal(formatTimeBucket("2026-10-01", "quarter"), "2026-Q4");
  });

  it("formats month buckets as YYYY-MM", () => {
    assert.equal(formatTimeBucket("2026-01-01", "month"), "2026-01");
    assert.equal(formatTimeBucket("2026-12-01", "month"), "2026-12");
  });

  it("formats day buckets as YYYY-MM-DD", () => {
    assert.equal(formatTimeBucket("2026-02-15", "day"), "2026-02-15");
  });

  it("formats week buckets as a date range", () => {
    // A week starts on the bucket date and runs 6 days; weeks rarely
    // align with calendar boundaries, so the range form is expected.
    assert.equal(
      formatTimeBucket("2026-01-05", "week"),
      "2026-01-05 to 2026-01-11"
    );
  });

  it("handles week buckets that cross a month boundary", () => {
    assert.equal(
      formatTimeBucket("2026-01-29", "week"),
      "2026-01-29 to 2026-02-04"
    );
  });

  it("handles week buckets that cross a year boundary", () => {
    assert.equal(
      formatTimeBucket("2025-12-29", "week"),
      "2025-12-29 to 2026-01-04"
    );
  });

  it("handles February correctly in non-leap years", () => {
    assert.equal(formatTimeBucket("2026-02-01", "month"), "2026-02");
  });

  it("handles February correctly in leap years", () => {
    assert.equal(formatTimeBucket("2024-02-01", "month"), "2024-02");
  });
});
