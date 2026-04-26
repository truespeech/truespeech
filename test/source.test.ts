import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { span, spanFrom, positionAt } from "../src/source.js";

describe("span", () => {
  it("constructs from start and end offsets", () => {
    assert.deepEqual(span(3, 7), { start: 3, end: 7 });
  });
});

describe("spanFrom", () => {
  it("combines two spans into one covering both", () => {
    const result = spanFrom(span(2, 5), span(8, 12));
    assert.deepEqual(result, { start: 2, end: 12 });
  });

  it("works when spans are adjacent", () => {
    assert.deepEqual(spanFrom(span(0, 4), span(4, 9)), { start: 0, end: 9 });
  });

  it("works when first equals last (single token)", () => {
    assert.deepEqual(spanFrom(span(3, 7), span(3, 7)), { start: 3, end: 7 });
  });
});

describe("positionAt", () => {
  it("returns line 1 column 1 for offset 0", () => {
    assert.deepEqual(positionAt("hello", 0), {
      offset: 0,
      line: 1,
      column: 1,
    });
  });

  it("counts columns within a line", () => {
    assert.deepEqual(positionAt("hello world", 6), {
      offset: 6,
      line: 1,
      column: 7,
    });
  });

  it("advances line on newline", () => {
    assert.deepEqual(positionAt("a\nb", 2), {
      offset: 2,
      line: 2,
      column: 1,
    });
  });

  it("handles multiple lines", () => {
    const src = "first\nsecond\nthird";
    assert.deepEqual(positionAt(src, 13), {
      offset: 13,
      line: 3,
      column: 1,
    });
  });

  it("clamps to source length without crashing", () => {
    const pos = positionAt("abc", 100);
    assert.equal(pos.line, 1);
    assert.equal(pos.column, 4);
  });
});
