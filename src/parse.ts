// Parser: Token[] → { ast, errors }.
//
// Recursive descent. Errors are collected, not thrown — when a sub-parse
// fails irrecoverably it returns null and we sync to the next plausible
// clause boundary so we can keep going. The result always reflects what
// we managed to recognize plus the full list of problems we found.
//
// Spans on AST nodes always point back into the original source text via
// the spans of the tokens that were consumed to build them.

import type {
  Statement,
  ComputeStatement,
  RegisterStatement,
  CheckStatement,
  ImpactClause,
  StringLiteral,
  MetricRef,
  OverClause,
  TimeRegion,
  AllTimeRegion,
  CalendarRegion,
  RangeRegion,
  UntilRegion,
  SinceRegion,
  TimeLiteral,
  Constraint,
  ConstraintPredicate,
  ComparisonOperator,
  ConstraintValue,
  Identifier,
  GroupByClause,
  Grain,
  OrderByClause,
  OrderDirection,
  NumberLiteral,
} from "./ast.js";
import type { Token, TokenKind } from "./tokens.js";
import type { Span } from "./source.js";
import { spanFrom } from "./source.js";
import type { TrueSpeechError, ErrorCode } from "./errors.js";
import { makeError } from "./errors.js";

export interface ParseResult {
  ast: Statement | null;
  errors: TrueSpeechError[];
}

export function parse(tokens: Token[]): ParseResult {
  const p = new Parser(tokens);
  const ast = p.parseStatement();
  return { ast, errors: p.errors };
}

const COMPARISON_OPS = new Set(["=", "!=", ">", "<", ">=", "<="]);
const GRAIN_TEXTS = new Set(["day", "week", "month", "quarter", "year"]);

class Parser {
  pos = 0;
  errors: TrueSpeechError[] = [];

  constructor(public tokens: Token[]) {}

  // ===== Helpers =====

  peek(offset = 0): Token {
    const i = this.pos + offset;
    if (i >= this.tokens.length) return this.tokens[this.tokens.length - 1];
    return this.tokens[i];
  }

  advance(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.pos++;
    return t;
  }

  isAtEnd(): boolean {
    return this.peek().kind === "eof";
  }

  // True if the current token matches kind (and optional case-insensitive
  // text); does NOT advance.
  check(kind: TokenKind, text?: string): boolean {
    const t = this.peek();
    if (t.kind !== kind) return false;
    if (text !== undefined && t.text.toLowerCase() !== text.toLowerCase())
      return false;
    return true;
  }

  // Advance if current token matches, else return null.
  match(kind: TokenKind, text?: string): Token | null {
    if (!this.check(kind, text)) return null;
    return this.advance();
  }

  matchKeyword(text: string): Token | null {
    return this.match("keyword", text);
  }

  matchTimeKeyword(text: string): Token | null {
    return this.match("time-keyword", text);
  }

  matchPunct(text: string): Token | null {
    return this.match("punctuation", text);
  }

  // Advance if current token matches, else emit error (and don't advance).
  expect(
    kind: TokenKind,
    text: string | undefined,
    code: ErrorCode,
    message: string,
    help?: string
  ): Token | null {
    if (this.check(kind, text)) return this.advance();
    this.errorHere(code, message, help);
    return null;
  }

  errorAt(
    span: Span,
    code: ErrorCode,
    message: string,
    help?: string
  ): void {
    this.errors.push(makeError({ code, message, span, help }));
  }

  errorHere(code: ErrorCode, message: string, help?: string): void {
    this.errorAt(this.peek().span, code, message, help);
  }

  // Skip tokens until we find one of the sync targets (or EOF). Used for
  // error recovery so a single failure doesn't cascade.
  syncTo(targets: { kind: TokenKind; text?: string }[]): void {
    while (!this.isAtEnd()) {
      for (const t of targets) {
        if (this.check(t.kind, t.text)) return;
      }
      this.advance();
    }
  }

  // ===== Statement =====

