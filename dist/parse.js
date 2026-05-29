// Parser: Token[] → { ast, errors }.
//
// Recursive descent. Errors are collected, not thrown — when a sub-parse
// fails irrecoverably it returns null and we sync to the next plausible
// clause boundary so we can keep going. The result always reflects what
// we managed to recognize plus the full list of problems we found.
//
// Spans on AST nodes always point back into the original source text via
// the spans of the tokens that were consumed to build them.
import { spanFrom } from "./source.js";
import { makeError } from "./errors.js";
export function parse(tokens) {
    const p = new Parser(tokens);
    const ast = p.parseStatement();
    return { ast, errors: p.errors };
}
const COMPARISON_OPS = new Set(["=", "!=", ">", "<", ">=", "<="]);
const GRAIN_TEXTS = new Set(["day", "week", "month", "quarter", "year"]);
class Parser {
    tokens;
    pos = 0;
    errors = [];
    constructor(tokens) {
        this.tokens = tokens;
    }
    // ===== Helpers =====
    peek(offset = 0) {
        const i = this.pos + offset;
        if (i >= this.tokens.length)
            return this.tokens[this.tokens.length - 1];
        return this.tokens[i];
    }
    advance() {
        const t = this.peek();
        if (t.kind !== "eof")
            this.pos++;
        return t;
    }
    isAtEnd() {
        return this.peek().kind === "eof";
    }
    // True if the current token matches kind (and optional case-insensitive
    // text); does NOT advance.
    check(kind, text) {
        const t = this.peek();
        if (t.kind !== kind)
            return false;
        if (text !== undefined && t.text.toLowerCase() !== text.toLowerCase())
            return false;
        return true;
    }
    // Advance if current token matches, else return null.
    match(kind, text) {
        if (!this.check(kind, text))
            return null;
        return this.advance();
    }
    matchKeyword(text) {
        return this.match("keyword", text);
    }
    matchTimeKeyword(text) {
        return this.match("time-keyword", text);
    }
    matchPunct(text) {
        return this.match("punctuation", text);
    }
    // Advance if current token matches, else emit error (and don't advance).
    expect(kind, text, code, message, help) {
        if (this.check(kind, text))
            return this.advance();
        this.errorHere(code, message, help);
        return null;
    }
    errorAt(span, code, message, help) {
        this.errors.push(makeError({ code, message, span, help }));
    }
    errorHere(code, message, help) {
        this.errorAt(this.peek().span, code, message, help);
    }
    // Skip tokens until we find one of the sync targets (or EOF). Used for
    // error recovery so a single failure doesn't cascade.
    syncTo(targets) {
        while (!this.isAtEnd()) {
            for (const t of targets) {
                if (this.check(t.kind, t.text))
                    return;
            }
            this.advance();
        }
    }
    // ===== Statement =====
    parseStatement() {
        if (this.check("keyword", "compute")) {
            return this.parseCompute();
        }
        if (this.check("keyword", "register")) {
            return this.parseRegister();
        }
        if (this.check("keyword", "check")) {
            return this.parseCheck();
        }
        if (this.check("keyword", "show")) {
            return this.parseShow();
        }
        if (this.check("keyword", "unregister")) {
            return this.parseUnregister();
        }
        if (this.isAtEnd()) {
            this.errorHere("unexpected_eof", "Empty input — expected a statement");
            return null;
        }
        const tok = this.peek();
        this.errorAt(tok.span, "unexpected_token", `Expected COMPUTE, REGISTER, CHECK, SHOW, or UNREGISTER, got "${tok.text}"`);
        return null;
    }
    // ===== COMPUTE =====
    parseCompute() {
        const computeTok = this.advance(); // COMPUTE
        const metrics = this.parseMetricList();
        if (metrics.length === 0)
            return null;
        if (!this.matchKeyword("over")) {
            this.errorHere("expected_token", "Expected OVER after metric list", "Every COMPUTE statement must have an OVER clause specifying the time region");
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
        if (!over)
            return null;
        let groupBy;
        if (this.matchKeyword("group")) {
            if (!this.expect("keyword", "by", "expected_token", "Expected BY after GROUP")) {
                return null;
            }
            groupBy = this.parseGroupByList();
        }
        let orderBy;
        if (this.matchKeyword("order")) {
            if (!this.expect("keyword", "by", "expected_token", "Expected BY after ORDER")) {
                return null;
            }
            orderBy = this.parseOrderByList();
        }
        let limit;
        if (this.matchKeyword("limit")) {
            limit = this.parseNumberLiteral() ?? undefined;
        }
        this.matchPunct(";"); // optional terminator
        if (!this.isAtEnd()) {
            const tok = this.peek();
            this.errorAt(tok.span, "unexpected_token", `Unexpected token "${tok.text}" after end of statement`);
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
    parseRegister() {
        const registerTok = this.advance(); // REGISTER
        // Entry kind — soft keyword. "region" and "boundary" are both
        // identifier-classified at tokenize time (so they can also serve as
        // dimension names) and dispatched here by text.
        const kindTok = this.peek();
        if (kindTok.kind === "identifier" && kindTok.text.toLowerCase() === "region") {
            this.advance();
            return this.parseRegisterRegionTail(registerTok);
        }
        if (kindTok.kind === "identifier" && kindTok.text.toLowerCase() === "boundary") {
            this.advance();
            return this.parseRegisterBoundaryTail(registerTok);
        }
        this.errorAt(kindTok.span, "expected_token", 'Expected entry kind "region" or "boundary" after REGISTER', "REGISTER takes an entry kind followed by the entry name");
        return null;
    }
    parseRegisterRegionTail(registerTok) {
        const nameTok = this.expect("identifier", undefined, "expected_token", "Expected an entry name (identifier) after REGISTER region");
        if (!nameTok)
            return null;
        const name = { name: nameTok.text, span: nameTok.span };
        // At least one IMPACTING clause is required.
        if (!this.check("keyword", "impacting")) {
            this.errorHere("expected_token", "Expected IMPACTING after entry name", "REGISTER must include at least one IMPACTING clause");
            return null;
        }
        const impactClauses = [];
        while (this.check("keyword", "impacting")) {
            const clause = this.parseImpactClause();
            if (!clause)
                return null;
            impactClauses.push(clause);
        }
        if (!this.expect("keyword", "with", "expected_token", "Expected WITH after IMPACTING clauses", "REGISTER requires a WITH <description> clause")) {
            return null;
        }
        const description = this.parseStringLiteral();
        if (!description)
            return null;
        this.matchPunct(";"); // optional terminator
        if (!this.isAtEnd()) {
            const tok = this.peek();
            this.errorAt(tok.span, "unexpected_token", `Unexpected token "${tok.text}" after end of statement`);
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
    parseRegisterBoundaryTail(registerTok) {
        const nameTok = this.expect("identifier", undefined, "expected_token", "Expected an entry name (identifier) after REGISTER boundary");
        if (!nameTok)
            return null;
        const name = { name: nameTok.text, span: nameTok.span };
        // AT <time-literal> — the cut date. Validator enforces day-form.
        if (!this.expect("keyword", "at", "expected_token", "Expected AT after boundary name", "REGISTER boundary takes an AT <date> clause naming the cut")) {
            return null;
        }
        const at = this.parseTimeLiteralOrYear();
        if (!at)
            return null;
        // Optional AND <constraint>... — categorical scoping for the cut.
        const constraints = [];
        while (this.matchKeyword("and")) {
            const c = this.parseConstraint();
            if (!c)
                return null;
            constraints.push(c);
        }
        // IMPACTING <metric>[, <metric>...] — single set of metrics share AT.
        if (!this.expect("keyword", "impacting", "expected_token", "Expected IMPACTING after AT clause", "REGISTER boundary requires an IMPACTING <metric>[, <metric>...] clause")) {
            return null;
        }
        const metrics = this.parseMetricList();
        if (metrics.length === 0) {
            this.errorHere("expected_token", "Expected at least one metric after IMPACTING");
            return null;
        }
        // BEFORE "<label>" "<description>" — mandatory regime description.
        const before = this.parseRegimeClause("before");
        if (!before)
            return null;
        // AFTER "<label>" "<description>" — mandatory regime description.
        const after = this.parseRegimeClause("after");
        if (!after)
            return null;
        // Optional WITH "<change>" — overrides the runtime-composed change
        // sentence in straddling/spanning footers.
        let changeDescription;
        if (this.matchKeyword("with")) {
            const desc = this.parseStringLiteral();
            if (!desc)
                return null;
            changeDescription = desc;
        }
        this.matchPunct(";"); // optional terminator
        if (!this.isAtEnd()) {
            const tok = this.peek();
            this.errorAt(tok.span, "unexpected_token", `Unexpected token "${tok.text}" after end of statement`);
        }
        const lastTok = this.tokens[Math.max(0, this.pos - 1)];
        return {
            kind: "register",
            entryKind: "boundary",
            name,
            at,
            constraints,
            metrics,
            before,
            after,
            changeDescription,
            span: spanFrom(registerTok.span, lastTok.span ?? registerTok.span),
        };
    }
    // Parse `<keyword> "<label>" "<description>"`. `keyword` is "before"
    // or "after"; both clauses are mandatory on REGISTER boundary in v0.3.0.
    parseRegimeClause(keyword) {
        const kwTok = this.expect("keyword", keyword, "expected_token", `Expected ${keyword.toUpperCase()} clause`, `REGISTER boundary requires both BEFORE and AFTER clauses, each followed by a short label and a description string.`);
        if (!kwTok)
            return null;
        const label = this.parseStringLiteral();
        if (!label)
            return null;
        const description = this.parseStringLiteral();
        if (!description) {
            // parseStringLiteral has already emitted an error; add a hint so
            // it's clear two strings are expected.
            this.errorAt(label.span, "expected_token", `${keyword.toUpperCase()} expects a short label string followed by a longer description string`);
            return null;
        }
        return {
            label,
            description,
            span: spanFrom(kwTok.span, description.span),
        };
    }
    parseImpactClause() {
        const impactingTok = this.advance(); // IMPACTING
        const metrics = this.parseMetricList();
        if (metrics.length === 0) {
            this.errorAt(impactingTok.span, "expected_token", "Expected at least one metric after IMPACTING");
            return null;
        }
        if (!this.matchKeyword("over")) {
            this.errorHere("expected_token", "Expected OVER after metric list in IMPACTING clause");
            return null;
        }
        const over = this.parseOverClause();
        if (!over)
            return null;
        return {
            metrics,
            over,
            span: spanFrom(impactingTok.span, over.span),
        };
    }
    parseStringLiteral() {
        const tok = this.peek();
        if (tok.kind !== "string") {
            this.errorAt(tok.span, "expected_token", `Expected a string literal, got "${tok.text}"`);
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
    parseCheck() {
        const checkTok = this.advance(); // CHECK
        const metrics = this.parseMetricList();
        if (metrics.length === 0)
            return null;
        if (!this.matchKeyword("over")) {
            this.errorHere("expected_token", "Expected OVER after metric list", "CHECK requires an OVER clause — use 'OVER all time' for the unbounded case");
            return null;
        }
        const over = this.parseOverClause();
        if (!over)
            return null;
        this.matchPunct(";");
        if (!this.isAtEnd()) {
            const tok = this.peek();
            this.errorAt(tok.span, "unexpected_token", `Unexpected token "${tok.text}" after end of statement`);
        }
        const lastTok = this.tokens[Math.max(0, this.pos - 1)];
        return {
            kind: "check",
            metrics,
            over,
            span: spanFrom(checkTok.span, lastTok.span ?? checkTok.span),
        };
    }
    // ===== SHOW =====
    parseShow() {
        const showTok = this.advance(); // SHOW
        // Subject is a soft keyword (identifier-classified at tokenize
        // time) dispatched here by text — same pattern as REGISTER's
        // region / boundary subjects.
        const subjectTok = this.peek();
        if (subjectTok.kind !== "identifier") {
            this.errorAt(subjectTok.span, "expected_token", `Expected subject after SHOW (lexicon or schema), got "${subjectTok.text}"`, "SHOW LEXICON [<name>] or SHOW SCHEMA");
            return null;
        }
        const subjectText = subjectTok.text.toLowerCase();
        if (subjectText !== "lexicon" && subjectText !== "schema") {
            this.errorAt(subjectTok.span, "expected_token", `Unknown SHOW subject "${subjectTok.text}"`, "Valid subjects: lexicon, schema");
            return null;
        }
        this.advance(); // subject
        let filters;
        if (subjectText === "lexicon" && this.check("identifier")) {
            // SHOW LEXICON <name>[, <name>...] — one or more entry names.
            filters = [];
            const firstTok = this.advance();
            filters.push({ name: firstTok.text, span: firstTok.span });
            while (this.matchPunct(",")) {
                if (!this.check("identifier")) {
                    const tok = this.peek();
                    this.errorAt(tok.span, "expected_token", `Expected lexicon entry name after "," in SHOW LEXICON list, got "${tok.text}"`, "SHOW LEXICON <name>[, <name>...]");
                    break;
                }
                const nameTok = this.advance();
                filters.push({ name: nameTok.text, span: nameTok.span });
            }
        }
        this.matchPunct(";"); // optional terminator
        if (!this.isAtEnd()) {
            const tok = this.peek();
            this.errorAt(tok.span, "unexpected_token", `Unexpected token "${tok.text}" after end of statement`);
        }
        const lastTok = this.tokens[Math.max(0, this.pos - 1)];
        return {
            kind: "show",
            subject: subjectText,
            filters,
            span: spanFrom(showTok.span, lastTok.span ?? showTok.span),
        };
    }
    // ===== UNREGISTER =====
    parseUnregister() {
        const unregTok = this.advance(); // UNREGISTER
        const nameTok = this.expect("identifier", undefined, "expected_token", "Expected an entry name after UNREGISTER", "UNREGISTER <name> drops the lexicon entry by that name.");
        if (!nameTok)
            return null;
        const name = { name: nameTok.text, span: nameTok.span };
        this.matchPunct(";"); // optional terminator
        if (!this.isAtEnd()) {
            const tok = this.peek();
            this.errorAt(tok.span, "unexpected_token", `Unexpected token "${tok.text}" after end of statement`);
        }
        const lastTok = this.tokens[Math.max(0, this.pos - 1)];
        return {
            kind: "unregister",
            name,
            span: spanFrom(unregTok.span, lastTok.span ?? unregTok.span),
        };
    }
    // ===== Metric list =====
    parseMetricList() {
        const metrics = [];
        const first = this.expect("identifier", undefined, "expected_token", "Expected metric name after COMPUTE");
        if (!first)
            return metrics;
        metrics.push({ name: first.text, span: first.span });
        while (this.matchPunct(",")) {
            const next = this.expect("identifier", undefined, "expected_token", "Expected metric name after ','");
            if (!next)
                break;
            metrics.push({ name: next.text, span: next.span });
        }
        return metrics;
    }
    // ===== OVER clause =====
    parseOverClause() {
        const start = this.peek().span;
        const primaryTime = this.parseTimeRegion();
        if (!primaryTime)
            return null;
        const constraints = [];
        while (this.matchKeyword("and")) {
            const c = this.parseConstraint();
            if (c)
                constraints.push(c);
            else
                break;
        }
        const end = this.tokens[Math.max(0, this.pos - 1)].span;
        return {
            primaryTime,
            constraints,
            span: spanFrom(start, end),
        };
    }
    // ===== Time region =====
    parseTimeRegion() {
        // all time
        if (this.check("time-keyword", "all")) {
            const allTok = this.advance();
            if (!this.matchTimeKeyword("time")) {
                this.errorHere("expected_token", 'Expected "time" after "all"', 'The unbounded time region is written "all time"');
                return null;
            }
            const lastTok = this.tokens[this.pos - 1];
            const region = {
                kind: "all-time",
                span: spanFrom(allTok.span, lastTok.span),
            };
            return region;
        }
        // until <bound>
        if (this.check("time-keyword", "until")) {
            const untilTok = this.advance();
            const bound = this.parseTimeLiteralOrYear();
            if (!bound)
                return null;
            const region = {
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
            if (!bound)
                return null;
            const region = {
                kind: "since",
                bound,
                span: spanFrom(sinceTok.span, bound.span),
            };
            return region;
        }
        // calendar literal or range
        if (this.check("time-literal") || this.check("number")) {
            const first = this.parseTimeLiteralOrYear();
            if (!first)
                return null;
            // range: <first> to <second>
            if (this.matchTimeKeyword("to")) {
                const second = this.parseTimeLiteralOrYear();
                if (!second)
                    return null;
                const region = {
                    kind: "range",
                    start: first,
                    end: second,
                    span: spanFrom(first.span, second.span),
                };
                return region;
            }
            // single calendar region
            const region = {
                kind: "calendar",
                literal: first,
                span: first.span,
            };
            return region;
        }
        this.errorHere("expected_token", "Expected a time region", 'Use a calendar literal (e.g. 2026, 2026-Q1, 2026-02), a range (X to Y), "until X", "since X", or "all time"');
        return null;
    }
    // ===== Time literals =====
    // Parse a single calendar reference: either a 4-digit number (year
    // shorthand) or an explicit time-literal token.
    parseTimeLiteralOrYear() {
        const tok = this.peek();
        if (tok.kind === "number") {
            this.advance();
            if (!/^\d{4}$/.test(tok.text)) {
                this.errorAt(tok.span, "malformed_time_literal", `Expected a 4-digit year, got "${tok.text}"`);
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
        this.errorAt(tok.span, "expected_token", `Expected a time literal, got "${tok.text}"`);
        return null;
    }
    // ===== Constraints =====
    parseConstraint() {
        const dimTok = this.expect("identifier", undefined, "expected_token", "Expected dimension name");
        if (!dimTok)
            return null;
        const dimension = { name: dimTok.text, span: dimTok.span };
        const predicate = this.parseConstraintPredicate();
        if (!predicate)
            return null;
        return {
            dimension,
            predicate,
            span: spanFrom(dimension.span, predicate.span),
        };
    }
    parseConstraintPredicate() {
        // NOT IN
        if (this.matchKeyword("not")) {
            if (!this.expect("keyword", "in", "expected_token", "Expected IN after NOT")) {
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
            if (!region)
                return null;
            const span = region.span;
            return { kind: "in-time-region", region, span };
        }
        // Comparison
        if (this.check("operator")) {
            const opTok = this.advance();
            if (!COMPARISON_OPS.has(opTok.text)) {
                this.errorAt(opTok.span, "unexpected_token", `Unsupported operator "${opTok.text}"`);
                return null;
            }
            const value = this.parseValue();
            if (!value)
                return null;
            return {
                kind: "comparison",
                operator: opTok.text,
                value,
                span: spanFrom(opTok.span, value.span),
            };
        }
        this.errorHere("expected_token", "Expected a comparison operator, IN, or NOT IN");
        return null;
    }
    parseInSet(kind) {
        const open = this.expect("punctuation", "(", "expected_token", "Expected '(' to start value list");
        if (!open)
            return null;
        const values = [];
        if (!this.check("punctuation", ")")) {
            const first = this.parseValue();
            if (!first)
                return null;
            values.push(first);
            while (this.matchPunct(",")) {
                const next = this.parseValue();
                if (!next)
                    return null;
                values.push(next);
            }
        }
        const close = this.expect("punctuation", ")", "expected_token", "Expected ')' to close value list");
        if (!close)
            return null;
        return {
            kind,
            values,
            span: spanFrom(open.span, close.span),
        };
    }
    // For `dim IN <region>` we accept calendar or range, but not until/
    // since/all-time — those don't read sensibly in this position.
    parseTimeRegionForContainment() {
        const first = this.parseTimeLiteralOrYear();
        if (!first)
            return null;
        if (this.matchTimeKeyword("to")) {
            const second = this.parseTimeLiteralOrYear();
            if (!second)
                return null;
            return {
                kind: "range",
                start: first,
                end: second,
                span: spanFrom(first.span, second.span),
            };
        }
        return { kind: "calendar", literal: first, span: first.span };
    }
    parseValue() {
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
        this.errorAt(tok.span, "expected_token", `Expected a value (string, number, or time literal), got "${tok.text}"`);
        return null;
    }
    // ===== GROUP BY =====
    parseGroupByList() {
        const items = [];
        const first = this.parseGroupByItem();
        if (!first)
            return items;
        items.push(first);
        while (this.matchPunct(",")) {
            const next = this.parseGroupByItem();
            if (!next)
                break;
            items.push(next);
        }
        return items;
    }
    parseGroupByItem() {
        // Bare grain — implicit primary time
        if (this.check("grain")) {
            const tok = this.advance();
            return {
                kind: "bare-grain",
                grain: tok.text.toLowerCase(),
                span: tok.span,
            };
        }
        const idTok = this.expect("identifier", undefined, "expected_token", "Expected dimension name or grain in GROUP BY");
        if (!idTok)
            return null;
        const dimension = { name: idTok.text, span: idTok.span };
        // Optional :grain — explicit time dimension
        if (this.matchPunct(":")) {
            const grainTok = this.expect("grain", undefined, "expected_token", "Expected a time grain (day, week, month, quarter, year) after ':'");
            if (!grainTok)
                return null;
            return {
                kind: "time-dimension",
                dimension,
                grain: grainTok.text.toLowerCase(),
                span: spanFrom(idTok.span, grainTok.span),
            };
        }
        return { kind: "dimension", dimension, span: idTok.span };
    }
    // ===== ORDER BY =====
    parseOrderByList() {
        const items = [];
        const first = this.parseOrderByItem();
        if (!first)
            return items;
        items.push(first);
        while (this.matchPunct(",")) {
            const next = this.parseOrderByItem();
            if (!next)
                break;
            items.push(next);
        }
        return items;
    }
    parseOrderByItem() {
        // Field can be identifier OR a bare grain (since GROUP BY allows
        // bare grain, the result column is named after the grain)
        let fieldTok;
        if (this.check("identifier") || this.check("grain")) {
            fieldTok = this.advance();
        }
        else {
            this.errorHere("expected_token", "Expected a field name in ORDER BY");
            return null;
        }
        const field = { name: fieldTok.text, span: fieldTok.span };
        let direction = "asc";
        let endSpan = fieldTok.span;
        if (this.check("keyword", "asc")) {
            const t = this.advance();
            direction = "asc";
            endSpan = t.span;
        }
        else if (this.check("keyword", "desc")) {
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
    parseNumberLiteral() {
        const tok = this.peek();
        if (tok.kind !== "number") {
            this.errorAt(tok.span, "expected_token", `Expected a number, got "${tok.text}"`);
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
export function parseTimeLiteralText(text, span) {
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
