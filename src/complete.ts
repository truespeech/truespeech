// Tab-style autocomplete analyzer.
//
// Given (source, position), return the set of valid next tokens at
// the cursor. Used by editor surfaces (the sandbox notebook today)
// to drive a Tab keypress UX.
//
// The analyzer is a small predictive state machine that mirrors the
// parser's structure: it walks the tokens up to the cursor, tracks
// what clause we're inside, and reports what the parser would
// expect next. Materializes concrete candidates by querying the
// semantic layer (for metric / dimension names) and the lexicon
// (for entry names).
//
// Scope limits:
//   - Treats the partial token at the cursor as the prefix to
//     filter against; consumes only tokens fully before the cursor.
//   - Ignores tokens after the cursor.
//   - Returns no candidates inside a string literal (Tab is a
//     pass-through there).

import type {
  SemanticLayerAdapter,
  LexiconAdapter,
  Completion,
  CompletionResult,
} from "./adapters.js";
import { tokenize } from "./tokenize.js";
import type { Token } from "./tokens.js";

// Set of expectations the analyzer produces. Each `true` flag
// contributes to the candidate list when materialized. Plain
// keywords go in `keywords` literally.
interface Expectation {
  keywords?: string[];
  softKeywords?: string[];
  metric?: boolean;
  dimension?: boolean;
  // When dimensions are expected and a specific metric has been
  // picked, filter to that metric's dataset.
  dimensionMetric?: string;
  grain?: boolean;
  operator?: boolean;
  value?: boolean; // string / number / time literal
  timeLiteral?: boolean;
  stringLiteral?: boolean;
  numberLiteral?: boolean;
  identifier?: boolean;
  lexiconEntry?: boolean;
}

export interface CompleteOpts {
  semanticLayer: SemanticLayerAdapter;
  lexicon?: LexiconAdapter;
  // When provided, time-literal completion positions emit concrete
  // year / quarter / month candidates for each listed year, instead
  // of the generic hint placeholder. Days are intentionally omitted.
  timeLiteralYears?: number[];
}

export async function complete(
  source: string,
  position: number,
  opts: CompleteOpts
): Promise<CompletionResult> {
  const safePos = Math.max(0, Math.min(position, source.length));
  const prefixSlice = findPrefix(source, safePos);

  // If the cursor sits inside a string literal, there is nothing to
  // complete — Tab is a passthrough at the consumer.
  if (insideStringLiteral(source, safePos)) {
    return {
      prefix: prefixSlice.text,
      start: prefixSlice.start,
      end: safePos,
      candidates: [],
    };
  }

  // Tokenize the whole source, then keep only the tokens that end
  // at-or-before the start of the partial-token region. Those are
  // the tokens "fully consumed" before the cursor; the partial
  // (if any) is what the user is currently typing.
  const allTokens = tokenize(source);
  const consumed = allTokens.filter(
    (t) => t.kind !== "eof" && t.span.end <= prefixSlice.start
  );

  const expectation = analyze(consumed);
  const candidates = await materialize(expectation, opts);
  const filtered = filterByPrefix(candidates, prefixSlice.text);

  return {
    prefix: prefixSlice.text,
    start: prefixSlice.start,
    end: safePos,
    candidates: filtered,
  };
}

// ===== Prefix detection =====

interface PrefixSlice {
  text: string;
  start: number;
}

// Walk backwards from the cursor to find the start of the current
// word. A "word" is any run of identifier-continuation characters
// (letters, digits, _) plus the time-literal continuation chars
// (digit / Q-marker / hyphen following a digit).
function findPrefix(source: string, pos: number): PrefixSlice {
  let i = pos;
  while (i > 0 && isWordChar(source[i - 1])) i--;
  // Don't extend the prefix into a leading non-word character — if
  // the cursor is at the start of a token boundary (after whitespace
  // or punctuation), the prefix is empty.
  if (i === pos) {
    return { text: "", start: pos };
  }
  return { text: source.slice(i, pos), start: i };
}

