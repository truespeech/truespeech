export interface Span {
    start: number;
    end: number;
}
export interface Position {
    offset: number;
    line: number;
    column: number;
}
export declare function span(start: number, end: number): Span;
export declare function spanFrom(first: Span, last: Span): Span;
export declare function positionAt(source: string, offset: number): Position;
