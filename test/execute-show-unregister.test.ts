import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/execute.js";
import { parse } from "../src/parse.js";
import { tokenize } from "../src/tokenize.js";
import type {
  ShowLexiconResult,
  ShowSchemaResult,
  UnregisterResult,
  RegisterResult,
} from "../src/execute.js";
import type { Statement } from "../src/ast.js";
import { mockDatabase, mockLexicon, retailSalesMock } from "./helpers/mocks.js";

function ast(src: string): Statement {
  const r = parse(tokenize(src));
  if (r.errors.length > 0) {
    throw new Error(`Parse failed: ${JSON.stringify(r.errors)}`);
  }
  if (!r.ast) throw new Error("No AST");
  return r.ast;
}

// ===========================================================================
// SHOW LEXICON
// ===========================================================================

describe("execute SHOW LEXICON", () => {
  it("returns all entries when no filters are supplied", async () => {
    const lexicon = mockLexicon();
    // Seed two entries through the runtime.
    await execute(
      ast(
        `REGISTER region q1_anomaly
           IMPACTING total_sales OVER 2026-Q1
           WITH "Q1 anomaly"`
      ),
      { semanticLayer: retailSalesMock(), database: mockDatabase(), lexicon }
    );
    await execute(
      ast(
        `REGISTER boundary aov_redef AT 2026-01-01
           IMPACTING average_order_value
           BEFORE "old" "v1" AFTER "new" "v2"`
      ),
      { semanticLayer: retailSalesMock(), database: mockDatabase(), lexicon }
    );

    const result = (await execute(ast("SHOW LEXICON"), {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
      lexicon,
    })) as ShowLexiconResult;

    assert.equal(result.statement, "show");
    assert.equal(result.subject, "lexicon");
    assert.equal(result.entries.length, 2);
    assert.equal(result.filters, undefined);
    const names = result.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["aov_redef", "q1_anomaly"]);
  });

  it("returns the matching entry when a single name filter matches", async () => {
    const lexicon = mockLexicon();
    await execute(
      ast(
        `REGISTER region q1_anomaly
           IMPACTING total_sales OVER 2026-Q1
           WITH "Q1 anomaly"`
      ),
      { semanticLayer: retailSalesMock(), database: mockDatabase(), lexicon }
    );

    const result = (await execute(ast("SHOW LEXICON q1_anomaly"), {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
      lexicon,
    })) as ShowLexiconResult;

    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].name, "q1_anomaly");
    assert.deepEqual(result.filters, ["q1_anomaly"]);
  });

  it("narrows to multiple entries when several names are listed", async () => {
    const lexicon = mockLexicon();
    for (const name of ["q1_anomaly", "q2_anomaly", "q3_anomaly"]) {
      await execute(
        ast(
          `REGISTER region ${name}
             IMPACTING total_sales OVER 2026-Q1
             WITH "anomaly"`
        ),
        { semanticLayer: retailSalesMock(), database: mockDatabase(), lexicon }
      );
    }

    const result = (await execute(
      ast("SHOW LEXICON q1_anomaly, q3_anomaly"),
      {
        semanticLayer: retailSalesMock(),
        database: mockDatabase(),
        lexicon,
      }
    )) as ShowLexiconResult;

    const names = result.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["q1_anomaly", "q3_anomaly"]);
    assert.deepEqual(result.filters, ["q1_anomaly", "q3_anomaly"]);
  });

  it("silently drops names that match no entry", async () => {
    const lexicon = mockLexicon();
    await execute(
      ast(
        `REGISTER region q1_anomaly
           IMPACTING total_sales OVER 2026-Q1
           WITH "Q1 anomaly"`
      ),
      { semanticLayer: retailSalesMock(), database: mockDatabase(), lexicon }
    );

    const result = (await execute(
      ast("SHOW LEXICON q1_anomaly, nonexistent"),
      {
        semanticLayer: retailSalesMock(),
        database: mockDatabase(),
        lexicon,
      }
    )) as ShowLexiconResult;

    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].name, "q1_anomaly");
    assert.deepEqual(result.filters, ["q1_anomaly", "nonexistent"]);
  });

  it("returns an empty entries list when no entry matches the filter", async () => {
    const lexicon = mockLexicon();
    const result = (await execute(ast("SHOW LEXICON nonexistent"), {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
      lexicon,
    })) as ShowLexiconResult;

    assert.equal(result.entries.length, 0);
    assert.deepEqual(result.filters, ["nonexistent"]);
  });

  it("returns an empty entries list when the lexicon is empty", async () => {
    const result = (await execute(ast("SHOW LEXICON"), {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
      lexicon: mockLexicon(),
    })) as ShowLexiconResult;

    assert.equal(result.entries.length, 0);
  });

  it("throws when no lexicon adapter is configured", async () => {
    await assert.rejects(
      execute(ast("SHOW LEXICON"), {
        semanticLayer: retailSalesMock(),
        database: mockDatabase(),
      }),
      /requires a lexicon adapter/
    );
  });
});

