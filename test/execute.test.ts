import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../src/tokenize.js";
import { parse } from "../src/parse.js";
import { execute as executeRaw } from "../src/execute.js";
import type {
  ComputeStatement,
  Statement,
} from "../src/ast.js";
import {
  mockDatabase,
  retailSalesMock,
} from "./helpers/mocks.js";
import type {
  SemanticQuery,
  SemanticLayerAdapter,
  DatabaseAdapter,
} from "../src/adapters.js";

// Backwards-compatible shim: these tests predate the dispatching
// execute(stmt, opts) signature. Wrap so existing call sites keep working.
function execute(
  stmt: Statement,
  semanticLayer: SemanticLayerAdapter,
  database: DatabaseAdapter
) {
  return executeRaw(stmt, { semanticLayer, database });
}

function ast(src: string): ComputeStatement {
  const r = parse(tokenize(src));
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  return r.ast as ComputeStatement;
}

// captureSql returns a semantic-layer mock that records every SemanticQuery
// it sees, so executor tests can assert on the translation.
function captureSql() {
  const queries: SemanticQuery[] = [];
  const sl = retailSalesMock();
  const wrapped = {
    ...sl,
    toSQL: (q: SemanticQuery) => {
      queries.push(q);
      return sl.toSQL(q);
    },
  };
  return { wrapped, queries };
}

// ===========================================================================
// Time region translation
// ===========================================================================

describe("execute — time region → WHERE clauses", () => {
  it("year region expands to inclusive interval", () => {
    const { wrapped, queries } = captureSql();
    const db = mockDatabase();
    return execute(ast("COMPUTE total_sales OVER 2026"), wrapped, db).then(() => {
      const w = queries[0].where!;
      assert.deepEqual(w, [
        { dimension: "order_date", operator: ">=", value: "2026-01-01" },
        { dimension: "order_date", operator: "<=", value: "2026-12-31" },
      ]);
    });
  });

  it("quarter region", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER 2026-Q1"),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].where, [
      { dimension: "order_date", operator: ">=", value: "2026-01-01" },
      { dimension: "order_date", operator: "<=", value: "2026-03-31" },
    ]);
  });

  it("month region", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER 2026-02"),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].where, [
      { dimension: "order_date", operator: ">=", value: "2026-02-01" },
      { dimension: "order_date", operator: "<=", value: "2026-02-28" },
    ]);
  });

  it("month region in leap year", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER 2024-02"),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].where, [
      { dimension: "order_date", operator: ">=", value: "2024-02-01" },
      { dimension: "order_date", operator: "<=", value: "2024-02-29" },
    ]);
  });

  it("day region (single day)", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER 2026-02-15"),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].where, [
      { dimension: "order_date", operator: ">=", value: "2026-02-15" },
      { dimension: "order_date", operator: "<=", value: "2026-02-15" },
    ]);
  });

  it("range region", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER 2026-02-03 to 2026-02-10"),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].where, [
      { dimension: "order_date", operator: ">=", value: "2026-02-03" },
      { dimension: "order_date", operator: "<=", value: "2026-02-10" },
    ]);
  });

  it("range of months expands to first/last day endpoints", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER 2026-01 to 2026-03"),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].where, [
      { dimension: "order_date", operator: ">=", value: "2026-01-01" },
      { dimension: "order_date", operator: "<=", value: "2026-03-31" },
    ]);
  });

  it("until region uses <=", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER until 2026-Q1"),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].where, [
      { dimension: "order_date", operator: "<=", value: "2026-03-31" },
    ]);
  });

  it("since region uses >=", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER since 2026-01-15"),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].where, [
      { dimension: "order_date", operator: ">=", value: "2026-01-15" },
    ]);
  });

  it("all time emits no WHERE clauses", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER all time"),
      wrapped,
      mockDatabase()
    );
    assert.equal(queries[0].where, undefined);
  });
});

// ===========================================================================
// Constraint translation
// ===========================================================================

describe("execute — additional constraints → WHERE clauses", () => {
  it("equality on categorical", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER all time AND region = 'northeast'"),
      wrapped,
      mockDatabase()
    );
    const w = queries[0].where ?? [];
    assert.ok(
      w.some(
        (c) =>
          c.dimension === "region" &&
          c.operator === "=" &&
          c.value === "northeast"
      )
    );
  });

  it("IN with set", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast(
        "COMPUTE total_sales OVER all time AND region IN ('northeast', 'west')"
      ),
      wrapped,
      mockDatabase()
    );
    const w = queries[0].where!;
    assert.deepEqual(w[0], {
      dimension: "region",
      operator: "in",
      value: ["northeast", "west"],
    });
  });

  it("NOT IN with set", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast(
        "COMPUTE total_sales OVER all time AND region NOT IN ('midwest')"
      ),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].where![0], {
      dimension: "region",
      operator: "not_in",
      value: ["midwest"],
    });
  });

  it("IN time-region (calendar)", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER all time AND ship_date IN 2026-Q1"),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].where, [
      { dimension: "ship_date", operator: ">=", value: "2026-01-01" },
      { dimension: "ship_date", operator: "<=", value: "2026-03-31" },
    ]);
  });

  it("IN time-region (range)", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast(
        "COMPUTE total_sales OVER all time AND ship_date IN 2026-02-01 to 2026-02-28"
      ),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].where, [
      { dimension: "ship_date", operator: ">=", value: "2026-02-01" },
      { dimension: "ship_date", operator: "<=", value: "2026-02-28" },
    ]);
  });

  it("comparison on secondary time dim", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast(
        "COMPUTE total_sales OVER all time AND ship_date >= 2026-02-01"
      ),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].where, [
      { dimension: "ship_date", operator: ">=", value: "2026-02-01" },
    ]);
  });

  it("numeric comparison", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER all time AND amount > 100"),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].where![0], {
      dimension: "amount",
      operator: ">",
      value: 100,
    });
  });
});

