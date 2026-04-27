import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../src/tokenize.js";
import { parse } from "../src/parse.js";
import { execute } from "../src/execute.js";
import type { Statement } from "../src/ast.js";
import {
  mockDatabase,
  mockLexicon,
  retailSalesMock,
} from "./helpers/mocks.js";
import type {
  ComputeResult,
  RegisterResult,
  CheckResult,
} from "../src/execute.js";
import type { LexiconEntry } from "../src/adapters.js";

function ast(src: string): Statement {
  const r = parse(tokenize(src));
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  return r.ast as Statement;
}

// ===========================================================================
// REGISTER
// ===========================================================================

describe("execute REGISTER", () => {
  it("adds a single-impact entry to the lexicon", async () => {
    const semanticLayer = retailSalesMock();
    const database = mockDatabase();
    const lexicon = mockLexicon();

    const result = (await execute(
      ast(
        `REGISTER bot IMPACTING total_sales OVER 2026-02-03 to 2026-02-04 WITH "bot attack"`
      ),
      { semanticLayer, database, lexicon }
    )) as RegisterResult;

    assert.equal(result.statement, "register");
    assert.equal(result.entry.name, "bot");
    assert.equal(result.entry.description, "bot attack");
    assert.equal(result.entry.impacts.length, 1);
    assert.equal(result.entry.impacts[0].metric, "total_sales");
    assert.equal(result.entry.impacts[0].region.timeStart, "2026-02-03");
    assert.equal(result.entry.impacts[0].region.timeEnd, "2026-02-04");

    assert.equal(lexicon.entries.length, 1);
    assert.equal(lexicon.entries[0].name, "bot");
  });

  it("expands multi-metric IMPACTING shorthand into one impact per metric", async () => {
    const lexicon = mockLexicon();
    const result = (await execute(
      ast(
        `REGISTER bot IMPACTING total_sales, average_order_value OVER 2026-02 WITH "x"`
      ),
      {
        semanticLayer: retailSalesMock(),
        database: mockDatabase(),
        lexicon,
      }
    )) as RegisterResult;

    assert.equal(result.entry.impacts.length, 2);
    assert.equal(result.entry.impacts[0].metric, "total_sales");
    assert.equal(result.entry.impacts[1].metric, "average_order_value");
  });

  it("preserves multiple IMPACTING clauses with different per-metric regions", async () => {
    const lexicon = mockLexicon();
    const result = (await execute(
      ast(
        `REGISTER bot
           IMPACTING total_sales        OVER 2026-02-03 to 2026-02-04
           IMPACTING average_order_value OVER 2026-02-05 to 2026-02-07
           WITH "x"`
      ),
      {
        semanticLayer: retailSalesMock(),
        database: mockDatabase(),
        lexicon,
      }
    )) as RegisterResult;

    assert.equal(result.entry.impacts.length, 2);
    assert.equal(result.entry.impacts[0].region.timeStart, "2026-02-03");
    assert.equal(result.entry.impacts[1].region.timeStart, "2026-02-05");
  });

  it("captures categorical constraints in the resolved region", async () => {
    const lexicon = mockLexicon();
    const result = (await execute(
      ast(
        `REGISTER bot IMPACTING total_sales OVER 2026-02 AND region = 'northeast' WITH "x"`
      ),
      {
        semanticLayer: retailSalesMock(),
        database: mockDatabase(),
        lexicon,
      }
    )) as RegisterResult;

    assert.deepEqual(result.entry.impacts[0].region.constraints, [
      { dimension: "region", operator: "=", value: "northeast" },
    ]);
  });

  it("throws when no lexicon adapter is configured", async () => {
    await assert.rejects(
      () =>
        execute(
          ast(
            `REGISTER bot IMPACTING total_sales OVER 2026 WITH "x"`
          ),
          {
            semanticLayer: retailSalesMock(),
            database: mockDatabase(),
          }
        ),
      /requires a lexicon adapter/
    );
  });
});

// ===========================================================================
// CHECK
// ===========================================================================

