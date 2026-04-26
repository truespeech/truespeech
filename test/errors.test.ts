import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  makeError,
  renderError,
  renderErrors,
  TrueSpeechExecutionError,
} from "../src/errors.js";
import { span } from "../src/source.js";

describe("makeError", () => {
  it("populates required fields", () => {
    const err = makeError({
      code: "unknown_metric",
      message: 'Unknown metric "foo"',
      span: span(8, 11),
    });
    assert.equal(err.code, "unknown_metric");
    assert.equal(err.message, 'Unknown metric "foo"');
    assert.deepEqual(err.span, { start: 8, end: 11 });
    assert.equal(err.notes, undefined);
    assert.equal(err.help, undefined);
    assert.equal(err.relatedSpans, undefined);
  });

  it("preserves notes, help, and relatedSpans when provided", () => {
    const err = makeError({
      code: "unknown_metric",
      message: 'Unknown metric "total_sals"',
      span: span(8, 18),
      notes: ["while resolving COMPUTE statement"],
      help: 'did you mean "total_sales"?',
      relatedSpans: [{ span: span(0, 7), label: "in this COMPUTE" }],
    });
    assert.deepEqual(err.notes, ["while resolving COMPUTE statement"]);
    assert.equal(err.help, 'did you mean "total_sales"?');
    assert.deepEqual(err.relatedSpans, [
      { span: { start: 0, end: 7 }, label: "in this COMPUTE" },
    ]);
  });

  it("omits empty notes array", () => {
    const err = makeError({
      code: "unknown_metric",
      message: "x",
      span: span(0, 1),
      notes: [],
    });
    assert.equal(err.notes, undefined);
  });

  it("omits empty relatedSpans array", () => {
    const err = makeError({
      code: "unknown_metric",
      message: "x",
      span: span(0, 1),
      relatedSpans: [],
    });
    assert.equal(err.relatedSpans, undefined);
  });
});

describe("TrueSpeechExecutionError", () => {
  it("wraps a list of errors", () => {
    const errs = [
      makeError({ code: "unknown_metric", message: "a", span: span(0, 1) }),
      makeError({ code: "unknown_dimension", message: "b", span: span(2, 3) }),
    ];
    const err = new TrueSpeechExecutionError(errs);
    assert.equal(err.errors.length, 2);
    assert.equal(err.name, "TrueSpeechExecutionError");
    assert.match(err.message, /2 errors/);
    assert.match(err.message, /unknown_metric/);
  });

  it("uses singular summary for one error", () => {
    const err = new TrueSpeechExecutionError([
      makeError({ code: "unknown_metric", message: "boom", span: span(0, 1) }),
    ]);
    assert.equal(err.message, "unknown_metric: boom");
  });

  it("handles empty error list gracefully", () => {
    const err = new TrueSpeechExecutionError([]);
    assert.equal(err.message, "no errors");
  });
});

describe("renderError", () => {
  const source = "COMPUTE total_sals OVER 2026-02";

  it("includes error code and message in header", () => {
    const err = makeError({
      code: "unknown_metric",
      message: 'Unknown metric "total_sals"',
      span: span(8, 18),
    });
    const rendered = renderError(err, source);
    assert.match(rendered, /error\[unknown_metric\]: Unknown metric "total_sals"/);
  });

  it("includes the line:column position", () => {
    const err = makeError({
      code: "unknown_metric",
      message: "x",
      span: span(8, 18),
    });
    const rendered = renderError(err, source);
    assert.match(rendered, /--> 1:9/);
  });

  it("renders the affected source line", () => {
    const err = makeError({
      code: "unknown_metric",
      message: "x",
      span: span(8, 18),
    });
    const rendered = renderError(err, source);
    assert.match(rendered, /1 \| COMPUTE total_sals OVER 2026-02/);
  });

  it("renders carets under the affected span", () => {
    const err = makeError({
      code: "unknown_metric",
      message: "x",
      span: span(8, 18),
    });
    const rendered = renderError(err, source);
    // 1 separator space + 8 indent spaces, then 10 carets matching "total_sals"
    assert.match(rendered, / \| {9}\^{10}(?!\^)/);
  });

  it("renders help line when present", () => {
    const err = makeError({
      code: "unknown_metric",
      message: "x",
      span: span(8, 18),
      help: 'did you mean "total_sales"?',
    });
    const rendered = renderError(err, source);
    assert.match(rendered, /= help: did you mean "total_sales"\?/);
  });

  it("renders notes when present", () => {
    const err = makeError({
      code: "unknown_metric",
      message: "x",
      span: span(8, 18),
      notes: ["while resolving COMPUTE"],
    });
    const rendered = renderError(err, source);
    assert.match(rendered, /= note: while resolving COMPUTE/);
  });

  it("handles errors on later lines", () => {
    const multilineSrc = "COMPUTE total_sales\nOVER bogus_region";
    const err = makeError({
      code: "unexpected_token",
      message: "expected calendar unit",
      span: span(25, 37),
    });
    const rendered = renderError(err, multilineSrc);
    assert.match(rendered, /--> 2:6/);
    assert.match(rendered, /2 \| OVER bogus_region/);
  });
});

describe("renderErrors", () => {
  it("joins multiple errors with blank lines", () => {
    const source = "COMPUTE x";
    const errs = [
      makeError({ code: "unknown_metric", message: "a", span: span(0, 1) }),
      makeError({ code: "unknown_metric", message: "b", span: span(0, 1) }),
    ];
    const rendered = renderErrors(errs, source);
    const blocks = rendered.split("\n\n");
    assert.equal(blocks.length, 2);
  });
});
