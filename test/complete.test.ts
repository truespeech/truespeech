import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { complete } from "../src/complete.js";
import type { Completion } from "../src/adapters.js";
import { mockLexicon, retailSalesMock } from "./helpers/mocks.js";

function ctx(
  lexiconSeed: { name: string }[] = [],
  extras: { timeLiteralYears?: number[] } = {}
) {
  return {
    semanticLayer: retailSalesMock(),
    lexicon: mockLexicon(
      lexiconSeed.map((s) => ({
        kind: "region" as const,
        name: s.name,
        impacts: [],
        description: "",
      }))
    ),
    timeLiteralYears: extras.timeLiteralYears,
  };
}

function texts(candidates: Completion[]): string[] {
  return candidates
    .filter((c) => c.text !== "")
    .map((c) => c.text)
    .sort();
}

function kinds(candidates: Completion[]): string[] {
  return Array.from(new Set(candidates.map((c) => c.kind))).sort();
}

// ===========================================================================
// Statement-leading completion
// ===========================================================================

describe("complete — statement-leading", () => {
  it("empty input suggests all five statement keywords", async () => {
    const r = await complete("", 0, ctx());
    assert.deepEqual(texts(r.candidates), [
      "CHECK",
      "COMPUTE",
      "REGISTER",
      "SHOW",
      "UNREGISTER",
    ]);
    assert.equal(r.prefix, "");
    assert.equal(r.start, 0);
  });

  it("'C' narrows to COMPUTE and CHECK", async () => {
    const r = await complete("C", 1, ctx());
    assert.deepEqual(texts(r.candidates), ["CHECK", "COMPUTE"]);
    assert.equal(r.prefix, "C");
    assert.equal(r.start, 0);
  });

  it("'co' is case-insensitive and matches COMPUTE", async () => {
    const r = await complete("co", 2, ctx());
    assert.deepEqual(texts(r.candidates), ["COMPUTE"]);
  });

  it("'RE' matches REGISTER (case-insensitive)", async () => {
    const r = await complete("RE", 2, ctx());
    assert.deepEqual(texts(r.candidates), ["REGISTER"]);
  });
});

// ===========================================================================
// COMPUTE
// ===========================================================================

describe("complete — COMPUTE", () => {
  it("after COMPUTE expects a metric", async () => {
    const r = await complete("COMPUTE ", 8, ctx());
    assert.ok(texts(r.candidates).includes("total_sales"));
    assert.ok(texts(r.candidates).includes("average_order_value"));
    assert.ok(kinds(r.candidates).includes("metric"));
  });

  it("metric completion respects a partial prefix", async () => {
    const r = await complete("COMPUTE total", 13, ctx());
    assert.deepEqual(texts(r.candidates), ["total_sales"]);
    assert.equal(r.prefix, "total");
  });

  it("after the metric expects OVER", async () => {
    const r = await complete("COMPUTE total_sales ", 20, ctx());
    assert.deepEqual(texts(r.candidates), ["OVER"]);
  });

  it("after OVER expects time-region starts", async () => {
    const r = await complete("COMPUTE total_sales OVER ", 25, ctx());
    assert.ok(texts(r.candidates).includes("ALL"));
    assert.ok(texts(r.candidates).includes("UNTIL"));
    assert.ok(texts(r.candidates).includes("SINCE"));
    assert.ok(kinds(r.candidates).includes("time-literal"));
  });

  it("after a time literal suggests AND / GROUP / ORDER / LIMIT", async () => {
    const r = await complete("COMPUTE total_sales OVER 2026 ", 30, ctx());
    const t = texts(r.candidates);
    assert.ok(t.includes("AND"));
    assert.ok(t.includes("GROUP"));
    assert.ok(t.includes("ORDER"));
    assert.ok(t.includes("LIMIT"));
  });

  it("after AND expects a dimension", async () => {
    const r = await complete(
      "COMPUTE total_sales OVER 2026 AND ",
      34,
      ctx()
    );
    const t = texts(r.candidates);
    assert.ok(t.includes("region"));
    assert.ok(t.includes("product_tier"));
  });

  it("after a dimension expects an operator or IN/NOT", async () => {
    const r = await complete(
      "COMPUTE total_sales OVER 2026 AND region ",
      41,
      ctx()
    );
    const t = texts(r.candidates);
    assert.ok(t.includes("="));
    assert.ok(t.includes("IN"));
    assert.ok(t.includes("NOT"));
  });

  it("after an operator expects a value", async () => {
    const r = await complete(
      "COMPUTE total_sales OVER 2026 AND region = ",
      43,
      ctx()
    );
    assert.ok(kinds(r.candidates).includes("string-literal"));
  });

  it("after GROUP expects BY", async () => {
    const r = await complete(
      "COMPUTE total_sales OVER 2026 GROUP ",
      36,
      ctx()
    );
    assert.deepEqual(texts(r.candidates), ["BY"]);
  });

  it("after GROUP BY suggests grains and dimensions", async () => {
    const r = await complete(
      "COMPUTE total_sales OVER 2026 GROUP BY ",
      39,
      ctx()
    );
    const t = texts(r.candidates);
    assert.ok(t.includes("month"));
    assert.ok(t.includes("quarter"));
    assert.ok(t.includes("region"));
    assert.ok(t.includes("product_tier"));
  });
});

