// Executor: validated AST × adapters → ExecuteResult.
//
// Translates the True Speech AST into the semantic-layer's SemanticQuery,
// hands it to the adapter to get SQL, executes the SQL via the database
// adapter, and returns a structured result that exposes every step of
// the pipeline. The demo cascade visualizer relies on having all four
// (your statement, the semantic query, the SQL, the rows) in the result.
//
// Bare-grain GROUP BY ("month") is sugar for the metric's primary time
// at that grain. The OSI runtime names that result column after the
// underlying field (e.g. order_date_month). We post-process: rename
// the column back to "month" in the returned QueryResult so the user
// sees what they wrote.
import { resolveRegion, resolveConstraint, intersectRegions, firstDayOf, lastDayOf, decorationsFor, buildRowRegion, crossesBoundary, } from "./region.js";
export async function execute(stmt, opts) {
    switch (stmt.kind) {
        case "compute":
            return executeCompute(stmt, opts);
        case "register":
            return executeRegister(stmt, opts);
        case "check":
            return executeCheck(stmt, opts);
    }
}
async function executeCompute(stmt, opts) {
    const { semanticLayer, database, lexicon } = opts;
    const metric = stmt.metrics[0];
    const primaryTime = semanticLayer.primaryTimeForMetric(metric.name);
    // We require a primary time when there's any time clause that needs to
    // bind to one. Validation should already have flagged this, but guard
    // here too — execution shouldn't crash on null.
    const needsPrimary = stmt.over.primaryTime.kind !== "all-time" ||
        (stmt.groupBy?.some((g) => g.kind === "bare-grain") ?? false);
    if (needsPrimary && !primaryTime) {
        throw new Error(`Cannot execute COMPUTE on metric "${metric.name}": no primary time dimension`);
    }
    // 1. Build WHERE clauses from the OVER clause
    const whereClauses = [];
    if (primaryTime) {
        whereClauses.push(...timeRegionToWhere(stmt.over.primaryTime, primaryTime.name));
    }
    for (const c of stmt.over.constraints) {
        whereClauses.push(...constraintToWhere(c));
    }
    // 2. Build GROUP BY (translate bare-grain to primary time + grain)
    // and a rename map for the result columns afterwards.
    const renameMap = new Map();
    const groupBy = [];
    if (stmt.groupBy && primaryTime) {
        for (const g of stmt.groupBy) {
            if (g.kind === "bare-grain") {
                groupBy.push({ dimension: primaryTime.name, grain: g.grain });
                renameMap.set(`${primaryTime.name}_${g.grain}`, g.grain);
            }
            else if (g.kind === "dimension") {
                groupBy.push({ dimension: g.dimension.name });
            }
            else {
                groupBy.push({ dimension: g.dimension.name, grain: g.grain });
            }
        }
    }
    else if (stmt.groupBy) {
        // No primary time: bare-grain caught by validation; pass others through.
        for (const g of stmt.groupBy) {
            if (g.kind === "dimension") {
                groupBy.push({ dimension: g.dimension.name });
            }
            else if (g.kind === "time-dimension") {
                groupBy.push({ dimension: g.dimension.name, grain: g.grain });
            }
        }
    }
    // 3. Build ORDER BY, mapping any user-facing names through the rename map.
    const orderBy = [];
    if (stmt.orderBy) {
        const reverseMap = new Map();
        for (const [osi, user] of renameMap)
            reverseMap.set(user, osi);
        for (const o of stmt.orderBy) {
            const fieldName = reverseMap.get(o.field.name) ?? o.field.name;
            orderBy.push({ field: fieldName, direction: o.direction });
        }
    }
    const semanticQuery = {
        metric: metric.name,
        where: whereClauses.length > 0 ? whereClauses : undefined,
        groupBy: groupBy.length > 0 ? groupBy : undefined,
        orderBy: orderBy.length > 0 ? orderBy : undefined,
        limit: stmt.limit?.value,
    };
    // 4. Generate SQL and execute
    const sql = semanticLayer.toSQL(semanticQuery);
    const rawResults = await database.execute(sql);
    // 5. Apply the rename map to column headers
    const results = applyRename(rawResults, renameMap);
    // 6. Resolve the OVER region once — used both for reconciliation and
    // for the consumer-facing ComputeResult.region field.
    const region = resolveRegion(stmt.over, primaryTime?.name ?? "");
    // 7. Reconciliation against the lexicon (no-op if no lexicon configured).
    const reconciliation = lexicon
        ? await reconcile(metric.name, region, lexicon)
        : [];
    // 8. Per-row decorations: for each result row, which reconciliation
    //    matches actually apply to that row's slice of the data.
    const decorations = decorationsFor(results.rows, reconciliation, semanticQuery.groupBy ?? [], region);
    // 9. Historical-note detection: boundaries that the query falls
    //    entirely behind (queryEnd < boundary.at). The values aren't
    //    flagged — they're internally consistent under the pre-cut regime
    //    — but the operator should be told they're reading history.
    const historicalNotes = lexicon
        ? await computeHistoricalNotes(metric.name, region, lexicon)
        : [];
    return {
        statement: "compute",
        semanticQuery,
        sql,
        results,
        reconciliation,
        region,
        decorations,
        historicalNotes,
    };
}
// ===== REGISTER =====
async function executeRegister(stmt, opts) {
    const { semanticLayer, lexicon } = opts;
    if (!lexicon) {
        throw new Error("REGISTER requires a lexicon adapter; none was configured");
    }
    if (stmt.entryKind === "region") {
        // Expand multi-metric IMPACTING shorthand into one Impact per metric,
        // resolving each region against the metric's primary time field.
        const impacts = [];
        for (const clause of stmt.impactClauses) {
            for (const metricRef of clause.metrics) {
                const primaryTime = semanticLayer.primaryTimeForMetric(metricRef.name);
                if (!primaryTime) {
                    // Should have been caught by validate(); guard so the runtime
                    // never silently produces an entry that can never match.
                    throw new Error(`Cannot register: metric "${metricRef.name}" has no primary time`);
                }
                const region = resolveRegion(clause.over, primaryTime.name);
                impacts.push({ metric: metricRef.name, region });
            }
        }
        const entry = {
            kind: "region",
            name: stmt.name.name,
            impacts,
            description: stmt.description.value,
        };
        await lexicon.add(entry);
        return { statement: "register", entry };
    }
    // entryKind === "boundary"
    const at = firstDayOf(stmt.at);
    const constraints = stmt.constraints.map(resolveConstraint);
    const metrics = stmt.metrics.map((m) => m.name);
    const entry = {
        kind: "boundary",
        name: stmt.name.name,
        at,
        constraints,
        metrics,
        before: {
            label: stmt.before.label.value,
            description: stmt.before.description.value,
        },
        after: {
            label: stmt.after.label.value,
            description: stmt.after.description.value,
        },
        changeDescription: stmt.changeDescription?.value,
    };
    await lexicon.add(entry);
    return { statement: "register", entry };
}
// ===== CHECK =====
async function executeCheck(stmt, opts) {
    const { semanticLayer, lexicon } = opts;
    if (!lexicon) {
        throw new Error("CHECK requires a lexicon adapter; none was configured");
    }
    const entries = await lexicon.list();
    const matches = [];
    for (const metricRef of stmt.metrics) {
        const primaryTime = semanticLayer.primaryTimeForMetric(metricRef.name);
        if (!primaryTime)
            continue; // validation should have flagged
        const queryRegion = resolveRegion(stmt.over, primaryTime.name);
        // Treat the queryRegion as a single virtual row for boundary
        // crossing; works because buildRowRegion with no group-bys returns
        // the queryRegion's bounds + its equality constraints as dimValues.
        const virtualRow = buildRowRegion([], [], queryRegion);
        for (const entry of entries) {
            if (entry.kind === "region") {
                for (const impact of entry.impacts) {
                    if (impact.metric !== metricRef.name)
                        continue;
                    const overlap = intersectRegions(queryRegion, impact.region);
                    if (!overlap)
                        continue;
                    matches.push({ kind: "region", entry, impact, overlap });
                }
            }
            else {
                // boundary
                if (!entry.metrics.includes(metricRef.name))
                    continue;
                if (!crossesBoundary(virtualRow, entry))
                    continue;
                matches.push({
                    kind: "boundary",
                    entry,
                    metric: metricRef.name,
                    crossedAt: entry.at,
                    side: "straddles",
                });
            }
        }
    }
    return { statement: "check", matches };
}
// ===== Historical-note detection (used by COMPUTE) =====
//
// For each boundary impacting the metric where the query falls entirely
// behind the cut, emit a historical note. The values themselves are
// internally consistent (one pre-cut regime), so no row-level flag, but
// the operator is reading history and should be told what "now" looks
// like compared to what they're seeing.
async function computeHistoricalNotes(metric, queryRegion, lexicon) {
    const entries = await lexicon.list();
    const notes = [];
    // Virtual row for the scope check — picks up the query's equality
    // constraints as dim values.
    const virtualRow = buildRowRegion([], [], queryRegion);
    for (const entry of entries) {
        if (entry.kind !== "boundary")
            continue;
        if (!entry.metrics.includes(metric))
            continue;
        // Entirely pre-cut: the latest day the query touches is before the cut.
        if (!(queryRegion.timeEnd < entry.at))
            continue;
        // Categorical scope: if the query pins a dim incompatibly with the
        // boundary's scope, the boundary doesn't apply.
        if (!isBoundaryScopeCompatible(virtualRow, entry))
            continue;
        notes.push({ boundary: entry, metric });
    }
    return notes;
}
function isBoundaryScopeCompatible(row, boundary) {
    for (const c of boundary.constraints) {
        const rowVal = row.dimValues[c.dimension];
        if (rowVal === undefined)
            continue;
        if (!constraintAllowsValueLocal(c, rowVal))
            return false;
    }
    return true;
}
// Local copy of constraint-value compatibility (avoids exporting the
// helper from region.ts purely for one call site).
function constraintAllowsValueLocal(c, val) {
    switch (c.operator) {
        case "=":
            return val === c.value;
        case "!=":
            return val !== c.value;
        case ">":
            return val > c.value;
        case "<":
            return val < c.value;
        case ">=":
            return val >= c.value;
        case "<=":
            return val <= c.value;
        case "in":
            return Array.isArray(c.value) && c.value.includes(val);
        case "not_in":
            return Array.isArray(c.value) && !c.value.includes(val);
    }
}
// ===== Reconciliation (used by COMPUTE) =====
async function reconcile(metric, queryRegion, lexicon) {
    const entries = await lexicon.list();
    const matches = [];
    // Same virtual-row trick as executeCheck — lets us reuse crossesBoundary
    // for query-level boundary matching without a parallel implementation.
    const virtualRow = buildRowRegion([], [], queryRegion);
    for (const entry of entries) {
        if (entry.kind === "region") {
            for (const impact of entry.impacts) {
                if (impact.metric !== metric)
                    continue;
                const overlap = intersectRegions(queryRegion, impact.region);
                if (!overlap)
                    continue;
                matches.push({ kind: "region", entry, impact, overlap });
            }
        }
        else {
            // boundary
            if (!entry.metrics.includes(metric))
                continue;
            if (!crossesBoundary(virtualRow, entry))
                continue;
            matches.push({
                kind: "boundary",
                entry,
                metric,
                crossedAt: entry.at,
                side: "straddles",
            });
        }
    }
    return matches;
}
// ===== Time region → WHERE clauses =====
function timeRegionToWhere(region, dimension) {
    switch (region.kind) {
        case "all-time":
            return [];
        case "calendar":
            return inclusiveInterval(region.literal, dimension);
        case "range":
            return [
                { dimension, operator: ">=", value: firstDayOf(region.start) },
                { dimension, operator: "<=", value: lastDayOf(region.end) },
            ];
        case "until":
            return [
                { dimension, operator: "<=", value: lastDayOf(region.bound) },
            ];
        case "since":
            return [
                { dimension, operator: ">=", value: firstDayOf(region.bound) },
            ];
    }
}
function inclusiveInterval(lit, dimension) {
    return [
        { dimension, operator: ">=", value: firstDayOf(lit) },
        { dimension, operator: "<=", value: lastDayOf(lit) },
    ];
}
// ===== Constraint → WHERE clauses =====
function constraintToWhere(c) {
    const dim = c.dimension.name;
    const pred = c.predicate;
    switch (pred.kind) {
        case "comparison": {
            const value = pred.value.kind === "string"
                ? pred.value.value
                : pred.value.kind === "number"
                    ? pred.value.value
                    : firstDayOf(pred.value.literal); // for time-literal compare we use the first instant
            return [{ dimension: dim, operator: pred.operator, value }];
        }
        case "in-set": {
            const values = pred.values.map((v) => v.kind === "string" ? v.value : v.kind === "number" ? v.value : firstDayOf(v.literal));
            return [{ dimension: dim, operator: "in", value: values }];
        }
        case "not-in-set": {
            const values = pred.values.map((v) => v.kind === "string" ? v.value : v.kind === "number" ? v.value : firstDayOf(v.literal));
            return [{ dimension: dim, operator: "not_in", value: values }];
        }
        case "in-time-region": {
            const r = pred.region;
            if (r.kind === "calendar")
                return inclusiveInterval(r.literal, dim);
            return [
                { dimension: dim, operator: ">=", value: firstDayOf(r.start) },
                { dimension: dim, operator: "<=", value: lastDayOf(r.end) },
            ];
        }
    }
}
// ===== Rename =====
function applyRename(result, renameMap) {
    if (renameMap.size === 0)
        return result;
    const columns = result.columns.map((c) => renameMap.get(c) ?? c);
    return { columns, rows: result.rows };
}