  parseStatement(): Statement | null {
    if (this.check("keyword", "compute")) {
      return this.parseCompute();
    }
    if (this.check("keyword", "register")) {
      return this.parseRegister();
    }
    if (this.check("keyword", "check")) {
      return this.parseCheck();
    }
    if (this.isAtEnd()) {
      this.errorHere("unexpected_eof", "Empty input — expected a statement");
      return null;
    }
    const tok = this.peek();
    this.errorAt(
      tok.span,
      "unexpected_token",
      `Expected COMPUTE, REGISTER, or CHECK, got "${tok.text}"`
    );
    return null;
  }

  // ===== COMPUTE =====

  parseCompute(): ComputeStatement | null {
    const computeTok = this.advance(); // COMPUTE

    const metrics = this.parseMetricList();
    if (metrics.length === 0) return null;

    if (!this.matchKeyword("over")) {
      this.errorHere(
        "expected_token",
        "Expected OVER after metric list",
        "Every COMPUTE statement must have an OVER clause specifying the time region"
      );
      // Try to keep going — sync to a clause boundary
      this.syncTo([
        { kind: "keyword", text: "group" },
        { kind: "keyword", text: "order" },
        { kind: "keyword", text: "limit" },
        { kind: "punctuation", text: ";" },
      ]);
      return null;
    }

    const over = this.parseOverClause();
    if (!over) return null;

    let groupBy: GroupByClause[] | undefined;
    if (this.matchKeyword("group")) {
      if (
        !this.expect(
          "keyword",
          "by",
          "expected_token",
          "Expected BY after GROUP"
        )
      ) {
        return null;
      }
      groupBy = this.parseGroupByList();
    }

    let orderBy: OrderByClause[] | undefined;
    if (this.matchKeyword("order")) {
      if (
        !this.expect(
          "keyword",
          "by",
          "expected_token",
          "Expected BY after ORDER"
        )
      ) {
        return null;
      }
      orderBy = this.parseOrderByList();
    }

    let limit: NumberLiteral | undefined;
    if (this.matchKeyword("limit")) {
      limit = this.parseNumberLiteral() ?? undefined;
    }

    this.matchPunct(";"); // optional terminator

    if (!this.isAtEnd()) {
      const tok = this.peek();
      this.errorAt(
        tok.span,
        "unexpected_token",
        `Unexpected token "${tok.text}" after end of statement`
      );
    }

    const lastTok = this.tokens[Math.max(0, this.pos - 1)];
    return {
      kind: "compute",
      metrics,
      over,
      groupBy,
      orderBy,
      limit,
      span: spanFrom(computeTok.span, lastTok.span ?? computeTok.span),
    };
  }

  // ===== REGISTER =====

  parseRegister(): RegisterStatement | null {
    const registerTok = this.advance(); // REGISTER

    // Entry kind — currently only "region", but required at parse time
    // so adding new kinds (e.g. "boundary") later is non-breaking. Soft
    // keyword: "region" is also a valid identifier (it's a common
    // dimension name) so we match it as text rather than tokenizing it
    // as a reserved word.
    if (
      !this.expect(
        "identifier",
        "region",
        "expected_token",
        'Expected entry kind "region" after REGISTER',
        "REGISTER takes an entry kind followed by the entry name; only `region` is currently defined"
      )
    ) {
      return null;
    }

    const nameTok = this.expect(
      "identifier",
      undefined,
      "expected_token",
      "Expected an entry name (identifier) after REGISTER region"
    );
    if (!nameTok) return null;
    const name: Identifier = { name: nameTok.text, span: nameTok.span };

    // At least one IMPACTING clause is required.
    if (!this.check("keyword", "impacting")) {
      this.errorHere(
        "expected_token",
        "Expected IMPACTING after entry name",
        "REGISTER must include at least one IMPACTING clause"
      );
      return null;
    }

    const impactClauses: ImpactClause[] = [];
    while (this.check("keyword", "impacting")) {
      const clause = this.parseImpactClause();
      if (!clause) return null;
      impactClauses.push(clause);
    }

    if (
      !this.expect(
        "keyword",
        "with",
        "expected_token",
        "Expected WITH after IMPACTING clauses",
        "REGISTER requires a WITH <description> clause"
      )
    ) {
      return null;
    }

    const description = this.parseStringLiteral();
    if (!description) return null;

    this.matchPunct(";"); // optional terminator

    if (!this.isAtEnd()) {
      const tok = this.peek();
      this.errorAt(
        tok.span,
        "unexpected_token",
        `Unexpected token "${tok.text}" after end of statement`
      );
    }

    const lastTok = this.tokens[Math.max(0, this.pos - 1)];
    return {
      kind: "register",
      entryKind: "region",
      name,
      impactClauses,
      description,
      span: spanFrom(registerTok.span, lastTok.span ?? registerTok.span),
    };
  }