// ===========================================================================
// REGISTER
// ===========================================================================

describe("complete — REGISTER", () => {
  it("after REGISTER expects region / boundary soft keywords", async () => {
    const r = await complete("REGISTER ", 9, ctx());
    assert.deepEqual(texts(r.candidates), ["boundary", "region"]);
    assert.ok(kinds(r.candidates).includes("soft-keyword"));
  });

  it("after the entry kind expects an identifier (no concrete candidates)", async () => {
    const r = await complete("REGISTER region ", 16, ctx());
    assert.ok(kinds(r.candidates).includes("identifier"));
  });

  it("after the entry name expects IMPACTING", async () => {
    const r = await complete("REGISTER region my_entry ", 25, ctx());
    assert.deepEqual(texts(r.candidates), ["IMPACTING"]);
  });

  it("after IMPACTING expects a metric", async () => {
    const r = await complete(
      "REGISTER region my_entry IMPACTING ",
      35,
      ctx()
    );
    assert.ok(texts(r.candidates).includes("total_sales"));
  });

  it("boundary: after AT expects a time literal", async () => {
    const r = await complete("REGISTER boundary my_cut AT ", 28, ctx());
    assert.ok(kinds(r.candidates).includes("time-literal"));
  });

  it("boundary: after AT <date> expects AND or IMPACTING", async () => {
    const r = await complete(
      "REGISTER boundary my_cut AT 2026-01-01 ",
      39,
      ctx()
    );
    const t = texts(r.candidates);
    assert.ok(t.includes("AND"));
    assert.ok(t.includes("IMPACTING"));
  });

  it("boundary: after IMPACTING <metric> expects BEFORE", async () => {
    const r = await complete(
      "REGISTER boundary my_cut AT 2026-01-01 IMPACTING total_sales ",
      61,
      ctx()
    );
    assert.deepEqual(texts(r.candidates), ["BEFORE"]);
  });

  it("boundary: after BEFORE expects a string literal", async () => {
    const r = await complete(
      "REGISTER boundary my_cut AT 2026-01-01 IMPACTING total_sales BEFORE ",
      68,
      ctx()
    );
    assert.ok(kinds(r.candidates).includes("string-literal"));
  });

  it("boundary: after BEFORE label+desc expects AFTER", async () => {
    const src =
      'REGISTER boundary my_cut AT 2026-01-01 IMPACTING total_sales BEFORE "old" "v1" ';
    const r = await complete(src, src.length, ctx());
    assert.deepEqual(texts(r.candidates), ["AFTER"]);
  });
});

// ===========================================================================
// CHECK
// ===========================================================================

describe("complete — CHECK", () => {
  it("after CHECK expects a metric", async () => {
    const r = await complete("CHECK ", 6, ctx());
    assert.ok(texts(r.candidates).includes("total_sales"));
  });

  it("after the metric expects OVER", async () => {
    const r = await complete("CHECK total_sales ", 18, ctx());
    assert.deepEqual(texts(r.candidates), ["OVER"]);
  });

  it("CHECK does not suggest GROUP / ORDER / LIMIT in the tail", async () => {
    const r = await complete("CHECK total_sales OVER 2026 ", 28, ctx());
    const t = texts(r.candidates);
    assert.ok(t.includes("AND"));
    assert.ok(!t.includes("GROUP"));
    assert.ok(!t.includes("ORDER"));
    assert.ok(!t.includes("LIMIT"));
  });
});

// ===========================================================================
// SHOW / UNREGISTER
// ===========================================================================

