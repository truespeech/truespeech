import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../src/tokenize.js";
import type { Token, TokenKind } from "../src/tokens.js";

// ---------- helpers ----------

function kinds(tokens: Token[]): TokenKind[] {
  return tokens.map((t) => t.kind);
}

function texts(tokens: Token[]): string[] {
  return tokens.map((t) => t.text);
}

// Drop the trailing eof token for brevity in many assertions.
function noEof(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.kind !== "eof");
}

// ---------- empty / whitespace ----------

describe("tokenize — empty and whitespace", () => {
  it("returns just an eof token for empty input", () => {
    const t = tokenize("");
    assert.equal(t.length, 1);
    assert.equal(t[0].kind, "eof");
    assert.deepEqual(t[0].span, { start: 0, end: 0 });
  });

  it("skips whitespace and emits only eof", () => {
    const t = tokenize("  \t\n  ");
    assert.deepEqual(kinds(t), ["eof"]);
    assert.equal(t[0].span.start, 6);
  });
});

// ---------- words ----------

describe("tokenize — keywords, grains, time-keywords", () => {
  it("classifies COMPUTE as keyword", () => {
    const t = noEof(tokenize("COMPUTE"));
    assert.deepEqual(kinds(t), ["keyword"]);
    assert.equal(t[0].text, "COMPUTE");
  });

  it("is case-insensitive for keywords", () => {
    for (const form of ["compute", "Compute", "COMPUTE", "cOmPuTe"]) {
      const t = noEof(tokenize(form));
      assert.deepEqual(kinds(t), ["keyword"], form);
      assert.equal(t[0].text, form, "preserves original case");
    }
  });

  it("classifies all defined keywords", () => {
    const words = [
      "compute",
      "over",
      "and",
      "group",
      "by",
      "order",
      "limit",
      "in",
      "not",
      "asc",
      "desc",
    ];
    for (const w of words) {
      const t = noEof(tokenize(w));
      assert.deepEqual(kinds(t), ["keyword"], w);
    }
  });

  it("classifies grain words as grain", () => {
    for (const w of ["day", "week", "month", "quarter", "year"]) {
      const t = noEof(tokenize(w));
      assert.deepEqual(kinds(t), ["grain"], w);
    }
  });

  it("classifies time-keywords as time-keyword", () => {
    for (const w of ["until", "since", "all", "time", "to"]) {
      const t = noEof(tokenize(w));
      assert.deepEqual(kinds(t), ["time-keyword"], w);
    }
  });

  it("classifies arbitrary words as identifier", () => {
    for (const w of ["total_sales", "region", "x", "_underscore", "abc123"]) {
      const t = noEof(tokenize(w));
      assert.deepEqual(kinds(t), ["identifier"], w);
      assert.equal(t[0].text, w);
    }
  });
});

// ---------- numbers and time literals ----------

describe("tokenize — numbers", () => {
  it("tokenizes a bare digit run as number", () => {
    const t = noEof(tokenize("42"));
    assert.deepEqual(kinds(t), ["number"]);
    assert.equal(t[0].text, "42");
  });

  it("tokenizes a 4-digit year alone as number (parser disambiguates)", () => {
    const t = noEof(tokenize("2026"));
    assert.deepEqual(kinds(t), ["number"]);
    assert.equal(t[0].text, "2026");
  });
});

describe("tokenize — time literals", () => {
  it("tokenizes year-quarter form", () => {
    const t = noEof(tokenize("2026-Q1"));
    assert.deepEqual(kinds(t), ["time-literal"]);
    assert.equal(t[0].text, "2026-Q1");
  });

  it("tokenizes year-month form", () => {
    const t = noEof(tokenize("2026-02"));
    assert.deepEqual(kinds(t), ["time-literal"]);
    assert.equal(t[0].text, "2026-02");
  });

  it("tokenizes year-month-day form", () => {
    const t = noEof(tokenize("2026-02-15"));
    assert.deepEqual(kinds(t), ["time-literal"]);
    assert.equal(t[0].text, "2026-02-15");
  });

  it("accepts lowercase q in quarter form", () => {
    const t = noEof(tokenize("2026-q3"));
    assert.deepEqual(kinds(t), ["time-literal"]);
    assert.equal(t[0].text, "2026-q3");
  });

  it("emits time-literal for lexically-valid but semantically-bogus values", () => {
    // Validator's job to reject Q9 / month 13 with a helpful error.
    for (const lit of ["2026-Q9", "2026-13", "2026-99-99"]) {
      const t = noEof(tokenize(lit));
      assert.deepEqual(kinds(t), ["time-literal"], lit);
      assert.equal(t[0].text, lit);
    }
  });
});

// ---------- strings ----------

describe("tokenize — strings", () => {
  it("tokenizes single-quoted string", () => {
    const t = noEof(tokenize("'northeast'"));
    assert.deepEqual(kinds(t), ["string"]);
    assert.equal(t[0].text, "'northeast'");
  });

  it("preserves spaces inside string", () => {
    const t = noEof(tokenize("'with spaces'"));
    assert.equal(t[0].text, "'with spaces'");
  });

  it("emits an error token for an unterminated string", () => {
    const t = noEof(tokenize("'no end"));
    assert.deepEqual(kinds(t), ["error"]);
    assert.equal(t[0].text, "'no end");
  });
});

