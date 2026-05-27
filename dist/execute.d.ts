import type { Statement } from "./ast.js";
import type { SemanticLayerAdapter, DatabaseAdapter, LexiconAdapter, LexiconEntry, LexiconMatch, SemanticQuery, QueryResult, DimensionInfo, ResolvedRegion, RowDecoration, HistoricalNote } from "./adapters.js";
export interface ExecuteOpts {
    semanticLayer: SemanticLayerAdapter;
    database: DatabaseAdapter;
    lexicon?: LexiconAdapter;
}
export type ExecuteResult = ComputeResult | RegisterResult | CheckResult | ShowLexiconResult | ShowSchemaResult | UnregisterResult;
export interface ComputeResult {
    statement: "compute";
    semanticQuery: SemanticQuery;
    sql: string;
    results: QueryResult;
    reconciliation: LexiconMatch[];
    region: ResolvedRegion;
    decorations: RowDecoration[];
    historicalNotes: HistoricalNote[];
}
export interface RegisterResult {
    statement: "register";
    entry: LexiconEntry;
}
export interface CheckResult {
    statement: "check";
    matches: LexiconMatch[];
}
export interface ShowLexiconResult {
    statement: "show";
    subject: "lexicon";
    entries: LexiconEntry[];
    filter?: string;
}
export interface ShowSchemaResult {
    statement: "show";
    subject: "schema";
    metrics: MetricSummary[];
}
export interface MetricSummary {
    name: string;
    description?: string;
    primaryTime: string | null;
    dimensions: DimensionInfo[];
}
export interface UnregisterResult {
    statement: "unregister";
    name: string;
    found: boolean;
}
export declare function execute(stmt: Statement, opts: ExecuteOpts): Promise<ExecuteResult>;