// ===========================================================================
// GROUP BY translation
// ===========================================================================

describe("execute — GROUP BY translation", () => {
  it("bare grain expands to primary time + grain", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER 2026 GROUP BY month"),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].groupBy, [
      { dimension: "order_date", grain: "month" },
    ]);
  });

  it("categorical dim passes through", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER 2026 GROUP BY region"),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].groupBy, [{ dimension: "region" }]);
  });

  it("explicit time-dim passes through with grain", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER 2026 GROUP BY ship_date:week"),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].groupBy, [
      { dimension: "ship_date", grain: "week" },
    ]);
  });

  it("multiple group-by entries preserved in order", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast(
        "COMPUTE total_sales OVER 2026 GROUP BY region, month, ship_date:week"
      ),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].groupBy, [
      { dimension: "region" },
      { dimension: "order_date", grain: "month" },
      { dimension: "ship_date", grain: "week" },
    ]);
  });
});

// ===========================================================================
// ORDER BY translation + column rename
// ===========================================================================

describe("execute — ORDER BY translation", () => {
  it("ORDER BY metric name passes through", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast(
        "COMPUTE total_sales OVER 2026 GROUP BY region ORDER BY total_sales DESC"
      ),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].orderBy, [
      { field: "total_sales", direction: "desc" },
    ]);
  });

  it("ORDER BY bare-grain user name maps to underlying time field", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER 2026 GROUP BY month ORDER BY month"),
      wrapped,
      mockDatabase()
    );
    assert.deepEqual(queries[0].orderBy, [
      { field: "order_date_month", direction: "asc" },
    ]);
  });
});

describe("execute — result column rename", () => {
  it("renames primary-time-grain column back to bare grain in results", async () => {
    const sl = retailSalesMock();
    // Have the DB return a row with the OSI-style column name
    const db = mockDatabase({
      columns: ["order_date_month", "total_sales"],
      rows: [
        ["2026-02-01", 1000],
        ["2026-03-01", 1500],
      ],
    });
    const result = await execute(
      ast("COMPUTE total_sales OVER 2026 GROUP BY month"),
      sl,
      db
    );
    assert.deepEqual(result.results.columns, ["month", "total_sales"]);
  });

  it("does not rename non-bare-grain columns", async () => {
    const sl = retailSalesMock();
    const db = mockDatabase({
      columns: ["region", "total_sales"],
      rows: [["northeast", 1000]],
    });
    const result = await execute(
      ast("COMPUTE total_sales OVER 2026 GROUP BY region"),
      sl,
      db
    );
    assert.deepEqual(result.results.columns, ["region", "total_sales"]);
  });
});

// ===========================================================================
// LIMIT
// ===========================================================================

describe("execute — LIMIT", () => {
  it("passes limit through", async () => {
    const { wrapped, queries } = captureSql();
    await execute(
      ast("COMPUTE total_sales OVER 2026 LIMIT 5"),
      wrapped,
      mockDatabase()
    );
    assert.equal(queries[0].limit, 5);
  });
});

// ===========================================================================
// End-to-end shape
// ===========================================================================

describe("execute — result shape", () => {
  it("returns statement, semanticQuery, sql, and results", async () => {
    const sl = retailSalesMock();
    const db = mockDatabase({
      columns: ["region", "total_sales"],
      rows: [
        ["northeast", 100],
        ["west", 200],
      ],
    });
    const result = await execute(
      ast("COMPUTE total_sales OVER 2026 GROUP BY region"),
      sl,
      db
    );
    assert.equal(result.statement, "compute");
    assert.equal(result.semanticQuery.metric, "total_sales");
    assert.match(result.sql, /mock SQL for total_sales/);
    assert.equal(result.results.rows.length, 2);
  });

  it("calls the database with the SQL the semantic layer produced", async () => {
    const sl = {
      ...retailSalesMock(),
      toSQL: () => "SELECT * FROM orders -- example",
    };
    const db = mockDatabase();
    await execute(
      ast("COMPUTE total_sales OVER 2026"),
      sl,
      db
    );
    assert.equal(db.executed.length, 1);
    assert.equal(db.executed[0], "SELECT * FROM orders -- example");
  });
});