function isWordChar(ch: string): boolean {
  return (
    (ch >= "A" && ch <= "Z") ||
    (ch >= "a" && ch <= "z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch === "-" // for time literals
  );
}

// Detect whether the cursor sits inside an unclosed string literal.
// Cheap heuristic: count unescaped quote characters before the
// cursor — if either single- or double-quote count is odd, we're
// inside a string of that quote kind.
function insideStringLiteral(source: string, pos: number): boolean {
  let single = 0;
  let double = 0;
  for (let i = 0; i < pos; i++) {
    const ch = source[i];
    if (ch === "'") single++;
    else if (ch === '"') double++;
  }
  return single % 2 === 1 || double % 2 === 1;
}

// ===== Grammar walk =====
//
// Walk tokens left-to-right, threading a tiny "what's next?" model.
// Returns the expectation at the END of the consumed-token stream.
// The grammar surface is small enough (5 statement kinds, a handful
// of clauses each) to enumerate by hand.

function analyze(tokens: Token[]): Expectation {
  if (tokens.length === 0) {
    return {
      keywords: ["COMPUTE", "REGISTER", "CHECK", "SHOW", "UNREGISTER"],
    };
  }

  const head = tokens[0];
  const headText = head.text.toLowerCase();

  if (headText === "compute") return analyzeCompute(tokens);
  if (headText === "register") return analyzeRegister(tokens);
  if (headText === "check") return analyzeCheck(tokens);
  if (headText === "show") return analyzeShow(tokens);
  if (headText === "unregister") return analyzeUnregister(tokens);

  // Source doesn't start with a known statement; suggest the
  // statement-starting keywords anyway as a recovery surface.
  return {
    keywords: ["COMPUTE", "REGISTER", "CHECK", "SHOW", "UNREGISTER"],
  };
}

// ----- COMPUTE -----

function analyzeCompute(tokens: Token[]): Expectation {
  // tokens[0] = COMPUTE
  if (tokens.length === 1) return { metric: true };

  // Track the metric the user has named so dimension completion can
  // filter by its dataset.
  const metric = tokens[1].kind === "identifier" ? tokens[1].text : undefined;

  if (tokens.length === 2) return { keywords: ["OVER"] };

  // tokens[2] should be OVER
  // Walk the OVER clause: time region + optional AND constraints +
  // optional GROUP BY / ORDER BY / LIMIT.
  return analyzeQueryTail(tokens, 3, metric);
}

// Shared tail for COMPUTE / CHECK / IMPACTING — handles everything
// after the OVER keyword: time region, AND constraints, and
// (COMPUTE-only) GROUP BY / ORDER BY / LIMIT.
function analyzeQueryTail(
  tokens: Token[],
  startIdx: number,
  metric: string | undefined,
  options: { allowGroupingClauses?: boolean } = { allowGroupingClauses: true }
): Expectation {
  let i = startIdx;

  // Time region — first token must initiate one.
  if (i >= tokens.length) {
    return {
      keywords: ["UNTIL", "SINCE", "ALL"],
      timeLiteral: true,
    };
  }

  // Skip past the time region. The shapes:
  //   <year-or-time-literal>
  //   <X> to <Y>
  //   UNTIL <X>
  //   SINCE <X>
  //   ALL TIME
  const afterTime = skipTimeRegion(tokens, i);
  if (afterTime === null) {
    // The time-region tokens are incomplete — figure out where we got
    // stuck and report the right expectation.
    return diagnoseTimeRegionGap(tokens, startIdx);
  }
  i = afterTime;
  if (i >= tokens.length) {
    return tailAfterTimeRegion(metric, options);
  }

  // AND <constraint>... loop
  while (i < tokens.length && tokenIsKeyword(tokens[i], "and")) {
    i++;
    const next = skipConstraint(tokens, i, metric);
    if (next === null) return diagnoseConstraintGap(tokens, i, metric);
    i = next;
  }

  if (i >= tokens.length) {
    return tailAfterTimeRegion(metric, options);
  }

  if (!options.allowGroupingClauses) {
    // CHECK / IMPACTING don't take GROUP/ORDER/LIMIT.
    return { keywords: ["AND"] };
  }

  // GROUP BY / ORDER BY / LIMIT — each is a self-contained clause.
  if (tokenIsKeyword(tokens[i], "group")) {
    i++;
    if (i >= tokens.length) return { keywords: ["BY"] };
    if (!tokenIsKeyword(tokens[i], "by")) return { keywords: ["BY"] };
    i++;
    return analyzeGroupBy(tokens, i, metric);
  }
  if (tokenIsKeyword(tokens[i], "order")) {
    i++;
    if (i >= tokens.length) return { keywords: ["BY"] };
    if (!tokenIsKeyword(tokens[i], "by")) return { keywords: ["BY"] };
    i++;
    return analyzeOrderBy(tokens, i);
  }
  if (tokenIsKeyword(tokens[i], "limit")) {
    i++;
    return { numberLiteral: true };
  }

  return tailAfterTimeRegion(metric, options);
}

function tailAfterTimeRegion(
  metric: string | undefined,
  options: { allowGroupingClauses?: boolean }
): Expectation {
  void metric;
  if (options.allowGroupingClauses) {
    return { keywords: ["AND", "GROUP", "ORDER", "LIMIT"] };
  }
  return { keywords: ["AND"] };
}

function analyzeGroupBy(
  tokens: Token[],
  startIdx: number,
  metric: string | undefined
): Expectation {
  let i = startIdx;
  if (i >= tokens.length) {
    return { grain: true, dimension: true, dimensionMetric: metric };
  }
  // Walk one group-by item.
  // bare-grain: a single grain token
  // dimension: an identifier, optionally followed by :grain
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.kind === "grain") {
      i++;
    } else if (tok.kind === "identifier") {
      i++;
      // Optional `:grain`
      if (i < tokens.length && tokens[i].kind === "punctuation" && tokens[i].text === ":") {
        i++;
        if (i >= tokens.length) return { grain: true };
        if (tokens[i].kind === "grain") {
          i++;
        }
      }
    } else {
      break;
    }
    // After an item, expect `,` for more or move to next clause.
    if (i >= tokens.length) {
      return { keywords: ["ORDER", "LIMIT"] };
    }
    if (tokens[i].kind === "punctuation" && tokens[i].text === ",") {
      i++;
      if (i >= tokens.length) {
        return { grain: true, dimension: true, dimensionMetric: metric };
      }
      continue;
    }
    if (tokenIsKeyword(tokens[i], "order")) {
      i++;
      if (i >= tokens.length) return { keywords: ["BY"] };
      if (!tokenIsKeyword(tokens[i], "by")) return { keywords: ["BY"] };
      i++;
      return analyzeOrderBy(tokens, i);
    }
    if (tokenIsKeyword(tokens[i], "limit")) {
      return { numberLiteral: true };
    }
    break;
  }
  return { keywords: ["ORDER", "LIMIT"] };
}