// ===========================================================================
// SHOW SCHEMA
// ===========================================================================

describe("execute SHOW SCHEMA", () => {
  it("returns each metric with its dimensions and primary time", async () => {
    const result = (await execute(ast("SHOW SCHEMA"), {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
    })) as ShowSchemaResult;

    assert.equal(result.statement, "show");
    assert.equal(result.subject, "schema");
    assert.ok(result.metrics.length > 0);

    const totalSales = result.metrics.find((m) => m.name === "total_sales");
    assert.ok(totalSales, "total_sales should be present");
    assert.equal(totalSales!.primaryTime, "order_date");
    const dimNames = totalSales!.dimensions.map((d) => d.name).sort();
    assert.ok(dimNames.includes("region"));
    assert.ok(dimNames.includes("product_tier"));
  });

  it("works without a lexicon adapter", async () => {
    // SHOW SCHEMA only reads from the semantic layer.
    const result = (await execute(ast("SHOW SCHEMA"), {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
    })) as ShowSchemaResult;
    assert.ok(result.metrics.length > 0);
  });
});

// ===========================================================================
// UNREGISTER
// ===========================================================================

describe("execute UNREGISTER", () => {
  it("removes a region entry and reports found: true", async () => {
    const lexicon = mockLexicon();
    await execute(
      ast(
        `REGISTER region q1_anomaly
           IMPACTING total_sales OVER 2026-Q1
           WITH "Q1 anomaly"`
      ),
      { semanticLayer: retailSalesMock(), database: mockDatabase(), lexicon }
    );

    const result = (await execute(ast("UNREGISTER q1_anomaly"), {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
      lexicon,
    })) as UnregisterResult;

    assert.equal(result.statement, "unregister");
    assert.equal(result.name, "q1_anomaly");
    assert.equal(result.found, true);
    assert.equal(lexicon.entries.length, 0);
  });

  it("removes a boundary entry regardless of kind", async () => {
    const lexicon = mockLexicon();
    await execute(
      ast(
        `REGISTER boundary aov_redef AT 2026-01-01
           IMPACTING average_order_value
           BEFORE "old" "v1" AFTER "new" "v2"`
      ),
      { semanticLayer: retailSalesMock(), database: mockDatabase(), lexicon }
    );

    const result = (await execute(ast("UNREGISTER aov_redef"), {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
      lexicon,
    })) as UnregisterResult;

    assert.equal(result.found, true);
    assert.equal(lexicon.entries.length, 0);
  });

  it("reports found: false when no entry by that name exists", async () => {
    const lexicon = mockLexicon();
    const result = (await execute(ast("UNREGISTER nope"), {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
      lexicon,
    })) as UnregisterResult;

    assert.equal(result.found, false);
    assert.equal(result.name, "nope");
  });

  it("only removes the named entry, leaving others intact", async () => {
    const lexicon = mockLexicon();
    await execute(
      ast(
        `REGISTER region a IMPACTING total_sales OVER 2026 WITH "a"`
      ),
      { semanticLayer: retailSalesMock(), database: mockDatabase(), lexicon }
    );
    await execute(
      ast(
        `REGISTER region b IMPACTING total_sales OVER 2026 WITH "b"`
      ),
      { semanticLayer: retailSalesMock(), database: mockDatabase(), lexicon }
    );
    assert.equal(lexicon.entries.length, 2);

    await execute(ast("UNREGISTER a"), {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
      lexicon,
    });

    assert.equal(lexicon.entries.length, 1);
    assert.equal(lexicon.entries[0].name, "b");
  });

  it("throws when no lexicon adapter is configured", async () => {
    await assert.rejects(
      execute(ast("UNREGISTER x"), {
        semanticLayer: retailSalesMock(),
        database: mockDatabase(),
      }),
      /requires a lexicon adapter/
    );
  });
});

// ===========================================================================
// Round trip: REGISTER → SHOW → UNREGISTER → SHOW
// ===========================================================================

describe("scenario — REGISTER / SHOW / UNREGISTER round trip", () => {
  it("registers an entry, sees it in SHOW, removes it, no longer sees it", async () => {
    const lexicon = mockLexicon();
    const ctx = {
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
      lexicon,
    };

    const reg = (await execute(
      ast(
        `REGISTER region promo IMPACTING total_sales OVER 2026-03 WITH "promo"`
      ),
      ctx
    )) as RegisterResult;
    assert.equal(reg.entry.name, "promo");

    const show1 = (await execute(ast("SHOW LEXICON"), ctx)) as ShowLexiconResult;
    assert.equal(show1.entries.length, 1);
    assert.equal(show1.entries[0].name, "promo");

    const unreg = (await execute(
      ast("UNREGISTER promo"),
      ctx
    )) as UnregisterResult;
    assert.equal(unreg.found, true);

    const show2 = (await execute(ast("SHOW LEXICON"), ctx)) as ShowLexiconResult;
    assert.equal(show2.entries.length, 0);
  });
});
