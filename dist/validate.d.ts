import type { Statement, ComputeStatement } from "./ast.js";
import type { SemanticLayerAdapter } from "./adapters.js";
import type { TrueSpeechError } from "./errors.js";
export declare function validate(ast: Statement, adapter: SemanticLayerAdapter): TrueSpeechError[];
export declare function resultColumnNames(stmt: ComputeStatement): string[];
