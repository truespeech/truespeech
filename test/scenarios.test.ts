// Scenario tests — language-level coverage.
//
// Each scenario declares a self-contained world: lexicon (as raw REGISTER
// statements), database (canned QueryResult), and a query. Then it asserts
// on the user-visible behavior: how many reconciliation matches, which
// rows got decorated, which entries flagged each row.
//
// Complements the per-phase tests (tokenize / parse / validate / execute*),
// which cover code paths and error surfaces. Scenarios cover *behavior*
// the way an analyst would experience it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TrueSpeech } from "../src/index.js";
import type { ComputeResult, QueryResult } from "../src/index.js";
import { mockDatabase, mockLexicon, retailSalesMock } from "./helpers/mocks.js";

interface RowExpect {
  // Number of reconciliation matches that should apply to this row.
  matches: number;
  // Optional: which entry names should match (order-insensitive).
  entryNames?: string[];
}

interface ScenarioExpect {
  reconciliation?: {
    count: number;
    entryNames?: string[];
  };
  decorations?: RowExpect[];
}

interface ScenarioConfig {
  // Raw REGISTER statements to seed the lexicon before running the query.
  lexicon?: string[];
  // Canned database response — what the (mocked) DB returns for the query.
  database: QueryResult;
  // The query under test (typically a COMPUTE).
  query: string;
  // What the result should look like.
  expect: ScenarioExpect;
}

function scenario(name: string, config: ScenarioConfig): void {
  it(name, async () => {
    const semanticLayer = retailSalesMock();
    const database = mockDatabase(config.database);
    const lexicon = mockLexicon();
    const ts = new TrueSpeech({ semanticLayer, database, lexicon });

    // Seed the lexicon by running each REGISTER statement through the
    // runtime. The mock database returns the same canned result for any
    // SQL, so we reset to a real result *after* seeding so seed REGISTERs
    // don't accidentally consume our test rows.
    for (const stmt of config.lexicon ?? []) {
      await ts.execute(stmt);
    }
    database.setResult(config.database);

    const result = (await ts.execute(config.query)) as ComputeResult;
    assert.equal(
      result.statement,
      "compute",
      `Query did not produce a COMPUTE result: ${config.query}`
    );

    if (config.expect.reconciliation) {
      const exp = config.expect.reconciliation;
      assert.equal(
        result.reconciliation.length,
        exp.count,
        `Expected ${exp.count} reconciliation matches, got ${result.reconciliation.length} (${result.reconciliation.map((m) => m.entry.name).join(", ")})`
      );
      if (exp.entryNames) {
        const actual = result.reconciliation.map((m) => m.entry.name).sort();
        assert.deepEqual(actual, [...exp.entryNames].sort());
      }
    }

    if (config.expect.decorations) {
      const expDecorations = config.expect.decorations;
      assert.equal(
        result.decorations.length,
        expDecorations.length,
        `Expected ${expDecorations.length} row decorations, got ${result.decorations.length}`
      );
      for (let i = 0; i < expDecorations.length; i++) {
        const expRow = expDecorations[i];
        const actual = result.decorations[i];
        assert.equal(
          actual.matches.length,
          expRow.matches,
          `Row ${i}: expected ${expRow.matches} matches, got ${actual.matches.length} (${actual.matches.map((m) => m.entry.name).join(", ")})`
        );
        if (expRow.entryNames) {
          const actualNames = actual.matches.map((m) => m.entry.name).sort();
          assert.deepEqual(
            actualNames,
            [...expRow.entryNames].sort(),
            `Row ${i}: entry names`
          );
        }
      }
    }
  });
}

// ===========================================================================
// Sanity scenarios — verify the harness wiring before adding real coverage.
// ===========================================================================

describe("scenarios — harness sanity", () => {
  scenario("no lexicon, no reconciliation, plain rows pass through", {
    database: {
      columns: ["region", "total_sales"],
      rows: [
        ["northeast", 100],
        ["west", 200],
      ],
    },
    query: "COMPUTE total_sales OVER 2026 GROUP BY region",
    expect: {
      reconciliation: { count: 0 },
      decorations: [{ matches: 0 }, { matches: 0 }],
    },
  });

  scenario("a region overlapping the query produces a query-level match", {
    lexicon: [
      `REGISTER region march_outage
         IMPACTING total_sales OVER 2026-03
         WITH "March outage"`,
    ],
    database: {
      columns: ["total_sales"],
      rows: [[12345]],
    },
    query: "COMPUTE total_sales OVER 2026-Q1",
    expect: {
      reconciliation: { count: 1, entryNames: ["march_outage"] },
      // Single ungrouped row: row's slice IS the query region, so it inherits
      // the match.
      decorations: [{ matches: 1, entryNames: ["march_outage"] }],
    },
  });

  scenario("group-by-month exposes per-row decoration boundaries", {
    lexicon: [
      `REGISTER region march_outage
         IMPACTING total_sales OVER 2026-03
         WITH "March outage"`,
    ],
    database: {
      columns: ["month", "total_sales"],
      rows: [
        ["2026-02-01", 100],
        ["2026-03-01", 200],
        ["2026-04-01", 150],
      ],
    },
    query: "COMPUTE total_sales OVER 2026-Q1 to 2026-Q2 GROUP BY month",
    expect: {
      reconciliation: { count: 1, entryNames: ["march_outage"] },
      decorations: [
        { matches: 0 }, // Feb — outside region
        { matches: 1, entryNames: ["march_outage"] }, // March — inside
        { matches: 0 }, // April — outside
      ],
    },
  });

  scenario("categorically scoped region only flags the matching row", {
    lexicon: [
      `REGISTER region ne_outage
         IMPACTING total_sales OVER 2026-03 AND region = 'northeast'
         WITH "Northeast outage in March"`,
    ],
    database: {
      columns: ["region", "total_sales"],
      rows: [
        ["northeast", 100],
        ["west", 200],
        ["southeast", 150],
      ],
    },
    query: "COMPUTE total_sales OVER 2026-03 GROUP BY region",
    expect: {
      reconciliation: { count: 1, entryNames: ["ne_outage"] },
      decorations: [
        { matches: 1, entryNames: ["ne_outage"] }, // northeast
        { matches: 0 }, // west
        { matches: 0 }, // southeast
      ],
    },
  });
});

