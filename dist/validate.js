// Validator: AST × SemanticLayerAdapter → TrueSpeechError[].
//
// Catches everything the parser couldn't, given that the parser doesn't
// know about the semantic model: unknown metrics, dimensions that don't
// exist on the metric's dataset, time literals with bad values, ranges
// that go backward, GROUP BY references that don't fit, ORDER BY fields
// that aren't in the result, and so on.
//
// Always returns the full list of errors it found — never bails after
// the first. The editor surfaces them as squigglies; execute() stops
// before running anything if the list is non-empty.
import { makeError } from "./errors.js";
import { daysInMonth, pad2 } from "./region.js";
export function validate(ast, adapter) {
    const errors = [];
    if (ast.kind === "compute") {
        validateCompute(ast, adapter, errors);
    }
    else if (ast.kind === "register") {
        validateRegister(ast, adapter, errors);
    }
    else if (ast.kind === "check") {
        validateCheck(ast, adapter, errors);
    }
    return errors;
}
function validateCompute(stmt, adapter, errors) {
    if (stmt.metrics.length === 0)
        return;
    if (stmt.metrics.length > 1) {
        // Phase 1 limitation. Lift when multi-metric merging lands.
        errors.push(makeError({
            code: "incompatible_metrics",
            message: "Multi-metric COMPUTE is not supported in this version",
            span: stmt.metrics[1].span,
            help: "Run a separate COMPUTE statement for each metric for now",
        }));
        // Don't proceed — the rest of validation assumes a single metric.
        return;
    }
    const metricRef = stmt.metrics[0];
    const allMetrics = adapter.listMetrics();
    const metric = allMetrics.find((m) => m.name === metricRef.name);
    if (!metric) {
        errors.push(makeError({
            code: "unknown_metric",
            message: `Unknown metric "${metricRef.name}"`,
            span: metricRef.span,
            help: allMetrics.length > 0
                ? `Available metrics: ${allMetrics.map((m) => m.name).join(", ")}`
                : "No metrics are defined in the semantic model",
        }));
        return;
    }
    const dimensions = adapter.dimensionsForMetric(metric.name);
    const primaryTime = adapter.primaryTimeForMetric(metric.name);
    validateOverClause(stmt.over, primaryTime, dimensions, errors);
    if (stmt.groupBy) {
        validateGroupBy(stmt.groupBy, primaryTime, dimensions, errors);
    }
    if (stmt.orderBy) {
        validateOrderBy(stmt, errors);
    }
}
// ===== REGISTER =====
function validateRegister(stmt, adapter, errors) {
    const allMetrics = adapter.listMetrics();
    for (const clause of stmt.impactClauses) {
        if (clause.metrics.length === 0)
            continue;
        // Validate each metric exists and gather (metric, dims, primaryTime)
        // tuples. Skip OVER validation for metrics we couldn't resolve.
        const resolved = [];
        for (const metricRef of clause.metrics) {
            if (!allMetrics.find((m) => m.name === metricRef.name)) {
                errors.push(makeError({
                    code: "unknown_metric",
                    message: `Unknown metric "${metricRef.name}"`,
                    span: metricRef.span,
                    help: allMetrics.length > 0
                        ? `Available metrics: ${allMetrics.map((m) => m.name).join(", ")}`
                        : undefined,
                }));
                continue;
            }
            const dims = adapter.dimensionsForMetric(metricRef.name);
            const primaryTime = adapter.primaryTimeForMetric(metricRef.name);
            if (!primaryTime) {
                errors.push(makeError({
                    code: "missing_primary_time",
                    message: `Cannot impact metric "${metricRef.name}" — no primary time dimension declared`,
                    span: metricRef.span,
                    help: "Mark a time field on the metric's dataset as is_primary: true",
                }));
                continue;
            }
            resolved.push({ ref: metricRef, dims, primaryTime });
        }
        if (resolved.length === 0)
            continue;
        // Multi-metric IMPACTING shorthand requires shared primary time.
        if (resolved.length > 1) {
            const firstPrimary = resolved[0].primaryTime.name;
            for (let i = 1; i < resolved.length; i++) {
                if (resolved[i].primaryTime.name !== firstPrimary) {
                    errors.push(makeError({
                        code: "incompatible_metrics",
                        message: `Metric "${resolved[i].ref.name}" has primary time "${resolved[i].primaryTime.name}", but "${resolved[0].ref.name}" uses "${firstPrimary}"`,
                        span: resolved[i].ref.span,
                        help: "Multi-metric IMPACTING shorthand requires all metrics to share a primary time. Split into separate IMPACTING clauses.",
                    }));
                }
            }
        }
        // Validate the OVER clause once per resolved metric so that
        // dimension-existence checks fire against each metric's dataset.
        for (const { primaryTime, dims } of resolved) {
            validateOverClause(clause.over, primaryTime, dims, errors);
        }
    }
}
// ===== CHECK =====
function validateCheck(stmt, adapter, errors) {
    if (stmt.metrics.length === 0)
        return;
    const allMetrics = adapter.listMetrics();
    const resolved = [];
    for (const metricRef of stmt.metrics) {
        if (!allMetrics.find((m) => m.name === metricRef.name)) {
            errors.push(makeError({
                code: "unknown_metric",
                message: `Unknown metric "${metricRef.name}"`,
                span: metricRef.span,
                help: allMetrics.length > 0
                    ? `Available metrics: ${allMetrics.map((m) => m.name).join(", ")}`
                    : undefined,
            }));
            continue;
        }
        const dims = adapter.dimensionsForMetric(metricRef.name);
        const primaryTime = adapter.primaryTimeForMetric(metricRef.name);
        if (!primaryTime) {
            errors.push(makeError({
                code: "missing_primary_time",
                message: `Metric "${metricRef.name}" has no primary time dimension`,
                span: metricRef.span,
            }));
            continue;
        }
        resolved.push({ ref: metricRef, dims, primaryTime });
    }
    if (resolved.length === 0)
        return;
    if (resolved.length > 1) {
        const firstPrimary = resolved[0].primaryTime.name;
        for (let i = 1; i < resolved.length; i++) {
            if (resolved[i].primaryTime.name !== firstPrimary) {
                errors.push(makeError({
                    code: "incompatible_metrics",
                    message: `Metric "${resolved[i].ref.name}" has primary time "${resolved[i].primaryTime.name}", but "${resolved[0].ref.name}" uses "${firstPrimary}"`,
                    span: resolved[i].ref.span,
                    help: "Multi-metric CHECK requires all metrics to share a primary time.",
                }));
            }
        }
    }
    for (const { primaryTime, dims } of resolved) {
        validateOverClause(stmt.over, primaryTime, dims, errors);
    }
}
// ===== OVER =====
function validateOverClause(over, primaryTime, dimensions, errors) {
    validateTimeRegion(over.primaryTime, primaryTime, errors);
    for (const c of over.constraints) {
        validateConstraint(c, dimensions, errors);
    }
}
function validateTimeRegion(region, primaryTime, errors) {
    // Whatever shape — we need a primary time on the metric to bind to.
    if (!primaryTime) {
        errors.push(makeError({
            code: "missing_primary_time",
            message: "This metric has no primary time dimension declared in the semantic model",
            span: region.span,
            help: "Mark a time field on the metric's dataset as is_primary: true",
        }));
        // Don't return — we can still flag literal-level issues.
    }
    switch (region.kind) {
        case "all-time":
            return;
        case "calendar":
            validateLiteral(region.literal, errors);
            return;
        case "range":
            validateLiteral(region.start, errors);
            validateLiteral(region.end, errors);
            validateRange(region, errors);
            return;
        case "until":
        case "since":
            validateLiteral(region.bound, errors);
            return;
    }
}
function validateLiteral(lit, errors) {
    if (lit.unit === "quarter" && lit.quarter !== undefined) {
        if (lit.quarter < 1 || lit.quarter > 4) {
            errors.push(makeError({
                code: "malformed_time_literal",
                message: `Quarter must be 1-4, got Q${lit.quarter}`,
                span: lit.span,
            }));
        }
    }
    if ((lit.unit === "month" || lit.unit === "day") &&
        lit.month !== undefined) {
        if (lit.month < 1 || lit.month > 12) {
            errors.push(makeError({
                code: "malformed_time_literal",
                message: `Month must be 1-12, got ${lit.month}`,
                span: lit.span,
            }));
        }
    }
    if (lit.unit === "day" &&
        lit.day !== undefined &&
        lit.month !== undefined &&
        lit.month >= 1 &&
        lit.month <= 12) {
        const maxDay = daysInMonth(lit.year, lit.month);
        if (lit.day < 1 || lit.day > maxDay) {
            errors.push(makeError({
                code: "malformed_time_literal",
                message: `Day must be 1-${maxDay} for ${lit.year}-${pad2(lit.month)}, got ${lit.day}`,
                span: lit.span,
            }));
        }
    }
}
function validateRange(range, errors) {
    if (range.start.unit !== range.end.unit) {
        errors.push(makeError({
            code: "mixed_unit_range",
            message: `Range endpoints must be the same unit, got ${range.start.unit} and ${range.end.unit}`,
            span: range.span,
            help: "Both ends of a range must be a year, a quarter, a month, or a day",
        }));
        return; // can't compare across units anyway
    }
    if (compareLiteral(range.start, range.end) > 0) {
        errors.push(makeError({
            code: "range_start_after_end",
            message: `Range start "${range.start.text}" comes after end "${range.end.text}"`,
            span: range.span,
        }));
    }
}
// ===== Constraints =====
function validateConstraint(c, dimensions, errors) {
    const dim = dimensions.find((d) => d.name === c.dimension.name);
    if (!dim) {
        errors.push(makeError({
            code: "unknown_dimension",
            message: `Unknown dimension "${c.dimension.name}"`,
            span: c.dimension.span,
            help: dimensions.length > 0
                ? `Available dimensions: ${dimensions.map((d) => d.name).join(", ")}`
                : undefined,
        }));
        return;
    }
    const pred = c.predicate;
    if (pred.kind === "in-time-region") {
        if (!dim.isTime) {
            errors.push(makeError({
                code: "unknown_dimension",
                message: `IN <time region> requires a time dimension; "${dim.name}" is categorical`,
                span: pred.span,
            }));
            return;
        }
        if (pred.region.kind === "calendar") {
            validateLiteral(pred.region.literal, errors);
        }
        else {
            validateLiteral(pred.region.start, errors);
            validateLiteral(pred.region.end, errors);
            validateRange(pred.region, errors);
        }
    }
    else if (pred.kind === "comparison") {
        if (pred.value.kind === "time-literal") {
            validateLiteral(pred.value.literal, errors);
            if (!dim.isTime) {
                errors.push(makeError({
                    code: "unknown_dimension",
                    message: `Cannot compare categorical dimension "${dim.name}" against a time literal`,
                    span: pred.value.span,
                }));
            }
        }
    }
}
// ===== GROUP BY =====
function validateGroupBy(groupBy, primaryTime, dimensions, errors) {
    for (const g of groupBy) {
        if (g.kind === "bare-grain") {
            if (!primaryTime) {
                errors.push(makeError({
                    code: "missing_primary_time",
                    message: `Cannot use bare grain "${g.grain}" — this metric has no primary time dimension`,
                    span: g.span,
                    help: "Use an explicit time-dimension form like 'order_date:day'",
                }));
            }
            continue;
        }
        if (g.kind === "dimension") {
            const dim = dimensions.find((d) => d.name === g.dimension.name);
            if (!dim) {
                errors.push(makeError({
                    code: "unknown_dimension",
                    message: `Unknown dimension "${g.dimension.name}"`,
                    span: g.dimension.span,
                    help: dimensions.length > 0
                        ? `Available dimensions: ${dimensions.map((d) => d.name).join(", ")}`
                        : undefined,
                }));
                continue;
            }
            if (dim.isTime) {
                errors.push(makeError({
                    code: "grain_required",
                    message: `Time dimension "${dim.name}" requires a grain in GROUP BY`,
                    span: g.span,
                    help: `Write "${dim.name}:day" (or :week / :month / :quarter / :year)`,
                }));
            }
            continue;
        }
        if (g.kind === "time-dimension") {
            const dim = dimensions.find((d) => d.name === g.dimension.name);
            if (!dim) {
                errors.push(makeError({
                    code: "unknown_dimension",
                    message: `Unknown dimension "${g.dimension.name}"`,
                    span: g.dimension.span,
                }));
                continue;
            }
            if (!dim.isTime) {
                errors.push(makeError({
                    code: "grain_required",
                    message: `Cannot apply grain ":${g.grain}" to non-time dimension "${dim.name}"`,
                    span: g.span,
                }));
            }
            continue;
        }
    }
}
// ===== ORDER BY =====
function validateOrderBy(stmt, errors) {
    if (!stmt.orderBy)
        return;
    const cols = resultColumnNames(stmt);
    for (const o of stmt.orderBy) {
        if (!cols.includes(o.field.name)) {
            errors.push(makeError({
                code: "order_by_unknown_field",
                message: `ORDER BY field "${o.field.name}" is not in the result`,
                span: o.field.span,
                help: cols.length > 0
                    ? `Result columns: ${cols.join(", ")}`
                    : undefined,
            }));
        }
    }
}
export function resultColumnNames(stmt) {
    const cols = [];
    if (stmt.groupBy) {
        for (const g of stmt.groupBy) {
            if (g.kind === "bare-grain")
                cols.push(g.grain);
            else if (g.kind === "dimension")
                cols.push(g.dimension.name);
            else if (g.kind === "time-dimension")
                cols.push(`${g.dimension.name}_${g.grain}`);
        }
    }
    for (const m of stmt.metrics) {
        cols.push(m.name);
    }
    return cols;
}
// ===== Helpers =====
function compareLiteral(a, b) {
    if (a.year !== b.year)
        return a.year - b.year;
    if (a.unit === "quarter")
        return (a.quarter ?? 0) - (b.quarter ?? 0);
    if (a.unit === "month")
        return (a.month ?? 0) - (b.month ?? 0);
    if (a.unit === "day") {
        const dm = (a.month ?? 0) - (b.month ?? 0);
        if (dm !== 0)
            return dm;
        return (a.day ?? 0) - (b.day ?? 0);
    }
    return 0;
}
