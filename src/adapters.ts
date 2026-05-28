// Adapter interfaces.
//
// True Speech is decoupled from any specific semantic layer, database,
// or lexicon storage via these three adapter contracts. The runtime
// calls into them — never imports from a specific implementation — so
// the same runtime works against OSI, dbt MetricFlow, Cube, an
// in-memory mock, or anything else that can be wrapped to fit these
// shapes.
//
// The semantic-layer types deliberately mirror the OSI runtime's
// public shapes so the OsiAdapter wrapper is a near-identity. Future
// semantic-layer adapters can do more translation work as needed.

// ===== Semantic layer =====

export interface MetricInfo {
  name: string;
  description?: string;
}

export interface DimensionInfo {
  name: string;
  isTime: boolean;
  dataset: string;
}

export type Grain = "day" | "week" | "month" | "quarter" | "year";

export type WhereOperator =
  | "="
  | "!="
  | ">"
  | "<"
  | ">="
  | "<="
  | "in"
  | "not_in";

export type GroupByClause =
  | { dimension: string; grain?: undefined }
  | { dimension: string; grain: Grain };

export interface WhereClause {
  dimension: string;
  operator: WhereOperator;
  value: string | number | (string | number)[];
}

export interface OrderByClause {
  field: string;
  direction?: "asc" | "desc";
}

export interface SemanticQuery {
  metric: string;
  groupBy?: GroupByClause[];
  where?: WhereClause[];
  orderBy?: OrderByClause[];
  limit?: number;
}

export interface SemanticLayerAdapter {
  // Discovery — used at validation time to check references.
  listMetrics(): MetricInfo[];
  dimensionsForMetric(metricName: string): DimensionInfo[];
  primaryTimeForMetric(metricName: string): DimensionInfo | null;

  // Translation — used at execution time.
  toSQL(query: SemanticQuery): string;
}

// ===== Database =====

export interface QueryResult {
  columns: string[];
  rows: (string | number | null)[][];
}

export interface DatabaseAdapter {
  execute(sql: string): Promise<QueryResult>;
}

// ===== Lexicon =====
//
// The lexicon stores curated entries — typically annotations of known
// data-quality issues, anomalies, or contextual notes that consumers of
// the data should be aware of. Each entry has one or more "impacts": a
// (metric, region) pair stating that this entry is relevant to that
// metric within that region.
//
// Storage is left to the application: in-memory for a demo, a file or
// database for persistence, etc. The runtime treats the lexicon as a
// flat list — query/filter logic happens in the runtime itself.

// Lexicon entries come in multiple kinds, discriminated by `kind`.
//
// `region`: a patch — time interval plus optional categorical constraints
// — over which one or more metrics are affected. Each Impact is a
// (metric, region) pair, post-expansion of multi-metric IMPACTING.
//
// `boundary`: a cut at an instant that partitions the dimensional space.
// A single AT date applies to all impacted metrics. Optional categorical
// constraints scope the cut to a sub-population. Triggers when a query's
// computed value mixes inputs from both sides of the cut.
export type LexiconEntry = RegionLexiconEntry | BoundaryLexiconEntry;

export interface RegionLexiconEntry {
  kind: "region";
  name: string;
  impacts: Impact[];
  description: string;
}

export interface BoundaryLexiconEntry {
  kind: "boundary";
  name: string;
  // ISO YYYY-MM-DD, the instant of the cut.
  at: string;
  // Categorical scoping for the cut (empty if applies to all dim values).
  constraints: ResolvedConstraint[];
  // Metrics affected by this cut.
  metrics: string[];
  // Regime descriptions. `before.label` and `after.label` are short and
  // appear inline in result-row notes; `before.description` and
  // `after.description` are longer prose surfaced in reconciliation and
  // historical footers.
  before: RegimeDescription;
  after: RegimeDescription;
  // Optional override for the runtime-composed change-description
  // sentence in straddling/spanning footers. When absent, the runtime
  // composes wording from `before` and `after`.
  changeDescription?: string;
}

export interface RegimeDescription {
  label: string;
  description: string;
}

export interface Impact {
  metric: string;
  region: ResolvedRegion;
}

export interface ResolvedRegion {
  // ISO YYYY-MM-DD, both ends inclusive (matches the closed-interval
  // semantics of the language). The interval is in the calendar of the
  // metric's primary time field.
  timeStart: string;
  timeEnd: string;
  constraints: ResolvedConstraint[];
}

export interface ResolvedConstraint {
  dimension: string;
  operator: WhereOperator;
  value: string | number | (string | number)[];
}

// A successful match between a query and a lexicon entry, discriminated
// by `kind` to mirror LexiconEntry's discrimination.
//
// `region`: the query's region overlapped the entry's impact region.
// `impact` is the specific IMPACTING clause that matched; `overlap` is
// the actual region intersection computed at match time, useful for
// surfacing the *why*.
//
// `boundary`: the query's region straddled the entry's cut date AND
// the query's predicate space overlapped the entry's categorical scope.
// `metric` is the impacted metric the match was found for; `crossedAt`
// is the boundary's AT date.
export type LexiconMatch = RegionMatch | BoundaryMatch;

