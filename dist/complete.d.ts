import type { SemanticLayerAdapter, LexiconAdapter, CompletionResult } from "./adapters.js";
export interface CompleteOpts {
    semanticLayer: SemanticLayerAdapter;
    lexicon?: LexiconAdapter;
}
export declare function complete(source: string, position: number, opts: CompleteOpts): Promise<CompletionResult>;