describe("complete — SHOW", () => {
  it("after SHOW expects lexicon / schema soft keywords", async () => {
    const r = await complete("SHOW ", 5, ctx());
    assert.deepEqual(texts(r.candidates), ["lexicon", "schema"]);
  });

  it("after SHOW LEXICON suggests lexicon entry names", async () => {
    const r = await complete(
      "SHOW LEXICON ",
      13,
      ctx([{ name: "q1_anomaly" }, { name: "aov_redef" }])
    );
    const t = texts(r.candidates);
    assert.ok(t.includes("q1_anomaly"));
    assert.ok(t.includes("aov_redef"));
    assert.ok(kinds(r.candidates).includes("lexicon-entry"));
  });

  it("after SHOW LEXICON <name>, suggests another entry", async () => {
    const r = await complete(
      "SHOW LEXICON q1_anomaly, ",
      25,
      ctx([{ name: "q1_anomaly" }, { name: "aov_redef" }])
    );
    const t = texts(r.candidates);
    assert.ok(t.includes("q1_anomaly"));
    assert.ok(t.includes("aov_redef"));
    assert.ok(kinds(r.candidates).includes("lexicon-entry"));
  });

  it("after SHOW LEXICON <name> (no comma yet) surfaces no candidates", async () => {
    const r = await complete(
      "SHOW LEXICON q1_anomaly ",
      24,
      ctx([{ name: "q1_anomaly" }, { name: "aov_redef" }])
    );
    assert.deepEqual(texts(r.candidates), []);
  });

  it("after SHOW SCHEMA no further candidates", async () => {
    const r = await complete("SHOW SCHEMA ", 12, ctx());
    assert.deepEqual(texts(r.candidates), []);
  });
});

describe("complete — UNREGISTER", () => {
  it("after UNREGISTER suggests lexicon entry names", async () => {
    const r = await complete(
      "UNREGISTER ",
      11,
      ctx([{ name: "promo_spike" }])
    );
    assert.deepEqual(texts(r.candidates), ["promo_spike"]);
  });

  it("filters lexicon entries by prefix", async () => {
    const r = await complete(
      "UNREGISTER pro",
      14,
      ctx([{ name: "promo_spike" }, { name: "anomaly" }])
    );
    assert.deepEqual(texts(r.candidates), ["promo_spike"]);
  });
});

// ===========================================================================
// Time-literal candidates (timeLiteralYears option)
// ===========================================================================

describe("complete — time-literal candidates", () => {
  it("emits year / quarter / month candidates when timeLiteralYears is set", async () => {
    const r = await complete(
      "COMPUTE total_sales OVER ",
      25,
      ctx([], { timeLiteralYears: [2025, 2026] })
    );
    const t = texts(r.candidates);
    assert.ok(t.includes("2025"));
    assert.ok(t.includes("2026"));
    assert.ok(t.includes("2025-Q1"));
    assert.ok(t.includes("2025-Q4"));
    assert.ok(t.includes("2026-Q2"));
    assert.ok(t.includes("2026-02"));
    assert.ok(t.includes("2025-01"));
    assert.ok(t.includes("2026-12"));
    // Existing keyword candidates still surface.
    assert.ok(t.includes("ALL"));
    assert.ok(t.includes("UNTIL"));
    assert.ok(t.includes("SINCE"));
  });

  it("emits 4 quarters and 12 months per year (plus the year itself)", async () => {
    const r = await complete(
      "COMPUTE total_sales OVER ",
      25,
      ctx([], { timeLiteralYears: [2026] })
    );
    const timeLits = r.candidates
      .filter((c) => c.kind === "time-literal" && c.text !== "")
      .map((c) => c.text);
    // 1 year + 4 quarters + 12 months = 17
    assert.equal(timeLits.length, 17);
    assert.ok(timeLits.includes("2026"));
    for (let q = 1; q <= 4; q++) {
      assert.ok(timeLits.includes(`2026-Q${q}`));
    }
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, "0");
      assert.ok(timeLits.includes(`2026-${mm}`));
    }
  });

  it("prefix '2026-Q' narrows to the four 2026 quarters", async () => {
    const r = await complete(
      "COMPUTE total_sales OVER 2026-Q",
      31,
      ctx([], { timeLiteralYears: [2025, 2026] })
    );
    const timeLits = r.candidates
      .filter((c) => c.kind === "time-literal" && c.text !== "")
      .map((c) => c.text)
      .sort();
    assert.deepEqual(timeLits, ["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"]);
  });

  it("falls back to the hint placeholder when timeLiteralYears is not set", async () => {
    const r = await complete("COMPUTE total_sales OVER ", 25, ctx());
    const timeLits = r.candidates.filter((c) => c.kind === "time-literal");
    assert.equal(timeLits.length, 1);
    assert.equal(timeLits[0].text, "");
    assert.ok(timeLits[0].hint);
  });

  it("REGISTER boundary AT position also emits time-literal candidates", async () => {
    const r = await complete(
      "REGISTER boundary my_cut AT ",
      28,
      ctx([], { timeLiteralYears: [2026] })
    );
    const t = texts(r.candidates);
    assert.ok(t.includes("2026"));
    assert.ok(t.includes("2026-Q1"));
    assert.ok(t.includes("2026-06"));
  });
});

// ===========================================================================
// String-literal contexts
// ===========================================================================

describe("complete — inside string literal", () => {
  it("returns no candidates inside an open string", async () => {
    const r = await complete('COMPUTE total_sales OVER 2026 AND region = "north', 49, ctx());
    assert.deepEqual(r.candidates, []);
  });
});