function analyzeOrderBy(tokens: Token[], startIdx: number): Expectation {
  let i = startIdx;
  if (i >= tokens.length) return { identifier: true, grain: true };
  while (i < tokens.length) {
    if (tokens[i].kind !== "identifier" && tokens[i].kind !== "grain") break;
    i++;
    if (i >= tokens.length) return { keywords: ["ASC", "DESC", "LIMIT"] };
    if (tokenIsKeyword(tokens[i], "asc") || tokenIsKeyword(tokens[i], "desc")) {
      i++;
    }
    if (i >= tokens.length) return { keywords: ["LIMIT"] };
    if (tokens[i].kind === "punctuation" && tokens[i].text === ",") {
      i++;
      if (i >= tokens.length) return { identifier: true, grain: true };
      continue;
    }
    if (tokenIsKeyword(tokens[i], "limit")) {
      i++;
      return { numberLiteral: true };
    }
    break;
  }
  return { keywords: ["LIMIT"] };
}

// ----- REGISTER -----

function analyzeRegister(tokens: Token[]): Expectation {
  if (tokens.length === 1) {
    return { softKeywords: ["region", "boundary"] };
  }
  const subjectTok = tokens[1];
  if (subjectTok.kind !== "identifier") {
    return { softKeywords: ["region", "boundary"] };
  }
  const subject = subjectTok.text.toLowerCase();
  if (subject === "region") return analyzeRegisterRegion(tokens);
  if (subject === "boundary") return analyzeRegisterBoundary(tokens);
  return { softKeywords: ["region", "boundary"] };
}