// ---------- operators ----------

describe("tokenize — operators", () => {
  it("tokenizes single-char operators", () => {
    for (const op of ["=", ">", "<"]) {
      const t = noEof(tokenize(op));
      assert.deepEqual(kinds(t), ["operator"], op);
      assert.equal(t[0].text, op);
    }
  });

  it("tokenizes two-char operators", () => {
    for (const op of ["!=", ">=", "<="]) {
      const t = noEof(tokenize(op));
      assert.deepEqual(kinds(t), ["operator"], op);
      assert.equal(t[0].text, op);
    }
  });

  it("emits error token for bare !", () => {
    const t = noEof(tokenize("!"));
    assert.deepEqual(kinds(t), ["error"]);
  });

  it("does not greedily merge > and = when separated", () => {
    const t = noEof(tokenize("> ="));
    assert.deepEqual(texts(t), [">", "="]);
  });
});

// ---------- punctuation ----------

describe("tokenize — punctuation", () => {
  it("tokenizes parens, comma, semicolon, colon", () => {
    const t = noEof(tokenize("(),;:"));
    assert.deepEqual(kinds(t), [
      "punctuation",
      "punctuation",
      "punctuation",
      "punctuation",
      "punctuation",
    ]);
    assert.deepEqual(texts(t), ["(", ")", ",", ";", ":"]);
  });

  it("tokenizes dimension-with-grain syntax", () => {
    const t = noEof(tokenize("ship_date:week"));
    assert.deepEqual(kinds(t), ["identifier", "punctuation", "grain"]);
    assert.deepEqual(texts(t), ["ship_date", ":", "week"]);
  });
});

// ---------- error handling ----------

describe("tokenize — error tokens", () => {
  it("emits error token for unrecognized char", () => {
    const t = noEof(tokenize("@"));
    assert.deepEqual(kinds(t), ["error"]);
    assert.equal(t[0].text, "@");
  });

  it("continues tokenizing after an error", () => {
    const t = noEof(tokenize("@ region"));
    assert.deepEqual(kinds(t), ["error", "identifier"]);
    assert.deepEqual(texts(t), ["@", "region"]);
  });
});

// ---------- spans ----------

describe("tokenize — spans", () => {
  it("tracks span for a single token", () => {
    const t = noEof(tokenize("COMPUTE"));
    assert.deepEqual(t[0].span, { start: 0, end: 7 });
  });

  it("tracks spans across whitespace", () => {
    const t = noEof(tokenize("  COMPUTE  total_sales"));
    assert.deepEqual(t[0].span, { start: 2, end: 9 });
    assert.deepEqual(t[1].span, { start: 11, end: 22 });
  });

  it("tracks span for time literal", () => {
    const t = noEof(tokenize("OVER 2026-02-15"));
    assert.deepEqual(t[0].span, { start: 0, end: 4 });
    assert.deepEqual(t[1].span, { start: 5, end: 15 });
  });

  it("EOF span sits at the end of source", () => {
    const t = tokenize("COMPUTE");
    const eof = t[t.length - 1];
    assert.equal(eof.kind, "eof");
    assert.deepEqual(eof.span, { start: 7, end: 7 });
  });

  it("EOF span sits at the end after trailing whitespace", () => {
    const t = tokenize("COMPUTE   ");
    const eof = t[t.length - 1];
    assert.deepEqual(eof.span, { start: 10, end: 10 });
  });
});

// ---------- compound input ----------

describe("tokenize — compound", () => {
  it("tokenizes a full COMPUTE statement", () => {
    const src =
      "COMPUTE total_sales OVER 2026-02 AND region = 'northeast' GROUP BY month";
    const t = noEof(tokenize(src));
    assert.deepEqual(kinds(t), [
      "keyword", // COMPUTE
      "identifier", // total_sales
      "keyword", // OVER
      "time-literal", // 2026-02
      "keyword", // AND
      "identifier", // region
      "operator", // =
      "string", // 'northeast'
      "keyword", // GROUP
      "keyword", // BY
      "grain", // month
    ]);
  });

  it("tokenizes IN with parenthesized list", () => {
    const t = noEof(tokenize("region IN ('northeast', 'west')"));
    assert.deepEqual(kinds(t), [
      "identifier",
      "keyword",
      "punctuation",
      "string",
      "punctuation",
      "string",
      "punctuation",
    ]);
  });

  it("tokenizes range form with 'to'", () => {
    const t = noEof(tokenize("2026-02-03 to 2026-02-10"));
    assert.deepEqual(kinds(t), ["time-literal", "time-keyword", "time-literal"]);
  });

  it("tokenizes 'all time' as two tokens", () => {
    const t = noEof(tokenize("all time"));
    assert.deepEqual(kinds(t), ["time-keyword", "time-keyword"]);
    assert.deepEqual(texts(t), ["all", "time"]);
  });

  it("tokenizes 'until 2026-Q1'", () => {
    const t = noEof(tokenize("until 2026-Q1"));
    assert.deepEqual(kinds(t), ["time-keyword", "time-literal"]);
  });

  it("handles trailing semicolon", () => {
    const t = noEof(tokenize("COMPUTE total_sales;"));
    const last = t[t.length - 1];
    assert.equal(last.kind, "punctuation");
    assert.equal(last.text, ";");
  });
});