// ===========================================================================
// Boundary scenarios — the per-row "input mixing" model.
// ===========================================================================

describe("scenarios — boundaries", () => {
  scenario("ungrouped query straddling the cut: single row flags", {
    lexicon: [
      `REGISTER boundary metric_redef AT 2026-01-01 IMPACTING total_sales WITH "calc changed"`,
    ],
    database: {
      columns: ["total_sales"],
      rows: [[12345]],
    },
    query: "COMPUTE total_sales OVER 2025-Q4 to 2026-Q1",
    expect: {
      reconciliation: { count: 1, entryNames: ["metric_redef"] },
      decorations: [{ matches: 1, entryNames: ["metric_redef"] }],
    },
  });

  scenario("query entirely before the cut: no match at all", {
    lexicon: [
      `REGISTER boundary metric_redef AT 2026-01-01 IMPACTING total_sales WITH "x"`,
    ],
    database: {
      columns: ["total_sales"],
      rows: [[100]],
    },
    query: "COMPUTE total_sales OVER 2025-Q4",
    expect: {
      reconciliation: { count: 0 },
      decorations: [{ matches: 0 }],
    },
  });

  scenario("group-by month disambiguates: only crossing rows flag", {
    // Cut is mid-month (2026-01-15). Only the January row's bucket
    // straddles it; Dec is entirely before, Feb entirely after.
    lexicon: [
      `REGISTER boundary mid_month_cut AT 2026-01-15 IMPACTING total_sales WITH "x"`,
    ],
    database: {
      columns: ["month", "total_sales"],
      rows: [
        ["2025-12-01", 100],
        ["2026-01-01", 200],
        ["2026-02-01", 150],
      ],
    },
    query: "COMPUTE total_sales OVER 2025-12 to 2026-02 GROUP BY month",
    expect: {
      reconciliation: { count: 1 },
      decorations: [
        { matches: 0 }, // Dec
        { matches: 1, entryNames: ["mid_month_cut"] }, // Jan
        { matches: 0 }, // Feb
      ],
    },
  });

  scenario("group-by month with cut at month boundary: no row flags", {
    // Cut at exactly 2026-01-01, group by month → Dec is entirely
    // before, Jan starts at the cut and contains only post-cut data.
    // Neither row mixes. Per-row decorations are clean — but the query
    // as a whole still straddles the cut so the query-level
    // reconciliation registers a match.
    lexicon: [
      `REGISTER boundary clean_cut AT 2026-01-01 IMPACTING total_sales WITH "x"`,
    ],
    database: {
      columns: ["month", "total_sales"],
      rows: [
        ["2025-12-01", 100],
        ["2026-01-01", 200],
      ],
    },
    query: "COMPUTE total_sales OVER 2025-12 to 2026-01 GROUP BY month",
    expect: {
      reconciliation: { count: 1 },
      decorations: [{ matches: 0 }, { matches: 0 }],
    },
  });

  scenario("categorically scoped boundary only flags the matching row", {
    lexicon: [
      `REGISTER boundary ltv_gov_redef
         AT 2026-01-01 AND product_tier = 'enterprise'
         IMPACTING total_sales
         WITH "Enterprise pricing changed"`,
    ],
    database: {
      columns: ["product_tier", "total_sales"],
      rows: [
        ["enterprise", 1000],
        ["consumer", 500],
      ],
    },
    query: "COMPUTE total_sales OVER 2025-Q4 to 2026-Q1 GROUP BY product_tier",
    expect: {
      reconciliation: { count: 1, entryNames: ["ltv_gov_redef"] },
      decorations: [
        { matches: 1, entryNames: ["ltv_gov_redef"] }, // enterprise — straddles + scope match
        { matches: 0 }, // consumer — straddles but scope mismatch
      ],
    },
  });

  scenario("boundary matches a metric not impacted: no match", {
    lexicon: [
      `REGISTER boundary aov_redef AT 2026-01-01 IMPACTING average_order_value WITH "x"`,
    ],
    database: {
      columns: ["total_sales"],
      rows: [[100]],
    },
    query: "COMPUTE total_sales OVER 2025-Q4 to 2026-Q1",
    expect: {
      reconciliation: { count: 0 },
      decorations: [{ matches: 0 }],
    },
  });
});
