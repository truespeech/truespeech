// Abstract syntax tree for True Speech statements.
//
// Statement is a discriminated union — phase 1 has only ComputeStatement,
// but the structure makes adding RegisterStatement / CheckStatement (and
// any future statement kinds) a matter of new variants and parsing rules,
// not restructuring.
//
// Every node carries a `span` referring back to its source range. This
// is what makes Rust-style error rendering possible — the validator can
// point precisely at the offending sub-expression.
export {};
