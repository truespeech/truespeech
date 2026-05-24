# truespeech

In Ursula Le Guin's Earthsea, the True Speech is the language of wizards and dragons — a language in which words are bound elementally to the things they name, making lies and deception impossible.

**truespeech** is a technology for LLM-to-human communication that guarantees what the user sees is valid and accurate. It is a programming language in which an LLM expresses its claims, and a runtime that validates those claims against real data before rendering them into English. The result is communication that is deterministic, auditable, and provably correct.

This repository contains the **truespeech runtime** — a small, browser-friendly TypeScript library that parses and executes truespeech statements against a configurable data stack.

**[Try the interactive demos →](https://truespeech.io)**

## Status

Three statements are implemented: `COMPUTE` for querying, plus `REGISTER` and `CHECK` for the **lexicon** — a queryable, reconcilable map of contextual knowledge about your data. The lexicon supports two entry kinds:

- **regions** — patches of data (a bot attack window, an outage, a known anomaly)
- **boundaries** — cuts that partition the data (a metric redefinition, a pricing change)

Reconciliation runs automatically against `COMPUTE`: if any lexicon entry applies to a given result value, it surfaces both at the query level (`result.reconciliation`) and per-row (`result.decorations`).

## Architecture

```
                   ┌──────────────────────────┐
   source code  →  │    truespeech runtime    │  →  result
                   └──┬─────────┬─────────┬───┘
                      │         │         │
                  semantic-  database  lexicon
                  layer      adapter   adapter
                  adapter
```

The runtime is decoupled from any specific semantic layer, database, or lexicon storage via three adapter interfaces. Bring your own implementations, or use the supplied [`osiAdapter`](#osi-adapter) wrapper for the [OSI Runtime](https://github.com/truespeech/osi-runtime). The lexicon adapter is optional — `REGISTER` and `CHECK` require it; plain `COMPUTE` works without it.

## Quick start

```typescript
import { TrueSpeech, osiAdapter } from "truespeech";
import { OsiRuntime } from "osi-runtime";

const osi = new OsiRuntime(yamlModel);

const ts = new TrueSpeech({
  semanticLayer: osiAdapter(osi),
  database: {
    execute: async (sql) => myDatabase.query(sql),
  },
  lexicon: myLexiconAdapter, // optional — required for REGISTER / CHECK
});

// COMPUTE — query the data
const result = await ts.execute(
  "COMPUTE total_sales OVER 2026-Q1 AND region = 'northeast' GROUP BY month"
);
result.semanticQuery;   // the SemanticQuery the runtime built
result.sql;             // the SQL the semantic layer generated
result.results;         // the rows returned by the database
result.reconciliation;  // query-level lexicon matches
result.decorations;     // per-row matches, index-aligned with results.rows

// REGISTER region — annotate a patch of data
await ts.execute(`
  REGISTER region bot_campaign_2026_02
    IMPACTING total_sales, order_count OVER 2026-02-03 to 2026-02-04
    WITH "Credential-stuffing campaign inflated session and order counts"
`);

// REGISTER boundary — annotate a cut in time. BEFORE and AFTER describe
// each side of the cut; the runtime uses them to label result rows by
// regime and to compose footers for historical and spanning queries.
await ts.execute(`
  REGISTER boundary ltv_redef_enterprise
    AT 2026-01-01 AND product_tier = 'enterprise'
    IMPACTING LTV
    BEFORE "v1 enterprise LTV" "12-month gross subscription revenue (excludes refunds)"
    AFTER  "v2 enterprise LTV" "18-month net subscription revenue (includes refunds)"
`);

// CHECK — query the lexicon directly
const check = await ts.execute("CHECK total_sales OVER 2026-Q1");
check.matches;          // discriminated union: RegionMatch | BoundaryMatch
```

## The COMPUTE statement

```
COMPUTE <metric>
  OVER <time-region> [AND <constraint>]...
  [GROUP BY <field>[, <field>]...]
  [ORDER BY <field> [ASC|DESC][, ...]]
  [LIMIT <n>]
```

### OVER — addressing a region

The first clause of `OVER` is **always** the metric's primary time axis, written in a small calendar mini-language:

| Form | Example | Meaning |
|---|---|---|
| Year | `2026` | All of 2026 |
| Quarter | `2026-Q1` | First quarter of 2026 |
| Month | `2026-02` | February 2026 |
| Day | `2026-02-15` | A single day |
| Range | `2026-02-03 to 2026-02-10` | Closed-inclusive interval. Both ends must be the same unit |
| Open-ended | `until 2026-Q1`, `since 2026-01-15` | Inclusive bound |
| Unbounded | `all time` | No time constraint |

Additional constraints are joined with `AND` and use a uniform `<dimension> <operator> <value>` shape:

```
AND region = 'northeast'
AND region IN ('northeast', 'west')
AND region NOT IN ('midwest')
AND ship_date >= 2026-02-01
AND ship_date IN 2026-Q1                  -- IN extends to time containment
AND ship_date IN 2026-02-01 to 2026-02-28
```

Operators: `=`, `!=`, `>`, `<`, `>=`, `<=`, `IN`, `NOT IN`. Only `AND` is supported between constraints — regions are intersections by design.

### GROUP BY

Bare grain words refer implicitly to the metric's primary time:

```
GROUP BY month                   -- primary time at month grain
GROUP BY region                  -- categorical dimension
GROUP BY region, month           -- multiple
GROUP BY ship_date:week          -- explicit time dimension with grain
```

Time dimensions in GROUP BY *must* have a grain.

### ORDER BY / LIMIT

```
ORDER BY total_sales DESC, region ASC
LIMIT 10
```

`ORDER BY` fields must reference result columns (group-by fields or the metric name). `LIMIT` is a non-negative integer.

## The lexicon — REGISTER and CHECK

The lexicon is a curated store of contextual knowledge about the data: known anomalies, data-quality issues, real-world events that distort metrics, schema or definition changes. Entries are *facts about the world* — a bot attack, a logging bug, a one-time promotional spike, a metric methodology change — and they record which metrics are affected and where.

The lexicon supports two entry kinds:

- **region** — a *patch* in dimensional space. Data inside the patch is suspect or special.
- **boundary** — a *cut* at an instant. Data on either side of the cut is fine in isolation, but mixing across it produces an incoherent value.

Both kinds share the lexicon adapter, the auto-reconciliation surface in `COMPUTE`, and the per-row decoration model. They differ in trigger semantics (overlap vs. straddle) and in their syntactic shape.

Descriptions on either kind are string literals — single-quoted (`'…'`) or double-quoted (`"…"`). Use double quotes for prose with apostrophes.

### REGISTER region

```
REGISTER region <name>
  IMPACTING <metric>[, <metric>...] OVER <region>
  [IMPACTING <metric>[, <metric>...] OVER <region>]...
  WITH "<description>"
```

A region is a contiguous slice of the data — a time interval plus optional categorical constraints — over which one or more metrics are affected. Each `IMPACTING` clause carries one or more affected metrics and the region (relative to *that* metric's primary time) over which they're affected. The multi-metric shorthand requires the listed metrics to share a primary time; if they don't, write a separate `IMPACTING` clause per metric.

```
REGISTER region bot_campaign_2026_02
  IMPACTING order_count, session_starts OVER 2026-02-03 to 2026-02-04
  WITH "Credential-stuffing campaign inflated session and order counts"

REGISTER region mobile_event_drop
  IMPACTING session_starts OVER 2025-07 to 2025-12
  IMPACTING ship_count     OVER 2025-08 to 2026-01
  WITH "Mobile app analytics events were not consistently fired"
```

A region triggers a result value when that value's underlying input rows came from inside the patch.

### REGISTER boundary

```
REGISTER boundary <name>
  AT <date> [AND <constraint>]...
  IMPACTING <metric>[, <metric>...]
  BEFORE "<short label>" "<long description>"
  AFTER  "<short label>" "<long description>"
  [WITH  "<change description>"]
```

A boundary is a cut at an instant — a metric redefinition, a pricing change, a logging-pipeline switch. `AT` takes a day-form date; year/quarter/month forms are rejected because boundaries are instants, not intervals. A single `AT` applies to all impacted metrics in the `IMPACTING` clause.

Both `BEFORE` and `AFTER` are mandatory and each take two strings: a short label (rendered inline in result-row notes when a query straddles or spans the cut) and a longer description (carried in reconciliation and historical footers). The short label is what an analyst sees in the warn/error cell on a row that touches that regime; the long description is the durable knowledge — "what was true on this side of the cut."

`WITH` is optional. When present it overrides the runtime-composed change-description sentence shown in the footer of a spanning/straddling query. When absent, the runtime composes wording from the `BEFORE` and `AFTER` halves.

Optional `AND` constraints scope the cut to a sub-population — e.g. a metric change that affected only one segment:

```
REGISTER boundary ltv_redef_enterprise
  AT 2026-01-01 AND product_tier = 'enterprise'
  IMPACTING LTV
  BEFORE "v1 enterprise LTV" "Computed as 12-month gross subscription revenue (excludes refunds)"
  AFTER  "v2 enterprise LTV" "Computed as 18-month net subscription revenue (includes refunds)"
```

Multi-metric IMPACTING follows the same shared-primary-time rule as regions.

#### Trigger semantics

The runtime treats the **post-cut regime as the operator's "now"**: it's assumed to be normal and isn't annotated. The pre-cut regime is history; queries that live in it get a footer note so the operator knows they're not reading the current state. Queries that span the cut get per-row regime context, and rows whose own interval straddles the cut get a harsher flag — that value mixes two regimes and is semantically incoherent.

| Query shape | Outcome |
|---|---|
| Entirely **post-cut** (the "now" world) | **silent** — no row flag, no footer |
| Entirely **pre-cut** (historical query) | **historical footer** — *"These values were computed under the pre-cut regime: `<BEFORE description>`. As of `<AT>`, …`<AFTER description>`."* (runtime-owned wording) |
| **Spans the cut**, every row cleanly on one side | **warn (amber)** on each row — note cell carries the regime's short label so the analyst sees which world each row is in |
| **Spans the cut**, ≥1 row's own interval straddles | **error (red)** on the straddling row (the value mixes regimes); **warn** on the clean rows |

Concretely: a row's interval `[start, end]` straddles the cut at `T` iff `start < T ≤ end`. The "≤" on the right makes "T is the first day of the new regime" the natural reading — a row that starts exactly at `T` contains only post-cut data and does not trigger.

Worked example for `REGISTER boundary aov_redef AT 2026-01-01 IMPACTING average_order_value BEFORE … AFTER …`:

| Query | Outcome |
|---|---|
| `COMPUTE aov OVER 2026-Q1` | silent (entirely post-cut) |
| `COMPUTE aov OVER 2025-Q4` | historical footer (entirely pre-cut) |
| `COMPUTE aov OVER 2025-Q4 to 2026-Q1` | **error** — one row, inputs span the cut |
| `COMPUTE aov OVER 2025-Q4 to 2026-Q1 GROUP BY quarter` | **warn** on each row: Q4 labeled with the BEFORE short label, Q1 with the AFTER label; no row straddles |
| `COMPUTE aov OVER 2025-Q4 to 2026-Q1 GROUP BY month` | same shape, six rows; the December rows carry the BEFORE label, the Jan-Mar rows the AFTER label |

The historical-footer wording is composed by the runtime from the registered `BEFORE` and `AFTER` descriptions. If you want different wording in a specific case, supply `WITH "<sentence>"` on the entry — that override is used in straddling/spanning footers (the historical footer is always runtime-composed since it's structurally a fixed "you are reading history" pattern).

### CHECK

```
CHECK <metric>[, <metric>...] OVER <region>
```

Returns matching lexicon entries with the actual region overlap computed:

```
CHECK total_sales OVER 2026-Q1
CHECK conversion_rate, order_count OVER 2026-02
CHECK total_sales OVER all time      -- unbounded form (OVER is required)
```

`OVER` is always required — use `OVER all time` for the unscoped case. Multi-metric form requires shared primary time, same rule as multi-metric COMPUTE.

Returns matches across both entry kinds. `LexiconMatch` is a discriminated union:

```typescript
{
  statement: "check",
  matches: LexiconMatch[];   // RegionMatch | BoundaryMatch (see API below)
}
```

For region entries, you get one match per matching IMPACTING clause — if an entry impacts multiple of your queried metrics and they all overlap, you get multiple matches with the same `entry` object. For boundary entries, you get one match per (boundary, queried-metric) pair where the boundary applies to that metric and the query straddles its cut.

### Reconciliation in COMPUTE

Every `COMPUTE` automatically runs the same matching logic against the lexicon — both at the query level and per-row:

```typescript
const r = await ts.execute("COMPUTE total_sales OVER 2026-02");
r.results;          // the data
r.reconciliation;   // query-level lexicon matches (LexiconMatch[])
r.decorations;      // per-row matches (RowDecoration[]), index-aligned with results.rows
```

`reconciliation` has the same `LexiconMatch[]` shape as `CHECK.matches`. `decorations[i]` is the subset of `reconciliation` that applies to result row `i`. An empty `matches` array on a `RowDecoration` means the row is unaffected.

For regions, a row matches when its slice overlaps the impact region. For boundaries, a row matches when its slice straddles the cut (and is compatible with any categorical scope) — see [Trigger semantics](#trigger-semantics) above.

## API

### `new TrueSpeech({ semanticLayer, database, lexicon? })`

Construct a runtime. `lexicon` is optional; if omitted, `REGISTER` and `CHECK` throw at execute time and `COMPUTE` skips reconciliation.

### `ts.tokenize(source): Token[]`

Lexical analysis. Always returns tokens; unrecognized characters become `error` tokens. Useful for syntax highlighting.

### `ts.parse(source): { ast, errors }`

Parses to an AST and collects any parse errors. Never throws. Useful for live editor feedback.

### `ts.validate(ast): { errors }`

Semantic validation against the configured semantic-layer model — catches unknown metrics, unknown dimensions, malformed time literals, range start-after-end, GROUP BY references that don't fit, ORDER BY references not in the result, and so on. Never throws.

### `ts.execute(source): Promise<ExecuteResult>`

Composes all four phases and dispatches on the statement kind. Throws `TrueSpeechExecutionError` if any phase produced errors. The return type is a discriminated union:

```typescript
type ExecuteResult = ComputeResult | RegisterResult | CheckResult;

interface ComputeResult {
  statement: "compute";
  semanticQuery: SemanticQuery;       // what was built for the semantic layer
  sql: string;                        // what the semantic layer generated
  results: QueryResult;               // what the database returned
  reconciliation: LexiconMatch[];     // query-level lexicon matches
  region: ResolvedRegion;             // resolved OVER region the query addressed
  decorations: RowDecoration[];       // per-row matches, index-aligned with results.rows
  historicalNotes: HistoricalNote[];  // boundaries the query falls entirely behind
}

interface RegisterResult {
  statement: "register";
  entry: LexiconEntry;                // the entry that was added (region or boundary)
}

interface CheckResult {
  statement: "check";
  matches: LexiconMatch[];            // matches across both entry kinds
}

// LexiconMatch is discriminated by `kind`.
type LexiconMatch = RegionMatch | BoundaryMatch;

interface RegionMatch {
  kind: "region";
  entry: RegionLexiconEntry;
  impact: Impact;                     // the IMPACTING clause that matched
  overlap: ResolvedRegion;            // intersection of query × impact
}

interface BoundaryMatch {
  kind: "boundary";
  entry: BoundaryLexiconEntry;
  metric: string;                     // the impacted metric the match was found for
  crossedAt: string;                  // ISO date — the boundary's AT
  side: "before" | "after" | "straddles"; // per-row context; "straddles" at query level
}

interface RowDecoration {
  matches: LexiconMatch[];            // subset of reconciliation that apply to this row
  severity?: "warn" | "error";        // "error" if any match is a boundary straddle
}

interface HistoricalNote {
  boundary: BoundaryLexiconEntry;     // the boundary the query falls entirely behind
  metric: string;
}
```

### Region utilities

The runtime exports a small set of pure functions for working with regions and per-row matching:

- `resolveRegion(over, primaryTimeFieldName): ResolvedRegion` — turn an AST `OverClause` into a date interval + constraints.
- `intersectRegions(a, b): ResolvedRegion | null` — compute the overlap of two regions; null if their time intervals don't intersect.
- `renderTimeRegion(start, end): string` — pretty-print a date interval at the coarsest unit at which both endpoints align (e.g. `[2026-01-01, 2026-12-31]` → `"2026"`, `[2026-02-01, 2026-04-30]` → `"2026-02 to 2026-04"`).
- `renderRegion(region): string` — same, plus categorical constraints joined with `AND`.
- `buildRowRegion(row, groupBys, queryRegion): RowRegion` — derive a result row's effective slice from the query region and any group-by columns.
- `rowMatchesImpact(rowRegion, impactRegion): boolean` — does the row's slice overlap an impact region? (region-match test)
- `crossesBoundary(rowRegion, { at, constraints }): boolean` — does the row's slice straddle the cut and is its predicate space compatible with the boundary's scope? (boundary-match test)
- `classifyRowAgainstBoundary(rowRegion, boundary): "before" | "after" | "straddles" | null` — finer classification used by `decorationsFor` for v0.3.0 per-row regime labeling. Returns `null` if the row is outside the boundary's categorical scope.
- `decorationsFor(rows, matches, groupBys, queryRegion): RowDecoration[]` — wire the above into per-row decoration arrays. Used internally by `executeCompute` to populate `ComputeResult.decorations`; exported for callers that want to compute decorations against alternative match sets.

### Errors

Errors are data, not exceptions:

```typescript
interface TrueSpeechError {
  code: ErrorCode;        // stable identifier: "unknown_metric", etc.
  message: string;
  span: { start: number; end: number };
  notes?: string[];
  help?: string;
  relatedSpans?: { span: Span; label: string }[];
}
```

`renderError(error, source)` produces a Rust-style caret diagnostic for terminal display:

```
error[unknown_metric]: Unknown metric "total_sals"
  --> 1:9
  |
1 | COMPUTE total_sals OVER 2026-02
  |         ^^^^^^^^^^
  = help: Available metrics: total_sales, average_order_value, order_count
```

`TrueSpeechExecutionError.errors` exposes the full list when `execute()` throws.

## Adapters

### Semantic layer

```typescript
interface SemanticLayerAdapter {
  listMetrics(): MetricInfo[];
  dimensionsForMetric(metricName: string): DimensionInfo[];
  primaryTimeForMetric(metricName: string): DimensionInfo | null;
  toSQL(query: SemanticQuery): string;
}
```

### Database

```typescript
interface DatabaseAdapter {
  execute(sql: string): Promise<QueryResult>;
}
```

### Lexicon

```typescript
interface LexiconAdapter {
  add(entry: LexiconEntry): Promise<void>;
  list(): Promise<LexiconEntry[]>;
}

// LexiconEntry is discriminated by `kind`. The adapter stores both
// shapes uniformly; the runtime dispatches on kind during matching.
type LexiconEntry = RegionLexiconEntry | BoundaryLexiconEntry;

interface RegionLexiconEntry {
  kind: "region";
  name: string;
  impacts: Impact[];                  // one per IMPACTING clause, post-expansion
  description: string;
}

interface BoundaryLexiconEntry {
  kind: "boundary";
  name: string;
  at: string;                         // ISO YYYY-MM-DD, the cut's instant
  constraints: ResolvedConstraint[];  // categorical scope (empty = all dim values)
  metrics: string[];                  // impacted metrics
  before: RegimeDescription;          // pre-cut regime: { label, description }
  after: RegimeDescription;           // post-cut regime: { label, description }
  changeDescription?: string;         // optional WITH override for the footer
}

interface RegimeDescription {
  label: string;                      // short — rendered inline in row notes
  description: string;                // long-form prose — rendered in footers
}

interface Impact {
  metric: string;
  region: ResolvedRegion;             // time interval + categorical constraints
}
```

The adapter is a simple add/list pair — the runtime does all the matching and overlap/crossing math itself in `LexiconMatch[]` form. Bring your own storage (in-memory, SQLite, a database table); duplicate names are allowed at the adapter level.

### OSI adapter

`osiAdapter(runtime)` wraps an [OSI Runtime](https://github.com/truespeech/osi-runtime) instance into a `SemanticLayerAdapter`. The shapes already match — this is a near-identity wrapper for clarity.

## Project layout

```
src/
├── index.ts          # Public API: TrueSpeech class + re-exports
├── source.ts         # Position, Span types
├── errors.ts         # TrueSpeechError type, renderError
├── tokens.ts         # Token types, keyword sets
├── tokenize.ts       # string → Token[]
├── ast.ts            # AST node types
├── parse.ts          # Token[] → { ast, errors }
├── adapters.ts       # Adapter interfaces (semantic, database, lexicon)
├── region.ts         # Region resolution, intersection, rendering
├── validate.ts       # AST × adapter → errors
├── execute.ts        # Validated AST × adapters → result (dispatches by kind)
└── osi-adapter.ts    # OSI Runtime → SemanticLayerAdapter
test/
├── helpers/mocks.ts  # Reusable mock adapters for tests
└── *.test.ts         # Per-phase + integration tests
```

## Development

```bash
npm install
npm run build       # tsc → dist/
npm test            # Node's built-in test runner via tsx
```

The runtime has no runtime dependencies. The compiled `dist/` is a set of ES modules suitable for both Node and the browser.

## License

Apache 2.0
