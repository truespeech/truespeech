# truespeech

In Ursula Le Guin's Earthsea, the True Speech is the language of wizards and dragons — a language in which words are bound elementally to the things they name, making lies and deception impossible.

**truespeech** is a technology for LLM-to-human communication that guarantees what the user sees is valid and accurate. It is a programming language in which an LLM expresses its claims, and a runtime that validates those claims against real data before rendering them into English. The result is communication that is deterministic, auditable, and provably correct.

This repository is the **truespeech runtime** — a small, browser-friendly TypeScript library with no runtime dependencies that parses and executes truespeech statements against a configurable data stack.

## Learn the language

This README documents the *runtime library* — how to embed it in your own app. To learn the **language itself**, use the docs at **[truespeech.io](https://truespeech.io)**:

- **[Tutorial](https://truespeech.io/tutorial.html)** — a guided introduction with runnable examples. Start here.
- **[Sandbox](https://truespeech.io/sandbox.html)** — a free-form notebook for experimenting.
- **[Reference](https://truespeech.io/reference.html)** — the canonical, exhaustive specification of the grammar, semantics, and runtime API.

## What it does

truespeech has five statements: `COMPUTE` (run a metric query), `REGISTER` / `UNREGISTER` (add or drop a lexicon entry), `CHECK` (look up the lexicon for a region), and `SHOW LEXICON` / `SHOW SCHEMA` (introspect the lexicon or the semantic model).

The **lexicon** is a queryable, reconcilable map of contextual knowledge about your data, with two entry kinds:

- **regions** — patches of data (a bot-attack window, an outage, a known anomaly)
- **boundaries** — cuts that partition the data (a metric redefinition, a pricing change)

Reconciliation runs automatically against `COMPUTE`: if any lexicon entry applies to a result value, it surfaces both at the query level (`result.reconciliation`) and per-row (`result.decorations`). See the [reference](https://truespeech.io/reference.html) for the full semantics.

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

The runtime is decoupled from any specific semantic layer, database, or lexicon storage via three adapter interfaces (`SemanticLayerAdapter`, `DatabaseAdapter`, `LexiconAdapter`). Bring your own implementations, or use the supplied `osiAdapter` wrapper for the [OSI Runtime](https://github.com/truespeech/osi-runtime). The lexicon adapter is optional — `REGISTER` / `UNREGISTER` / `CHECK` / `SHOW LEXICON` require it; `COMPUTE` and `SHOW SCHEMA` work without it.

The adapter interfaces and the full runtime API (`tokenize` / `parse` / `validate` / `execute` / `complete`, the `ExecuteResult` union, the region utilities, and the error shapes) are specified in the [Runtime API section of the reference](https://truespeech.io/reference.html#runtime-api).

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

// REGISTER — annotate the lexicon
await ts.execute(`
  REGISTER region bot_campaign_2026_02
    IMPACTING total_sales, order_count OVER 2026-02-03 to 2026-02-04
    WITH "Credential-stuffing campaign inflated session and order counts"
`);

// CHECK — query the lexicon directly
const check = await ts.execute("CHECK total_sales OVER 2026-Q1");
check.matches;          // discriminated union: RegionMatch | BoundaryMatch
```

`execute()` throws `TrueSpeechExecutionError` if any phase produced errors; call the individual phase methods (`parse` / `validate`) if you want errors as data. See the [reference](https://truespeech.io/reference.html#runtime-api) for every method and result type.

## Development

```bash
npm install
npm run build       # tsc → dist/
npm test            # Node's built-in test runner via tsx
```

The runtime has no runtime dependencies. The compiled `dist/` is a set of ES modules suitable for both Node and the browser.

## License

Apache 2.0
