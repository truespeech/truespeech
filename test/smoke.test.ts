import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VERSION,
  TrueSpeech,
  TrueSpeechExecutionError,
  renderError,
} from "../src/index.js";
import { mockDatabase, retailSalesMock } from "./helpers/mocks.js";

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