  parseImpactClause(): ImpactClause | null {
    const impactingTok = this.advance(); // IMPACTING
    const metrics = this.parseMetricList();
    if (metrics.length === 0) {
      this.errorAt(
        impactingTok.span,
        "expected_token",
        "Expected at least one metric after IMPACTING"
      );
      return null;
    }

    if (!this.matchKeyword("over")) {
      this.errorHere(
        "expected_token",
        "Expected OVER after metric list in IMPACTING clause"
      );
      return null;
    }

    const over = this.parseOverClause();
    if (!over) return null;

    return {
      metrics,
      over,
      span: spanFrom(impactingTok.span, over.span),
    };
  }

  parseStringLiteral(): StringLiteral | null {
    const tok = this.peek();
    if (tok.kind !== "string") {
      this.errorAt(
        tok.span,
        "expected_token",
        `Expected a string literal, got "${tok.text}"`
      );
      return null;
    }
    this.advance();
    return {
      value: tok.text.slice(1, -1),
      text: tok.text,
      span: tok.span,
    };
  }

  // ===== CHECK =====

  parseCheck(): CheckStatement | null {
    const checkTok = this.advance(); // CHECK

    const metrics = this.parseMetricList();
    if (metrics.length === 0) return null;

    if (!this.matchKeyword("over")) {
      this.errorHere(
        "expected_token",
        "Expected OVER after metric list",
        "CHECK requires an OVER clause — use 'OVER all time' for the unbounded case"
      );
      return null;
    }

    const over = this.parseOverClause();
    if (!over) return null;

    this.matchPunct(";");

    if (!this.isAtEnd()) {
      const tok = this.peek();
      this.errorAt(
        tok.span,
        "unexpected_token",
        `Unexpected token "${tok.text}" after end of statement`
      );
    }

    const lastTok = this.tokens[Math.max(0, this.pos - 1)];
    return {
      kind: "check",
      metrics,
      over,
      span: spanFrom(checkTok.span, lastTok.span ?? checkTok.span),
    };
  }

  // ===== Metric list =====

  parseMetricList(): MetricRef[] {
    const metrics: MetricRef[] = [];
    const first = this.expect(
      "identifier",
      undefined,
      "expected_token",
      "Expected metric name after COMPUTE"
    );
    if (!first) return metrics;
    metrics.push({ name: first.text, span: first.span });

    while (this.matchPunct(",")) {
      const next = this.expect(
        "identifier",
        undefined,
        "expected_token",
        "Expected metric name after ','"
      );
      if (!next) break;
      metrics.push({ name: next.text, span: next.span });
    }
    return metrics;
  }

  // ===== OVER clause =====

  parseOverClause(): OverClause | null {
    const start = this.peek().span;
    const primaryTime = this.parseTimeRegion();
    if (!primaryTime) return null;

    const constraints: Constraint[] = [];
    while (this.matchKeyword("and")) {
      const c = this.parseConstraint();
      if (c) constraints.push(c);
      else break;
    }

    const end = this.tokens[Math.max(0, this.pos - 1)].span;
    return {
      primaryTime,
      constraints,
      span: spanFrom(start, end),
    };
  }