function analyzeRegisterRegion(tokens: Token[]): Expectation {
  // tokens[0]=REGISTER, [1]=region
  if (tokens.length === 2) return { identifier: true };
  // [2] = name
  if (tokens.length === 3) return { keywords: ["IMPACTING"] };
  // Walk IMPACTING clauses then WITH.
  let i = 3;
  while (i < tokens.length && tokenIsKeyword(tokens[i], "impacting")) {
    i++;
    const metricListStart = i;
    // Metric list
    while (i < tokens.length) {
      if (tokens[i].kind !== "identifier") break;
      i++;
      if (i >= tokens.length) return { keywords: ["OVER"] };
      if (tokens[i].kind === "punctuation" && tokens[i].text === ",") {
        i++;
        if (i >= tokens.length) return { metric: true };
        continue;
      }
      break;
    }
    if (i === metricListStart) return { metric: true };
    if (i >= tokens.length) return { keywords: ["OVER"] };
    if (!tokenIsKeyword(tokens[i], "over")) return { keywords: ["OVER"] };
    i++;
    // Query tail without grouping clauses
    const tail = analyzeQueryTail(tokens, i, undefined, { allowGroupingClauses: false });
    // If we still have more tokens to consume past the OVER, advance.
    const advanced = skipOverClause(tokens, i);
    if (advanced === null) return tail;
    i = advanced;
    if (i >= tokens.length) return { keywords: ["IMPACTING", "WITH"] };
  }
  if (tokenIsKeyword(tokens[i], "with")) {
    i++;
    return { stringLiteral: true };
  }
  return { keywords: ["IMPACTING", "WITH"] };
}

function analyzeRegisterBoundary(tokens: Token[]): Expectation {
  // tokens[0]=REGISTER, [1]=boundary
  if (tokens.length === 2) return { identifier: true };
  // [2] = name
  if (tokens.length === 3) return { keywords: ["AT"] };
  if (!tokenIsKeyword(tokens[3], "at")) return { keywords: ["AT"] };
  // [3] = AT
  if (tokens.length === 4) return { timeLiteral: true };
  // [4] = time literal — skip
  let i = 5;
  // Optional AND constraints
  while (i < tokens.length && tokenIsKeyword(tokens[i], "and")) {
    i++;
    const next = skipConstraint(tokens, i, undefined);
    if (next === null) return diagnoseConstraintGap(tokens, i, undefined);
    i = next;
  }
  if (i >= tokens.length) return { keywords: ["AND", "IMPACTING"] };
  if (!tokenIsKeyword(tokens[i], "impacting")) {
    return { keywords: ["AND", "IMPACTING"] };
  }
  i++;
  const boundaryMetricListStart = i;
  // Metric list
  while (i < tokens.length) {
    if (tokens[i].kind !== "identifier") break;
    i++;
    if (i >= tokens.length) return { keywords: ["BEFORE"] };
    if (tokens[i].kind === "punctuation" && tokens[i].text === ",") {
      i++;
      if (i >= tokens.length) return { metric: true };
      continue;
    }
    break;
  }
  if (i === boundaryMetricListStart) return { metric: true };
  if (i >= tokens.length) return { keywords: ["BEFORE"] };
  if (!tokenIsKeyword(tokens[i], "before")) return { keywords: ["BEFORE"] };
  i++;
  // BEFORE expects two string literals (label + description)
  if (i >= tokens.length) return { stringLiteral: true };
  if (tokens[i].kind !== "string") return { stringLiteral: true };
  i++;
  if (i >= tokens.length) return { stringLiteral: true };
  if (tokens[i].kind !== "string") return { stringLiteral: true };
  i++;
  // Then AFTER
  if (i >= tokens.length) return { keywords: ["AFTER"] };
  if (!tokenIsKeyword(tokens[i], "after")) return { keywords: ["AFTER"] };
  i++;
  if (i >= tokens.length) return { stringLiteral: true };
  if (tokens[i].kind !== "string") return { stringLiteral: true };
  i++;
  if (i >= tokens.length) return { stringLiteral: true };
  if (tokens[i].kind !== "string") return { stringLiteral: true };
  i++;
  // Then optional WITH or done.
  if (i >= tokens.length) return { keywords: ["WITH"] };
  if (tokenIsKeyword(tokens[i], "with")) {
    i++;
    return { stringLiteral: true };
  }
  return {};
}

