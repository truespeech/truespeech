# truespeech

In Ursula Le Guin's Earthsea, the True Speech is the language of wizards and dragons — a language in which words are bound elementally to the things they name, making lies and deception impossible.

**truespeech** is a technology for LLM-to-human communication that guarantees what the user sees is valid and accurate. It is a programming language in which an LLM expresses its claims, and a runtime that validates those claims against real data before rendering them into English. The result is communication that is deterministic, auditable, and provably correct.

This repository contains the **truespeech runtime** — a small, browser-friendly TypeScript library that parses and executes truespeech statements against a configurable data stack.

**[Try the interactive demos →](https://truespeech.io)**

## Status

Three statements are implemented: `COMPUTE` for querying, plus `REGISTER` and `CHECK` for the **lexicon** — a queryable, reconcilable map of contextual knowledge about your data (anomalies, data-quality issues, known events). Reconciliation runs automatically against `COMPUTE`: if any lexicon entry overlaps the queried region, it surfaces alongside the result.

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
result.reconciliation;  // any lexicon entries that overlap this region

// REGISTER — annotate the lexicon
await ts.execute(`
  REGISTER region bot_campaign_2026_02
    IMPACTING total_sales, order_count OVER 2026-02-03 to 2026-02-04
    WITH "Credential-stuffing campaign inflated session and order counts"
`);

// CHECK — query the lexicon directly
const check = await ts.execute("CHECK total_sales OVER 2026-Q1");
check.matches;          // [{ entry, impact, overlap }, ...]
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

The lexicon is a curated store of contextual knowledge about the data: known anomalies, data-quality issues, real-world events that distort metrics. Entries are *facts about the world* — a bot attack, a logging bug, a one-time promotional spike — and they record which metrics are affected and over what region.

### REGISTER

```
REGISTER <kind> <name>
  IMPACTING <metric>[, <metric>...] OVER <region>
  [IMPACTING <metric>[, <metric>...] OVER <region>]...
  WITH "<description>"
```

`<kind>` is the shape of lexicon entry being registered. Currently the only defined kind is `region` — a patch in the dimensional space (a time interval plus optional categorical constraints) over which one or more metrics are affected. The kind is required at parse time so future additions (e.g. `boundary` for a cut that partitions the space into before-and-after) slot in without a retroactive break.

Each `IMPACTING` clause carries one or more affected metrics and the region (relative to *that* metric's primary time) over which they're affected. The multi-metric shorthand requires the listed metrics to share a primary time; if they don't, write a separate `IMPACTING` clause per metric.

```
REGISTER region bot_campaign_2026_02
  IMPACTING order_count, session_starts OVER 2026-02-03 to 2026-02-04
  WITH "Credential-stuffing campaign inflated session and order counts"

REGISTER region mobile_event_drop
  IMPACTING session_starts OVER 2025-07 to 2025-12
  IMPACTING ship_count     OVER 2025-08 to 2026-01
  WITH "Mobile app analytics events were not consistently fired"
```

Descriptions are string literals — single-quoted (`'…'`) or double-quoted (`"…"`). Use double quotes for prose with apostrophes.

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

The result has shape:

```typescript
{
  statement: "check",
  matches: [
    {
      entry,    // the full LexiconEntry
      impact,   // the specific IMPACTING clause within entry that matched
      overlap,  // ResolvedRegion: the actual intersection of CHECK × impact
    },
    ...
  ]
}
```

One match per matching IMPACTING clause — if an entry impacts multiple of your queried metrics and they all overlap, you get multiple matches with the same `entry` object.

### Reconciliation in COMPUTE

Every `COMPUTE` automatically runs the same matching logic against the lexicon. If any entry's IMPACTING clause for the queried metric overlaps the OVER region, it surfaces in `result.reconciliation`:

```typescript
const r = await ts.execute("COMPUTE total_sales OVER 2026-02");
r.results;          // the data
r.reconciliation;   // any lexicon entries overlapping this region
```

The `reconciliation` field has the same `LexiconMatch[]` shape as `CHECK.matches`, so you can render them the same way.

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
  reconciliation: LexiconMatch[];     // overlapping lexicon entries
}

interface RegisterResult {
  statement: "register";
  entry: LexiconEntry;                // the entry that was added
}

interface CheckResult {
  statement: "check";
  matches: LexiconMatch[];            // entries with overlapping IMPACTING clauses
}
```

### Region utilities

The runtime exports a small set of pure functions for working with `ResolvedRegion`:

- `resolveRegion(over, primaryTimeFieldName): ResolvedRegion` — turn an AST `OverClause` into a date interval + constraints.
- `intersectRegions(a, b): ResolvedRegion | null` — compute the overlap of two regions; null if their time intervals don't intersect.
- `renderTimeRegion(start, end): string` — pretty-print a date interval at the coarsest unit at which both endpoints align (e.g. `[2026-01-01, 2026-12-31]` → `"2026"`, `[2026-02-01, 2026-04-30]` → `"2026-02 to 2026-04"`).
- `renderRegion(region): string` — same, plus categorical constraints joined with `AND`.

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

interface LexiconEntry {
  name: string;
  impacts: Impact[];        // one per IMPACTING clause, post-expansion
  description: string;
}

interface Impact {
  metric: string;
  region: ResolvedRegion;   // time interval + categorical constraints
}
```

The adapter is a simple add/list pair — the runtime does all the matching and overlap math in `LexiconMatch[]` form. Bring your own storage (in-memory, SQLite, a database table); duplicate names are allowed at the adapter level.

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
