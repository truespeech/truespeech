import type { ComputeStatement } from "./ast.js";
import type { SemanticLayerAdapter, DatabaseAdapter, SemanticQuery, QueryResult } from "./adapters.js";
export interface ExecuteResult {
    statement: "compute";
    semanticQuery: SemanticQuery;
    sql: string;
    results: QueryResult;
}
export declare function execute(stmt: ComputeStatement, semanticLayer: SemanticLayerAdapter, database: DatabaseAdapter): Promise<ExecuteResult>;