// ----- CHECK -----

function analyzeCheck(tokens: Token[]): Expectation {
  if (tokens.length === 1) return { metric: true };
  let i = 1;
  // Metric list
  while (i < tokens.length) {
    if (tokens[i].kind !== "identifier") break;
    i++;
    if (i >= tokens.length) return { keywords: ["OVER"] };
    if (tokens[i].kind === "punctuation" && tokens[i].text === ",") {
      i++;
      if (i >= tokens.length) return { metric: true };
      continue;
    }
    break;
  }
  if (i >= tokens.length) return { keywords: ["OVER"] };
  if (!tokenIsKeyword(tokens[i], "over")) return { keywords: ["OVER"] };
  i++;
  return analyzeQueryTail(tokens, i, undefined, { allowGroupingClauses: false });
}

// ----- SHOW -----

function analyzeShow(tokens: Token[]): Expectation {
  if (tokens.length === 1) return { softKeywords: ["lexicon", "schema"] };
  const subjectTok = tokens[1];
  if (subjectTok.kind !== "identifier") {
    return { softKeywords: ["lexicon", "schema"] };
  }
  const subject = subjectTok.text.toLowerCase();
  if (subject === "lexicon") {
    // Optional name filter
    if (tokens.length === 2) return { lexiconEntry: true };
  }
  return {};
}

// ----- UNREGISTER -----

function analyzeUnregister(tokens: Token[]): Expectation {
  if (tokens.length === 1) return { lexiconEntry: true };
  return {};
}

// ===== Skipping helpers =====
//
// These advance through grammar sub-shapes that the analyzer doesn't
// need fine-grained completion for — they're just "consume these
// tokens, return the new index." Return null if the shape is
// incomplete (so the caller can switch to diagnosis mode).

function skipTimeRegion(tokens: Token[], startIdx: number): number | null {
  let i = startIdx;
  if (i >= tokens.length) return null;
  const tok = tokens[i];
  // `all time`
  if (tokenIsTimeKeyword(tok, "all")) {
    i++;
    if (i >= tokens.length) return null;
    if (!tokenIsTimeKeyword(tokens[i], "time")) return null;
    return i + 1;
  }
  if (tokenIsTimeKeyword(tok, "until") || tokenIsTimeKeyword(tok, "since")) {
    i++;
    if (i >= tokens.length) return null;
    if (!isTimeBound(tokens[i])) return null;
    return i + 1;
  }
  if (!isTimeBound(tok)) return null;
  i++;
  // Optional `to <bound>`
  if (i < tokens.length && tokenIsTimeKeyword(tokens[i], "to")) {
    i++;
    if (i >= tokens.length) return null;
    if (!isTimeBound(tokens[i])) return null;
    i++;
  }
  return i;
}

function diagnoseTimeRegionGap(tokens: Token[], startIdx: number): Expectation {
  // We bailed somewhere inside a time-region shape. Look at how far
  // we got to figure out what's missing.
  let i = startIdx;
  if (i >= tokens.length) {
    return { keywords: ["UNTIL", "SINCE", "ALL"], timeLiteral: true };
  }
  const tok = tokens[i];
  if (tokenIsTimeKeyword(tok, "all")) {
    return { keywords: ["TIME"] };
  }
  if (tokenIsTimeKeyword(tok, "until") || tokenIsTimeKeyword(tok, "since")) {
    return { timeLiteral: true };
  }
  if (isTimeBound(tok)) {
    // We have a left bound; might be followed by `to <bound>`.
    return { keywords: ["TO", "AND", "GROUP", "ORDER", "LIMIT"] };
  }
  return { keywords: ["UNTIL", "SINCE", "ALL"], timeLiteral: true };
}

