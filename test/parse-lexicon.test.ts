import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parse.js";
import { tokenize } from "../src/tokenize.js";
import type {
  RegisterStatement,
  RegisterBoundaryStatement,
  CheckStatement,
} from "../src/ast.js";

function parseSrc(src: string) {
  return parse(tokenize(src));
}

function register(src: string): RegisterStatement {
  const r = parseSrc(src);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.ok(r.ast);
  assert.equal(r.ast!.kind, "register");
  return r.ast as RegisterStatement;
}

function check(src: string): CheckStatement {
  const r = parseSrc(src);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.ok(r.ast);
  assert.equal(r.ast!.kind, "check");
  return r.ast as CheckStatement;
}

// ===========================================================================
// REGISTER — happy paths
// ===========================================================================

describe("parse REGISTER — minimal", () => {
  it("parses single IMPACTING with single metric", () => {
    const ast = register(
      `REGISTER region bot_campaign IMPACTING order_count OVER 2026-02-03 to 2026-02-04 WITH "credential stuffing"`
    );
    assert.equal(ast.name.name, "bot_campaign");
    assert.equal(ast.impactClauses.length, 1);
    assert.equal(ast.impactClauses[0].metrics.length, 1);
    assert.equal(ast.impactClauses[0].metrics[0].name, "order_count");
    assert.equal(ast.description.value, "credential stuffing");
  });

  it("parses single IMPACTING with multiple metrics (shorthand)", () => {
    const ast = register(
      `REGISTER region bot_campaign IMPACTING order_count, session_starts OVER 2026-02-03 to 2026-02-04 WITH "x"`
    );
    assert.equal(ast.impactClauses.length, 1);
    assert.equal(ast.impactClauses[0].metrics.length, 2);
    assert.equal(ast.impactClauses[0].metrics[1].name, "session_starts");
  });

  it("parses multiple IMPACTING clauses", () => {
    const ast = register(
      `REGISTER region bot_campaign
         IMPACTING order_count OVER 2026-02-03 to 2026-02-04
         IMPACTING ship_count  OVER 2026-02-05 to 2026-02-07
         WITH "x"`
    );
    assert.equal(ast.impactClauses.length, 2);
    assert.equal(ast.impactClauses[0].metrics[0].name, "order_count");
    assert.equal(ast.impactClauses[1].metrics[0].name, "ship_count");
  });

  it("parses IMPACTING with categorical constraints", () => {
    const ast = register(
      `REGISTER region bot_campaign IMPACTING order_count OVER 2026-02 AND region = 'northeast' WITH "x"`
    );
    assert.equal(ast.impactClauses[0].over.constraints.length, 1);
  });

  it("accepts double-quoted prose with apostrophes", () => {
    const ast = register(
      `REGISTER region mobile_bug IMPACTING session_starts OVER 2025-07 to 2025-12 WITH "user's mobile sessions weren't logged"`
    );
    assert.equal(
      ast.description.value,
      `user's mobile sessions weren't logged`
    );
  });

  it("accepts single-quoted descriptions too", () => {
    const ast = register(
      `REGISTER region x IMPACTING order_count OVER 2026 WITH 'short note'`
    );
    assert.equal(ast.description.value, "short note");
  });

  it("accepts trailing semicolon", () => {
    register(
      `REGISTER region x IMPACTING order_count OVER 2026 WITH "x";`
    );
  });

  it("is case-insensitive on keywords", () => {
    register(
      `register region x impacting order_count over 2026 with "x"`
    );
  });
});

// ===========================================================================
// REGISTER boundary — happy paths
// ===========================================================================

describe("parse REGISTER boundary — minimal", () => {
  it("parses bare AT + IMPACTING + WITH", () => {
    const ast = register(
      `REGISTER boundary metric_redef AT 2026-01-01 IMPACTING average_order_value WITH "AOV calc changed"`
    );
    assert.equal(ast.entryKind, "boundary");
    assert.equal(ast.name.name, "metric_redef");
    const b = ast as RegisterBoundaryStatement;
    assert.equal(b.at.unit, "day");
    assert.equal(b.at.year, 2026);
    assert.equal(b.at.month, 1);
    assert.equal(b.at.day, 1);
    assert.equal(b.constraints.length, 0);
    assert.equal(b.metrics.length, 1);
    assert.equal(b.metrics[0].name, "average_order_value");
    assert.equal(b.description.value, "AOV calc changed");
  });

  it("parses AT with multiple impacted metrics", () => {
    const ast = register(
      `REGISTER boundary pricing_change AT 2026-01-01 IMPACTING total_sales, average_order_value WITH "x"`
    );
    const b = ast as RegisterBoundaryStatement;
    assert.equal(b.metrics.length, 2);
    assert.equal(b.metrics[0].name, "total_sales");
    assert.equal(b.metrics[1].name, "average_order_value");
  });

  it("parses AT with categorical scoping (single AND)", () => {
    const ast = register(
      `REGISTER boundary ltv_gov_redef
         AT 2026-01-01 AND product_tier = 'government'
         IMPACTING LTV
         WITH "LTV redefined for government tier"`
    );
    const b = ast as RegisterBoundaryStatement;
    assert.equal(b.constraints.length, 1);
    assert.equal(b.metrics[0].name, "LTV");
  });

  it("parses AT with multiple AND constraints", () => {
    const ast = register(
      `REGISTER boundary x AT 2026-01-01 AND region = 'northeast' AND product_tier = 'enterprise' IMPACTING total_sales WITH "x"`
    );
    const b = ast as RegisterBoundaryStatement;
    assert.equal(b.constraints.length, 2);
  });

  it("is case-insensitive on keywords", () => {
    register(
      `register boundary x at 2026-01-01 impacting total_sales with "x"`
    );
  });
});

