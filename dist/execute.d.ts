import type { Statement } from "./ast.js";
import type { SemanticLayerAdapter, DatabaseAdapter, LexiconAdapter, LexiconEntry, LexiconMatch, SemanticQuery, QueryResult, ResolvedRegion } from "./adapters.js";
export interface ExecuteOpts {
    semanticLayer: SemanticLayerAdapter;
    database: DatabaseAdapter;
    lexicon?: LexiconAdapter;
}
export type ExecuteResult = ComputeResult | RegisterResult | CheckResult;
export interface ComputeResult {
    statement: "compute";
    semanticQuery: SemanticQuery;
    sql: string;
    results: QueryResult;
    reconciliation: LexiconMatch[];
    region: ResolvedRegion;
}
export interface RegisterResult {
    statement: "register";
    entry: LexiconEntry;
}
export interface CheckResult {
    statement: "check";
    matches: LexiconMatch[];
}
export declare function execute(stmt: Statement, opts: ExecuteOpts): Promise<ExecuteResult>;