function skipConstraint(
  tokens: Token[],
  startIdx: number,
  metric: string | undefined
): number | null {
  void metric;
  let i = startIdx;
  if (i >= tokens.length || tokens[i].kind !== "identifier") return null;
  i++;
  // predicate: op value, IN (...), NOT IN (...), IN <time-region>
  if (i >= tokens.length) return null;
  const next = tokens[i];
  if (next.kind === "operator") {
    i++;
    if (i >= tokens.length) return null;
    if (!isValueToken(tokens[i])) return null;
    return i + 1;
  }
  if (tokenIsKeyword(next, "not")) {
    i++;
    if (i >= tokens.length || !tokenIsKeyword(tokens[i], "in")) return null;
    i++;
    return skipParenSet(tokens, i);
  }
  if (tokenIsKeyword(next, "in")) {
    i++;
    if (i >= tokens.length) return null;
    if (tokens[i].kind === "punctuation" && tokens[i].text === "(") {
      return skipParenSet(tokens, i);
    }
    // IN <time-region>
    return skipTimeRegion(tokens, i);
  }
  return null;
}

function diagnoseConstraintGap(
  tokens: Token[],
  startIdx: number,
  metric: string | undefined
): Expectation {
  if (startIdx >= tokens.length) {
    return { dimension: true, dimensionMetric: metric };
  }
  const tok = tokens[startIdx];
  if (tok.kind !== "identifier") {
    return { dimension: true, dimensionMetric: metric };
  }
  // Dimension token there — predicate is what's missing.
  const after = startIdx + 1;
  if (after >= tokens.length) {
    return { operator: true, keywords: ["IN", "NOT"] };
  }
  const next = tokens[after];
  if (tokenIsKeyword(next, "not")) {
    return { keywords: ["IN"] };
  }
  if (next.kind === "operator") {
    return { value: true };
  }
  if (tokenIsKeyword(next, "in")) {
    return { keywords: ["UNTIL", "SINCE", "ALL"], timeLiteral: true };
  }
  return { operator: true, keywords: ["IN", "NOT"] };
}

function skipParenSet(tokens: Token[], startIdx: number): number | null {
  let i = startIdx;
  if (i >= tokens.length || tokens[i].kind !== "punctuation" || tokens[i].text !== "(") {
    return null;
  }
  i++;
  while (i < tokens.length) {
    if (tokens[i].kind === "punctuation" && tokens[i].text === ")") {
      return i + 1;
    }
    if (!isValueToken(tokens[i]) && !(tokens[i].kind === "punctuation" && tokens[i].text === ",")) {
      return null;
    }
    i++;
  }
  return null;
}

function skipOverClause(tokens: Token[], startIdx: number): number | null {
  // Time region + AND constraints loop, no grouping clauses.
  const afterTimeRegion = skipTimeRegion(tokens, startIdx);
  if (afterTimeRegion === null) return null;
  let i: number = afterTimeRegion;
  while (i < tokens.length && tokenIsKeyword(tokens[i], "and")) {
    i++;
    const next = skipConstraint(tokens, i, undefined);
    if (next === null) return null;
    i = next;
  }
  return i;
}

// ===== Token classifiers =====

function tokenIsKeyword(tok: Token, text: string): boolean {
  return tok.kind === "keyword" && tok.text.toLowerCase() === text;
}

function tokenIsTimeKeyword(tok: Token, text: string): boolean {
  return tok.kind === "time-keyword" && tok.text.toLowerCase() === text;
}

