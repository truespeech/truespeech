import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VERSION,
  TrueSpeech,
  TrueSpeechExecutionError,
  renderError,
  renderRegion,
} from "../src/index.js";
import type {
  ComputeResult,
  RegisterResult,
  CheckResult,
} from "../src/index.js";
import {
  mockDatabase,
  mockLexicon,
  retailSalesMock,
} from "./helpers/mocks.js";

describe("smoke", () => {
  it("exports a VERSION", () => {
    assert.equal(typeof VERSION, "string");
  });
});

describe("TrueSpeech — public API", () => {
  function build() {
    const semanticLayer = retailSalesMock();
    const database = mockDatabase({
      columns: ["region", "total_sales"],
      rows: [
        ["northeast", 100],
        ["west", 200],
      ],
    });
    return { ts: new TrueSpeech({ semanticLayer, database }), database };
  }

  it("tokenize() returns tokens with EOF marker", () => {
    const { ts } = build();
    const tokens = ts.tokenize("COMPUTE total_sales OVER 2026");
    assert.ok(tokens.length > 1);
    assert.equal(tokens[tokens.length - 1].kind, "eof");
  });

  it("parse() returns ast and errors as data", () => {
    const { ts } = build();
    const r = ts.parse("COMPUTE total_sales OVER 2026");
    assert.equal(r.errors.length, 0);
    assert.ok(r.ast);
  });

  it("parse() does not throw on bad input", () => {
    const { ts } = build();
    const r = ts.parse("SELECT * FROM orders");
    assert.ok(r.errors.length > 0);
    // Should not have thrown
  });

  it("validate() returns errors as data", () => {
    const { ts } = build();
    const r = ts.parse("COMPUTE bogus_metric OVER 2026");
    assert.ok(r.ast);
    const v = ts.validate(r.ast!);
    assert.ok(v.errors.length > 0);
    assert.equal(v.errors[0].code, "unknown_metric");
  });

  it("execute() returns full result", async () => {
    const { ts } = build();
    const result = await ts.execute(
      "COMPUTE total_sales OVER 2026 GROUP BY region"
    );
    assert.equal(result.statement, "compute");
    assert.equal(result.semanticQuery.metric, "total_sales");
    assert.ok(result.sql.length > 0);
    assert.equal(result.results.rows.length, 2);
  });

  it("execute() throws TrueSpeechExecutionError on parse error", async () => {
    const { ts } = build();
    await assert.rejects(
      () => ts.execute("SELECT * FROM orders"),
      TrueSpeechExecutionError
    );
  });

  it("execute() throws TrueSpeechExecutionError on validation error", async () => {
    const { ts } = build();
    try {
      await ts.execute("COMPUTE bogus_metric OVER 2026");
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof TrueSpeechExecutionError);
      assert.equal((e as TrueSpeechExecutionError).errors[0].code, "unknown_metric");
    }
  });

  it("execute() error can be rendered with renderError", async () => {
    const { ts } = build();
    const source = "COMPUTE bogus_metric OVER 2026";
    try {
      await ts.execute(source);
      assert.fail("expected throw");
    } catch (e) {
      const err = (e as TrueSpeechExecutionError).errors[0];
      const rendered = renderError(err, source);
      assert.match(rendered, /error\[unknown_metric\]/);
      assert.match(rendered, /bogus_metric/);
    }
  });

  it("execute() runs the SQL the semantic layer produced", async () => {
    const { ts, database } = build();
    await ts.execute("COMPUTE total_sales OVER 2026");
    assert.equal(database.executed.length, 1);
  });
});

describe("TrueSpeech — lexicon end-to-end", () => {
  function build() {
    const semanticLayer = retailSalesMock();
    const database = mockDatabase({
      columns: ["region", "total_sales"],
      rows: [["northeast", 100]],
    });
    const lexicon = mockLexicon();
    return {
      ts: new TrueSpeech({ semanticLayer, database, lexicon }),
      lexicon,
      database,
    };
  }

  it("REGISTER → CHECK round-trip surfaces the entry with overlap", async () => {
    const { ts, lexicon } = build();

    const reg = (await ts.execute(
      `REGISTER region bot IMPACTING total_sales OVER 2026-02-03 to 2026-02-04 WITH "credential stuffing"`
    )) as RegisterResult;
    assert.equal(reg.statement, "register");
    assert.equal(lexicon.entries.length, 1);

    const chk = (await ts.execute(
      `CHECK total_sales OVER 2026-Q1`
    )) as CheckResult;
    assert.equal(chk.matches.length, 1);
    assert.equal(chk.matches[0].entry.name, "bot");
    assert.equal(chk.matches[0].overlap.timeStart, "2026-02-03");
    assert.equal(chk.matches[0].overlap.timeEnd, "2026-02-04");
  });

  it("REGISTER → COMPUTE surfaces overlap in result.reconciliation", async () => {
    const { ts } = build();
    await ts.execute(
      `REGISTER region mobile_bug IMPACTING total_sales OVER 2025-07 to 2025-12 WITH "events undercounted"`
    );

    const c = (await ts.execute(
      `COMPUTE total_sales OVER 2025-09`
    )) as ComputeResult;
    assert.equal(c.reconciliation.length, 1);
    assert.equal(c.reconciliation[0].entry.name, "mobile_bug");
    assert.equal(c.reconciliation[0].overlap.timeStart, "2025-09-01");
    assert.equal(c.reconciliation[0].overlap.timeEnd, "2025-09-30");
  });

  it("non-overlapping COMPUTE returns empty reconciliation", async () => {
    const { ts } = build();
    await ts.execute(
      `REGISTER region bot IMPACTING total_sales OVER 2026-02-03 to 2026-02-04 WITH "x"`
    );
    const c = (await ts.execute(
      `COMPUTE total_sales OVER 2026-03`
    )) as ComputeResult;
    assert.deepEqual(c.reconciliation, []);
  });

  it("REGISTER region without lexicon throws on execute()", async () => {
    const ts = new TrueSpeech({
      semanticLayer: retailSalesMock(),
      database: mockDatabase(),
    });
    await assert.rejects(
      () =>
        ts.execute(
          `REGISTER region bot IMPACTING total_sales OVER 2026 WITH "x"`
        ),
      /requires a lexicon adapter/
    );
  });

  it("renderRegion is exported and usable on a CHECK match", async () => {
    const { ts } = build();
    await ts.execute(
      `REGISTER region bot IMPACTING total_sales OVER 2026-Q1 WITH "x"`
    );
    const chk = (await ts.execute(
      `CHECK total_sales OVER 2026`
    )) as CheckResult;
    assert.equal(renderRegion(chk.matches[0].overlap), "2026-Q1");
  });
});
