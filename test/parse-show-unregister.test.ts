import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parse.js";
import { tokenize } from "../src/tokenize.js";
import type { ShowStatement, UnregisterStatement } from "../src/ast.js";

function parseSrc(src: string) {
  return parse(tokenize(src));
}

function expectOk<T>(src: string, kind: string): T {
  const r = parseSrc(src);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.ok(r.ast);
  assert.equal(r.ast!.kind, kind);
  return r.ast as unknown as T;
}

// ===========================================================================
// SHOW LEXICON / SHOW SCHEMA
// ===========================================================================

describe("parse SHOW — happy paths", () => {
  it("parses SHOW LEXICON without filters", () => {
    const ast = expectOk<ShowStatement>("SHOW LEXICON", "show");
    assert.equal(ast.subject, "lexicon");
    assert.equal(ast.filters, undefined);
  });

  it("parses SHOW LEXICON with a single name filter", () => {
    const ast = expectOk<ShowStatement>(
      "SHOW LEXICON q1_data_quality_issue",
      "show"
    );
    assert.equal(ast.subject, "lexicon");
    assert.deepEqual(ast.filters?.map((f) => f.name), ["q1_data_quality_issue"]);
  });

  it("parses SHOW LEXICON with a comma-separated name list", () => {
    const ast = expectOk<ShowStatement>(
      "SHOW LEXICON q1_anomaly, aov_redef, ne_outage",
      "show"
    );
    assert.equal(ast.subject, "lexicon");
    assert.deepEqual(ast.filters?.map((f) => f.name), [
      "q1_anomaly",
      "aov_redef",
      "ne_outage",
    ]);
  });

  it("parses SHOW SCHEMA", () => {
    const ast = expectOk<ShowStatement>("SHOW SCHEMA", "show");
    assert.equal(ast.subject, "schema");
    assert.equal(ast.filters, undefined);
  });

  it("is case-insensitive on keywords and subject", () => {
    expectOk<ShowStatement>("show lexicon", "show");
    expectOk<ShowStatement>("Show Schema", "show");
    expectOk<ShowStatement>("SHOW Lexicon some_name", "show");
  });

  it("accepts trailing semicolon", () => {
    expectOk<ShowStatement>("SHOW LEXICON;", "show");
    expectOk<ShowStatement>("SHOW LEXICON a, b;", "show");
    expectOk<ShowStatement>("SHOW SCHEMA;", "show");
  });
});

describe("parse SHOW — errors", () => {
  it("errors when subject is missing", () => {
    const r = parseSrc("SHOW");
    assert.ok(r.errors.length > 0);
    assert.match(r.errors[0].message, /subject/i);
  });

  it("errors when subject is unknown", () => {
    const r = parseSrc("SHOW NONSENSE");
    assert.ok(r.errors.length > 0);
    assert.match(r.errors[0].message, /unknown SHOW subject/i);
  });

  it("rejects extra tokens after SHOW SCHEMA (schema takes no filter)", () => {
    const r = parseSrc("SHOW SCHEMA some_name");
    assert.ok(r.errors.length > 0);
    assert.match(r.errors[0].message, /Unexpected token/i);
  });

  it("errors when SHOW LEXICON list ends with a trailing comma", () => {
    const r = parseSrc("SHOW LEXICON a, b,");
    assert.ok(r.errors.length > 0);
    assert.match(r.errors[0].message, /Expected lexicon entry name/i);
  });
});

// ===========================================================================
// UNREGISTER
// ===========================================================================

describe("parse UNREGISTER — happy paths", () => {
  it("parses UNREGISTER with a name", () => {
    const ast = expectOk<UnregisterStatement>(
      "UNREGISTER my_entry",
      "unregister"
    );
    assert.equal(ast.name.name, "my_entry");
  });

  it("is case-insensitive on the keyword", () => {
    expectOk<UnregisterStatement>("unregister Some_Entry", "unregister");
  });

  it("accepts trailing semicolon", () => {
    expectOk<UnregisterStatement>("UNREGISTER x;", "unregister");
  });
});

describe("parse UNREGISTER — errors", () => {
  it("errors when name is missing", () => {
    const r = parseSrc("UNREGISTER");
    assert.ok(r.errors.length > 0);
    assert.match(r.errors[0].message, /entry name/i);
  });

  it("rejects extra tokens after the name", () => {
    const r = parseSrc("UNREGISTER my_entry extra");
    assert.ok(r.errors.length > 0);
    assert.match(r.errors[0].message, /Unexpected token/i);
  });
});

// ===========================================================================
// Statement dispatch — error message now mentions all five statements
// ===========================================================================

describe("parse — statement dispatch (v0.4.0)", () => {
  it("error message lists SHOW and UNREGISTER alongside COMPUTE/REGISTER/CHECK", () => {
    const r = parseSrc("SELECT *");
    assert.match(
      r.errors[0].message,
      /COMPUTE.*REGISTER.*CHECK.*SHOW.*UNREGISTER/
    );
  });
});