function isTimeBound(tok: Token): boolean {
  // A time bound is a numeric year, a time literal (YYYY-Qn,
  // YYYY-MM, YYYY-MM-DD), or — strictly — a 4-digit number.
  return tok.kind === "number" || tok.kind === "time-literal";
}

function isValueToken(tok: Token): boolean {
  return tok.kind === "string" || tok.kind === "number" || tok.kind === "time-literal";
}

// ===== Materialization =====

async function materialize(
  expectation: Expectation,
  opts: CompleteOpts
): Promise<Completion[]> {
  const out: Completion[] = [];

  if (expectation.keywords) {
    for (const k of expectation.keywords) {
      out.push({ text: k.toUpperCase(), kind: "keyword" });
    }
  }
  if (expectation.softKeywords) {
    for (const k of expectation.softKeywords) {
      out.push({ text: k.toLowerCase(), kind: "soft-keyword" });
    }
  }
  if (expectation.grain) {
    for (const g of ["day", "week", "month", "quarter", "year"]) {
      out.push({ text: g, kind: "grain" });
    }
  }
  if (expectation.operator) {
    for (const op of ["=", "!=", ">", "<", ">=", "<="]) {
      out.push({ text: op, kind: "operator" });
    }
  }
  if (expectation.metric) {
    const metrics = opts.semanticLayer.listMetrics();
    for (const m of metrics) {
      out.push({ text: m.name, kind: "metric", hint: m.description });
    }
  }
  if (expectation.dimension) {
    const dims = expectation.dimensionMetric
      ? opts.semanticLayer.dimensionsForMetric(expectation.dimensionMetric)
      : collectAllDimensions(opts.semanticLayer);
    for (const d of dims) {
      out.push({ text: d.name, kind: "dimension" });
    }
  }
  if (expectation.lexiconEntry && opts.lexicon) {
    const entries = await opts.lexicon.list();
    for (const e of entries) {
      out.push({ text: e.name, kind: "lexicon-entry" });
    }
  }
  if (expectation.timeLiteral) {
    const years = opts.timeLiteralYears;
    if (years && years.length > 0) {
      for (const y of years) {
        out.push({ text: String(y), kind: "time-literal" });
        for (let q = 1; q <= 4; q++) {
          out.push({ text: `${y}-Q${q}`, kind: "time-literal" });
        }
        for (let m = 1; m <= 12; m++) {
          out.push({
            text: `${y}-${String(m).padStart(2, "0")}`,
            kind: "time-literal",
          });
        }
      }
    } else {
      out.push({ text: "", kind: "time-literal", hint: "year / quarter / month / day" });
    }
  }
  if (expectation.stringLiteral) {
    out.push({ text: "", kind: "string-literal", hint: 'quoted text' });
  }
  if (expectation.numberLiteral) {
    out.push({ text: "", kind: "number-literal", hint: "a number" });
  }
  if (expectation.identifier) {
    out.push({ text: "", kind: "identifier", hint: "a name" });
  }
  if (expectation.value) {
    out.push({ text: "", kind: "string-literal", hint: 'quoted text' });
    out.push({ text: "", kind: "number-literal", hint: "a number" });
    out.push({ text: "", kind: "time-literal", hint: "a date" });
  }

  return out;
}

function collectAllDimensions(
  adapter: SemanticLayerAdapter
): { name: string; isTime: boolean; dataset: string }[] {
  const seen = new Set<string>();
  const out: { name: string; isTime: boolean; dataset: string }[] = [];
  for (const m of adapter.listMetrics()) {
    for (const d of adapter.dimensionsForMetric(m.name)) {
      if (seen.has(d.name)) continue;
      seen.add(d.name);
      out.push(d);
    }
  }
  return out;
}

function filterByPrefix(candidates: Completion[], prefix: string): Completion[] {
  if (prefix.length === 0) return candidates;
  const lower = prefix.toLowerCase();
  return candidates.filter((c) => {
    // Non-concrete kinds (empty text) always pass — they're hints
    // not insertable matches.
    if (c.text === "") return true;
    return c.text.toLowerCase().startsWith(lower);
  });
}