export interface RegionMatch {
  kind: "region";
  entry: RegionLexiconEntry;
  impact: Impact;
  overlap: ResolvedRegion;
}

// Per-row classification of a row against a boundary cut:
//   "before"    — row's time interval is entirely pre-cut
//   "after"     — row's time interval is entirely post-cut
//   "straddles" — row's interval spans the cut (the value mixes regimes)
export type BoundarySide = "before" | "after" | "straddles";

export interface BoundaryMatch {
  kind: "boundary";
  entry: BoundaryLexiconEntry;
  metric: string;
  crossedAt: string;
  // Per-row context. At the query level (returned in
  // ComputeResult.reconciliation), `side` is always "straddles" — the
  // query itself spans the cut. At the per-row level (in
  // RowDecoration.matches), it carries each row's actual relationship.
  side: BoundarySide;
}

// Per-row reconciliation: which of the COMPUTE's reconciliation matches
// apply to a specific result row, given the row's slice of the data.
// Index-aligned with ComputeResult.results.rows. An empty `matches`
// array means the row is unaffected by any lexicon entry.
//
// `severity` summarizes the worst-case match on this row:
//   "error" — a boundary match with side=straddles (value mixes regimes)
//   "warn"  — a region match, or a boundary "before"/"after" annotation
//             surfacing regime context in a spanning query
//   undefined — no matches on this row
export interface RowDecoration {
  matches: LexiconMatch[];
  severity?: "warn" | "error";
}

// Historical-context note: emitted when a query falls entirely on the
// pre-cut side of a boundary. The values themselves aren't flagged
// (they're internally consistent under the old regime) but the
// post-cut "now" reading is worth surfacing.
export interface HistoricalNote {
  boundary: BoundaryLexiconEntry;
  metric: string;
}

export interface LexiconAdapter {
  add(entry: LexiconEntry): Promise<void>;
  list(): Promise<LexiconEntry[]>;
  // Drop the entry whose name matches. Returns true if an entry was
  // removed, false if no entry by that name existed. Non-throwing —
  // the caller decides whether "not found" is an error.
  // Added in v0.4.0 to back the UNREGISTER statement.
  remove(name: string): Promise<boolean>;
}

// ===== Completion (v0.5.0) =====
//
// `TrueSpeech.complete(source, position)` returns the set of valid
// next tokens at a cursor position, suitable for driving a Tab-style
// autocomplete UI. The analyzer walks the tokens up to the cursor,
// re-derives what the parser would expect next, and materializes
// concrete candidates by querying the semantic layer (for metric and
// dimension names) and the lexicon (for entry names).

export type CompletionKind =
  // Reserved grammar word from KEYWORDS / TIME_KEYWORDS / GRAINS in
  // tokens.ts; suggested in upper case as a typographic convention,
  // but the parser accepts any case.
  | "keyword"
  // "Soft" keywords that the tokenizer classifies as identifiers and
  // the parser dispatches on by text (region, boundary, lexicon,
  // schema). Same casing convention as keywords.
  | "soft-keyword"
  // A metric name from the semantic layer.
  | "metric"
  // A dimension name from the semantic layer. Filtered to the active
  // metric's dataset when one has been picked already.
  | "dimension"
  // A bare time grain (day / week / month / quarter / year).
  | "grain"
  // A comparison operator (=, !=, >, <, >=, <=).
  | "operator"
  // A registered lexicon entry name (for UNREGISTER, SHOW LEXICON,
  // and similar name-based references).
  | "lexicon-entry"
  // A time literal is expected at this position (year, quarter,
  // month, day, range). No concrete candidates — consumers typically
  // surface a hint rather than suggest a specific date.
  | "time-literal"
  // A string literal is expected (e.g. WITH "<description>"). No
  // concrete candidates.
  | "string-literal"
  // A number literal is expected (e.g. LIMIT 10). No concrete
  // candidates.
  | "number-literal"
  // A free-form identifier is expected (e.g. the name on REGISTER
  // region <name>). No concrete candidates.
  | "identifier";

export interface Completion {
  // What to insert. For keywords / soft-keywords / grains, this is
  // the canonical form (upper-case for keywords, lower-case for soft
  // keywords and grains). For metrics, dimensions, and lexicon
  // entries, it's the actual name from the model.
  text: string;
  kind: CompletionKind;
  // Optional one-line human-readable hint a UI can render alongside
  // the candidate (e.g. a metric's description).
  hint?: string;
}

export interface CompletionResult {
  // The partial text being completed, taken from the source between
  // the start of the current token and the cursor. Empty if the
  // cursor sits at a token boundary (after whitespace or at the
  // start of the source).
  prefix: string;
  // Source offset where the current partial token starts. Consumers
  // replace [start, end) with the chosen completion's text.
  start: number;
  // Source offset of the cursor — always equal to the `position`
  // argument that was passed to complete().
  end: number;
  // Valid completions at this position, filtered to those whose text
  // case-insensitively starts with `prefix`. Includes placeholder
  // entries for non-concrete kinds (time-literal, string-literal,
  // number-literal, identifier) with an empty `text` and a `hint` —
  // consumers can surface these as "type a date" / "type a name"
  // affordances rather than insertable choices.
  candidates: Completion[];
}