describe("parse REGISTER boundary — errors", () => {
  it("errors when AT is missing", () => {
    const r = parseSrc(
      `REGISTER boundary x IMPACTING total_sales WITH "x"`
    );
    assert.ok(r.errors.length > 0);
    assert.match(r.errors[0].message, /AT/i);
  });

  it("errors when IMPACTING is missing", () => {
    const r = parseSrc(
      `REGISTER boundary x AT 2026-01-01 WITH "x"`
    );
    assert.ok(r.errors.length > 0);
    assert.match(r.errors[0].message, /IMPACTING/i);
  });

  it("errors when WITH is missing", () => {
    const r = parseSrc(
      `REGISTER boundary x AT 2026-01-01 IMPACTING total_sales`
    );
    assert.ok(r.errors.length > 0);
    assert.match(r.errors[0].message, /WITH/i);
  });

  it("errors when name is missing", () => {
    const r = parseSrc(
      `REGISTER boundary AT 2026-01-01 IMPACTING total_sales WITH "x"`
    );
    assert.ok(r.errors.length > 0);
  });
});

// ===========================================================================
// REGISTER — errors
// ===========================================================================

describe("parse REGISTER — errors", () => {
  it("errors when entry kind is missing", () => {
    const r = parseSrc(`REGISTER x IMPACTING order_count OVER 2026 WITH "x"`);
    assert.ok(r.errors.length > 0);
    assert.match(r.errors[0].message, /entry kind/i);
  });

  it("errors when entry kind is not recognized", () => {
    const r = parseSrc(
      `REGISTER patch x IMPACTING order_count OVER 2026 WITH "x"`
    );
    assert.ok(r.errors.length > 0);
    assert.match(r.errors[0].message, /entry kind/i);
  });

  it("errors when name is missing", () => {
    const r = parseSrc(`REGISTER IMPACTING order_count OVER 2026 WITH "x"`);
    assert.ok(r.errors.length > 0);
  });

  it("errors when no IMPACTING clause", () => {
    const r = parseSrc(`REGISTER region x WITH "x"`);
    assert.ok(r.errors.length > 0);
  });

  it("errors when IMPACTING is missing OVER", () => {
    const r = parseSrc(`REGISTER region x IMPACTING order_count WITH "x"`);
    assert.ok(r.errors.length > 0);
  });

  it("errors when WITH is missing", () => {
    const r = parseSrc(`REGISTER region x IMPACTING order_count OVER 2026`);
    assert.ok(r.errors.length > 0);
  });

  it("errors when description is not a string", () => {
    const r = parseSrc(`REGISTER region x IMPACTING order_count OVER 2026 WITH 42`);
    assert.ok(r.errors.length > 0);
  });
});

// ===========================================================================
// CHECK — happy paths
// ===========================================================================

describe("parse CHECK — happy paths", () => {
  it("parses single metric with all time", () => {
    const ast = check(`CHECK conversion_rate OVER all time`);
    assert.equal(ast.metrics.length, 1);
    assert.equal(ast.metrics[0].name, "conversion_rate");
    assert.equal(ast.over.primaryTime.kind, "all-time");
  });

  it("parses single metric with calendar region", () => {
    const ast = check(`CHECK conversion_rate OVER 2026-02`);
    assert.equal(ast.over.primaryTime.kind, "calendar");
  });

  it("parses multiple metrics", () => {
    const ast = check(`CHECK conversion_rate, order_count OVER 2026`);
    assert.equal(ast.metrics.length, 2);
  });

  it("parses with additional constraints", () => {
    const ast = check(
      `CHECK conversion_rate OVER 2026 AND region = 'northeast'`
    );
    assert.equal(ast.over.constraints.length, 1);
  });

  it("accepts trailing semicolon", () => {
    check(`CHECK conversion_rate OVER 2026;`);
  });

  it("is case-insensitive on keywords", () => {
    check(`check conversion_rate over all time`);
  });
});

// ===========================================================================
// CHECK — errors
// ===========================================================================

describe("parse CHECK — errors", () => {
  it("errors when no metric", () => {
    const r = parseSrc(`CHECK OVER 2026`);
    assert.ok(r.errors.length > 0);
  });

  it("errors when OVER is missing (no bare-metric form)", () => {
    const r = parseSrc(`CHECK conversion_rate`);
    assert.ok(r.errors.length > 0);
  });

  it("errors when OVER region is missing", () => {
    const r = parseSrc(`CHECK conversion_rate OVER`);
    assert.ok(r.errors.length > 0);
  });
});

// ===========================================================================
// Statement dispatch
// ===========================================================================

describe("parse — statement dispatch", () => {
  it("error mentions all three statement keywords", () => {
    const r = parseSrc(`SELECT *`);
    assert.match(r.errors[0].message, /COMPUTE.*REGISTER.*CHECK/);
  });
});