  // ===== Time region =====

  parseTimeRegion(): TimeRegion | null {
    // all time
    if (this.check("time-keyword", "all")) {
      const allTok = this.advance();
      if (!this.matchTimeKeyword("time")) {
        this.errorHere(
          "expected_token",
          'Expected "time" after "all"',
          'The unbounded time region is written "all time"'
        );
        return null;
      }
      const lastTok = this.tokens[this.pos - 1];
      const region: AllTimeRegion = {
        kind: "all-time",
        span: spanFrom(allTok.span, lastTok.span),
      };
      return region;
    }

    // until <bound>
    if (this.check("time-keyword", "until")) {
      const untilTok = this.advance();
      const bound = this.parseTimeLiteralOrYear();
      if (!bound) return null;
      const region: UntilRegion = {
        kind: "until",
        bound,
        span: spanFrom(untilTok.span, bound.span),
      };
      return region;
    }

    // since <bound>
    if (this.check("time-keyword", "since")) {
      const sinceTok = this.advance();
      const bound = this.parseTimeLiteralOrYear();
      if (!bound) return null;
      const region: SinceRegion = {
        kind: "since",
        bound,
        span: spanFrom(sinceTok.span, bound.span),
      };
      return region;
    }

    // calendar literal or range
    if (this.check("time-literal") || this.check("number")) {
      const first = this.parseTimeLiteralOrYear();
      if (!first) return null;

      // range: <first> to <second>
      if (this.matchTimeKeyword("to")) {
        const second = this.parseTimeLiteralOrYear();
        if (!second) return null;
        const region: RangeRegion = {
          kind: "range",
          start: first,
          end: second,
          span: spanFrom(first.span, second.span),
        };
        return region;
      }

      // single calendar region
      const region: CalendarRegion = {
        kind: "calendar",
        literal: first,
        span: first.span,
      };
      return region;
    }

    this.errorHere(
      "expected_token",
      "Expected a time region",
      'Use a calendar literal (e.g. 2026, 2026-Q1, 2026-02), a range (X to Y), "until X", "since X", or "all time"'
    );
    return null;
  }

  // ===== Time literals =====

  // Parse a single calendar reference: either a 4-digit number (year
  // shorthand) or an explicit time-literal token.
  parseTimeLiteralOrYear(): TimeLiteral | null {
    const tok = this.peek();
    if (tok.kind === "number") {
      this.advance();
      if (!/^\d{4}$/.test(tok.text)) {
        this.errorAt(
          tok.span,
          "malformed_time_literal",
          `Expected a 4-digit year, got "${tok.text}"`
        );
        return null;
      }
      return {
        unit: "year",
        year: parseInt(tok.text, 10),
        text: tok.text,
        span: tok.span,
      };
    }
    if (tok.kind === "time-literal") {
      this.advance();
      const lit = parseTimeLiteralText(tok.text, tok.span);
      if ("error" in lit) {
        this.errorAt(tok.span, "malformed_time_literal", lit.error);
        return null;
      }
      return lit;
    }
    this.errorAt(
      tok.span,
      "expected_token",
      `Expected a time literal, got "${tok.text}"`
    );
    return null;
  }

  // ===== Constraints =====

  parseConstraint(): Constraint | null {
    const dimTok = this.expect(
      "identifier",
      undefined,
      "expected_token",
      "Expected dimension name"
    );
    if (!dimTok) return null;
    const dimension: Identifier = { name: dimTok.text, span: dimTok.span };

    const predicate = this.parseConstraintPredicate();
    if (!predicate) return null;

    return {
      dimension,
      predicate,
      span: spanFrom(dimension.span, predicate.span),
    };
  }

