# truespeech

In Ursula Le Guin's Earthsea, the True Speech is the language of wizards and dragons — a language in which words are bound elementally to the things they name, making lies and deception impossible.

**truespeech** is a technology for LLM-to-human communication that guarantees what the user sees is valid and accurate. It is a programming language in which an LLM expresses its claims, and a runtime that validates those claims against real data before rendering them into English. The result is communication that is deterministic, auditable, and provably correct.

This repository contains the **True Speech runtime** — a small, browser-friendly TypeScript library that parses and executes True Speech statements against a configurable data stack.

**[Try the interactive demos →](https://truespeech.io)**

## Status

Phase 1 — `COMPUTE` only. Forthcoming phases add the **lexicon** (`REGISTER`, `CHECK`) — a queryable, reconcilable map of contextual knowledge about your data.

## Architecture

```
                   ┌──────────────────────────┐
   source code  →  │   True Speech runtime    │  →  result
                   └────┬───────────┬─────────┘
                        │           │
                  semantic-layer   database
                  adapter          adapter
```

The runtime is decoupled from any specific semantic layer or database via two adapter interfaces. Bring your own implementations, or use the supplied [`osiAdapter`](#osi-adapter) wrapper for the [OSI Runtime](https://github.com/truespeech/osi-runtime).

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
});

const result = await ts.execute(
  "COMPUTE total_sales OVER 2026-Q1 AND region = 'northeast' GROUP BY month"
);

result.semanticQuery; // the SemanticQuery the runtime built
result.sql;           // the SQL the semantic layer generated
result.results;       // the rows returned by the database
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

## API

### `new TrueSpeech({ semanticLayer, database })`

Construct a runtime with both adapters.

### `ts.tokenize(source): Token[]`

Lexical analysis. Always returns tokens; unrecognized characters become `error` tokens. Useful for syntax highlighting.

### `ts.parse(source): { ast, errors }`

Parses to an AST and collects any parse errors. Never throws. Useful for live editor feedback.

### `ts.validate(ast): { errors }`

Semantic validation against the configured semantic-layer model — catches unknown metrics, unknown dimensions, malformed time literals, range start-after-end, GROUP BY references that don't fit, ORDER BY references not in the result, and so on. Never throws.

### `ts.execute(source): Promise<ExecuteResult>`

Composes all four phases. Throws `TrueSpeechExecutionError` if any phase produced errors. Returns:

```typescript
interface ExecuteResult {
  statement: "compute";
  semanticQuery: SemanticQuery;  // what was built for the semantic layer
  sql: string;                   // what the semantic layer generated
  results: QueryResult;          // what the database returned
}
```

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
├── adapters.ts       # Adapter interfaces
├── validate.ts       # AST × adapter → errors
├── execute.ts        # Validated AST × adapters → result
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
