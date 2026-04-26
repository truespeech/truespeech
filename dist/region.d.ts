import type { OverClause } from "./ast.js";
import type { ResolvedRegion } from "./adapters.js";
export declare function resolveRegion(over: OverClause, primaryTimeField: string | null): ResolvedRegion;
export declare function intersectRegions(a: ResolvedRegion, b: ResolvedRegion): ResolvedRegion | null;
export declare function renderTimeRegion(start: string, end: string): string;
export declare function renderRegion(region: ResolvedRegion): string;