  parseConstraintPredicate(): ConstraintPredicate | null {
    // NOT IN
    if (this.matchKeyword("not")) {
      if (
        !this.expect(
          "keyword",
          "in",
          "expected_token",
          "Expected IN after NOT"
        )
      ) {
        return null;
      }
      return this.parseInSet("not-in-set");
    }

    // IN
    if (this.matchKeyword("in")) {
      // Either ( set ) or a time region literal
      if (this.check("punctuation", "(")) {
        return this.parseInSet("in-set");
      }
      // Time-region containment
      const region = this.parseTimeRegionForContainment();
      if (!region) return null;
      const span = region.span;
      return { kind: "in-time-region", region, span };
    }

    // Comparison
    if (this.check("operator")) {
      const opTok = this.advance();
      if (!COMPARISON_OPS.has(opTok.text)) {
        this.errorAt(
          opTok.span,
          "unexpected_token",
          `Unsupported operator "${opTok.text}"`
        );
        return null;
      }
      const value = this.parseValue();
      if (!value) return null;
      return {
        kind: "comparison",
        operator: opTok.text as ComparisonOperator,
        value,
        span: spanFrom(opTok.span, value.span),
      };
    }

    this.errorHere(
      "expected_token",
      "Expected a comparison operator, IN, or NOT IN"
    );
    return null;
  }

  parseInSet(
    kind: "in-set" | "not-in-set"
  ): ConstraintPredicate | null {
    const open = this.expect(
      "punctuation",
      "(",
      "expected_token",
      "Expected '(' to start value list"
    );
    if (!open) return null;

    const values: ConstraintValue[] = [];
    if (!this.check("punctuation", ")")) {
      const first = this.parseValue();
      if (!first) return null;
      values.push(first);
      while (this.matchPunct(",")) {
        const next = this.parseValue();
        if (!next) return null;
        values.push(next);
      }
    }

    const close = this.expect(
      "punctuation",
      ")",
      "expected_token",
      "Expected ')' to close value list"
    );
    if (!close) return null;

    return {
      kind,
      values,
      span: spanFrom(open.span, close.span),
    };
  }

  // For `dim IN <region>` we accept calendar or range, but not until/
  // since/all-time — those don't read sensibly in this position.
  parseTimeRegionForContainment(): CalendarRegion | RangeRegion | null {
    const first = this.parseTimeLiteralOrYear();
    if (!first) return null;

    if (this.matchTimeKeyword("to")) {
      const second = this.parseTimeLiteralOrYear();
      if (!second) return null;
      return {
        kind: "range",
        start: first,
        end: second,
        span: spanFrom(first.span, second.span),
      };
    }
    return { kind: "calendar", literal: first, span: first.span };
  }

  parseValue(): ConstraintValue | null {
    const tok = this.peek();
    if (tok.kind === "string") {
      this.advance();
      // strip surrounding quotes
      const value = tok.text.slice(1, -1);
      return { kind: "string", value, text: tok.text, span: tok.span };
    }
    if (tok.kind === "number") {
      this.advance();
      return {
        kind: "number",
        value: parseFloat(tok.text),
        text: tok.text,
        span: tok.span,
      };
    }
    if (tok.kind === "time-literal") {
      this.advance();
      const lit = parseTimeLiteralText(tok.text, tok.span);
      if ("error" in lit) {
        this.errorAt(tok.span, "malformed_time_literal", lit.error);
        return null;
      }
      return { kind: "time-literal", literal: lit, span: tok.span };
    }
    this.errorAt(
      tok.span,
      "expected_token",
      `Expected a value (string, number, or time literal), got "${tok.text}"`
    );
    return null;
  }

  // ===== GROUP BY =====

  parseGroupByList(): GroupByClause[] {
    const items: GroupByClause[] = [];
    const first = this.parseGroupByItem();
    if (!first) return items;
    items.push(first);
    while (this.matchPunct(",")) {
      const next = this.parseGroupByItem();
      if (!next) break;
      items.push(next);
    }
    return items;
  }