describe("execute CHECK", () => {
  function botEntry(): LexiconEntry {
    return {
      name: "bot",
      impacts: [
        {
          metric: "total_sales",
          region: {
            timeStart: "2026-02-03",
            timeEnd: "2026-02-04",
            constraints: [],
          },
        },
      ],
      description: "bot attack",
    };
  }

  it("returns a match when query region overlaps an entry's impact", async () => {
    const lexicon = mockLexicon([botEntry()]);
    const result = (await execute(
      ast(`CHECK total_sales OVER 2026-02`),
      {
        semanticLayer: retailSalesMock(),
        database: mockDatabase(),
        lexicon,
      }
    )) as CheckResult;

    assert.equal(result.statement, "check");
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].entry.name, "bot");
    assert.equal(result.matches[0].overlap.timeStart, "2026-02-03");
    assert.equal(result.matches[0].overlap.timeEnd, "2026-02-04");
  });

  it("returns no matches when query region does not overlap", async () => {
    const lexicon = mockLexicon([botEntry()]);
    const result = (await execute(
      ast(`CHECK total_sales OVER 2026-03`),
      {
        semanticLayer: retailSalesMock(),
        database: mockDatabase(),
        lexicon,
      }
    )) as CheckResult;

    assert.equal(result.matches.length, 0);
  });

  it("returns no matches for a metric the entry does not impact", async () => {
    const lexicon = mockLexicon([botEntry()]);
    const result = (await execute(
      ast(`CHECK average_order_value OVER 2026-02`),
      {
        semanticLayer: retailSalesMock(),
        database: mockDatabase(),
        lexicon,
      }
    )) as CheckResult;

    assert.equal(result.matches.length, 0);
  });

  it("returns matches across multiple metrics in one CHECK", async () => {
    const entry: LexiconEntry = {
      name: "multi",
      impacts: [
        {
          metric: "total_sales",
          region: {
            timeStart: "2026-02-01",
            timeEnd: "2026-02-28",
            constraints: [],
          },
        },
        {
          metric: "average_order_value",
          region: {
            timeStart: "2026-02-01",
            timeEnd: "2026-02-28",
            constraints: [],
          },
        },
      ],
      description: "x",
    };
    const lexicon = mockLexicon([entry]);
    const result = (await execute(
      ast(`CHECK total_sales, average_order_value OVER 2026-02`),
      {
        semanticLayer: retailSalesMock(),
        database: mockDatabase(),
        lexicon,
      }
    )) as CheckResult;

    assert.equal(result.matches.length, 2);
    const metrics = result.matches.map((m) => m.impact.metric).sort();
    assert.deepEqual(metrics, ["average_order_value", "total_sales"]);
  });

  it("returns empty matches when the lexicon is empty", async () => {
    const result = (await execute(
      ast(`CHECK total_sales OVER all time`),
      {
        semanticLayer: retailSalesMock(),
        database: mockDatabase(),
        lexicon: mockLexicon(),
      }
    )) as CheckResult;

    assert.deepEqual(result.matches, []);
  });

  it("treats touching boundaries as a match (closed intervals)", async () => {
    const entry: LexiconEntry = {
      name: "edge",
      impacts: [
        {
          metric: "total_sales",
          region: {
            timeStart: "2026-02-01",
            timeEnd: "2026-02-04",
            constraints: [],
          },
        },
      ],
      description: "x",
    };
    const lexicon = mockLexicon([entry]);
    const result = (await execute(
      ast(`CHECK total_sales OVER 2026-02-04 to 2026-02-10`),
      {
        semanticLayer: retailSalesMock(),
        database: mockDatabase(),
        lexicon,
      }
    )) as CheckResult;

    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].overlap.timeStart, "2026-02-04");
    assert.equal(result.matches[0].overlap.timeEnd, "2026-02-04");
  });

  it("throws when no lexicon adapter is configured", async () => {
    await assert.rejects(
      () =>
        execute(ast(`CHECK total_sales OVER 2026`), {
          semanticLayer: retailSalesMock(),
          database: mockDatabase(),
        }),
      /requires a lexicon adapter/
    );
  });
});

// ===========================================================================
// COMPUTE — reconciliation
// ===========================================================================

describe("execute COMPUTE — reconciliation", () => {
  it("attaches matching lexicon entries to the result", async () => {
    const entry: LexiconEntry = {
      name: "bot",
      impacts: [
        {
          metric: "total_sales",
          region: {
            timeStart: "2026-02-03",
            timeEnd: "2026-02-04",
            constraints: [],
          },
        },
      ],
      description: "bot attack",
    };
    const result = (await execute(ast(`COMPUTE total_sales OVER 2026-02`), {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
      lexicon: mockLexicon([entry]),
    })) as ComputeResult;

    assert.equal(result.statement, "compute");
    assert.equal(result.reconciliation.length, 1);
    assert.equal(result.reconciliation[0].entry.name, "bot");
  });

  it("returns empty reconciliation when no entries overlap", async () => {
    const entry: LexiconEntry = {
      name: "march_event",
      impacts: [
        {
          metric: "total_sales",
          region: {
            timeStart: "2026-03-01",
            timeEnd: "2026-03-31",
            constraints: [],
          },
        },
      ],
      description: "x",
    };
    const result = (await execute(ast(`COMPUTE total_sales OVER 2026-02`), {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
      lexicon: mockLexicon([entry]),
    })) as ComputeResult;

    assert.deepEqual(result.reconciliation, []);
  });

  it("returns empty reconciliation when no lexicon adapter is configured", async () => {
    const result = (await execute(ast(`COMPUTE total_sales OVER 2026`), {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
    })) as ComputeResult;

    assert.deepEqual(result.reconciliation, []);
  });

  it("ignores entries that do not impact this metric", async () => {
    const entry: LexiconEntry = {
      name: "other",
      impacts: [
        {
          metric: "average_order_value",
          region: {
            timeStart: "2026-02-01",
            timeEnd: "2026-02-28",
            constraints: [],
          },
        },
      ],
      description: "x",
    };
    const result = (await execute(ast(`COMPUTE total_sales OVER 2026-02`), {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
      lexicon: mockLexicon([entry]),
    })) as ComputeResult;

    assert.deepEqual(result.reconciliation, []);
  });
});

// ===========================================================================
// COMPUTE — region field
// ===========================================================================

describe("execute COMPUTE — region field", () => {
  it("exposes the resolved OVER region on the result", async () => {
    const result = (await execute(ast(`COMPUTE total_sales OVER 2026-02`), {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
    })) as ComputeResult;

    assert.equal(result.region.timeStart, "2026-02-01");
    assert.equal(result.region.timeEnd, "2026-02-28");
    assert.deepEqual(result.region.constraints, []);
  });

  it("includes resolved categorical constraints from OVER", async () => {
    const result = (await execute(
      ast(`COMPUTE total_sales OVER 2026-Q1 AND region = 'northeast'`),
      {
        semanticLayer: retailSalesMock(),
        database: mockDatabase(),
      }
    )) as ComputeResult;

    assert.equal(result.region.timeStart, "2026-01-01");
    assert.equal(result.region.timeEnd, "2026-03-31");
    assert.deepEqual(result.region.constraints, [
      { dimension: "region", operator: "=", value: "northeast" },
    ]);
  });
});