  parseGroupByItem(): GroupByClause | null {
    // Bare grain — implicit primary time
    if (this.check("grain")) {
      const tok = this.advance();
      return {
        kind: "bare-grain",
        grain: tok.text.toLowerCase() as Grain,
        span: tok.span,
      };
    }

    const idTok = this.expect(
      "identifier",
      undefined,
      "expected_token",
      "Expected dimension name or grain in GROUP BY"
    );
    if (!idTok) return null;

    const dimension: Identifier = { name: idTok.text, span: idTok.span };

    // Optional :grain — explicit time dimension
    if (this.matchPunct(":")) {
      const grainTok = this.expect(
        "grain",
        undefined,
        "expected_token",
        "Expected a time grain (day, week, month, quarter, year) after ':'"
      );
      if (!grainTok) return null;
      return {
        kind: "time-dimension",
        dimension,
        grain: grainTok.text.toLowerCase() as Grain,
        span: spanFrom(idTok.span, grainTok.span),
      };
    }

    return { kind: "dimension", dimension, span: idTok.span };
  }

  // ===== ORDER BY =====

  parseOrderByList(): OrderByClause[] {
    const items: OrderByClause[] = [];
    const first = this.parseOrderByItem();
    if (!first) return items;
    items.push(first);
    while (this.matchPunct(",")) {
      const next = this.parseOrderByItem();
      if (!next) break;
      items.push(next);
    }
    return items;
  }

  parseOrderByItem(): OrderByClause | null {
    // Field can be identifier OR a bare grain (since GROUP BY allows
    // bare grain, the result column is named after the grain)
    let fieldTok: Token;
    if (this.check("identifier") || this.check("grain")) {
      fieldTok = this.advance();
    } else {
      this.errorHere(
        "expected_token",
        "Expected a field name in ORDER BY"
      );
      return null;
    }

    const field: Identifier = { name: fieldTok.text, span: fieldTok.span };

    let direction: OrderDirection = "asc";
    let endSpan = fieldTok.span;
    if (this.check("keyword", "asc")) {
      const t = this.advance();
      direction = "asc";
      endSpan = t.span;
    } else if (this.check("keyword", "desc")) {
      const t = this.advance();
      direction = "desc";
      endSpan = t.span;
    }

    return {
      field,
      direction,
      span: spanFrom(fieldTok.span, endSpan),
    };
  }

  // ===== LIMIT =====

  parseNumberLiteral(): NumberLiteral | null {
    const tok = this.peek();
    if (tok.kind !== "number") {
      this.errorAt(
        tok.span,
        "expected_token",
        `Expected a number, got "${tok.text}"`
      );
      return null;
    }
    this.advance();
    return {
      value: parseInt(tok.text, 10),
      text: tok.text,
      span: tok.span,
    };
  }
}

// Exported for use in validator (re-parsing time literal values, etc.)
export function parseTimeLiteralText(
  text: string,
  span: Span
): TimeLiteral | { error: string } {
  // year-Q-quarter
  let m = /^(\d{4})-[Qq](\d+)$/.exec(text);
  if (m) {
    return {
      unit: "quarter",
      year: parseInt(m[1], 10),
      quarter: parseInt(m[2], 10),
      text,
      span,
    };
  }
  // year-month-day
  m = /^(\d{4})-(\d+)-(\d+)$/.exec(text);
  if (m) {
    return {
      unit: "day",
      year: parseInt(m[1], 10),
      month: parseInt(m[2], 10),
      day: parseInt(m[3], 10),
      text,
      span,
    };
  }
  // year-month
  m = /^(\d{4})-(\d+)$/.exec(text);
  if (m) {
    return {
      unit: "month",
      year: parseInt(m[1], 10),
      month: parseInt(m[2], 10),
      text,
      span,
    };
  }
  return { error: `Cannot parse time literal "${text}"` };
}

// Used by validator. Acknowledges that `GRAIN_TEXTS` matters only as
// documentation; the tokenizer already classifies these as kind=grain.
export const RESERVED_GRAINS = GRAIN_TEXTS;
