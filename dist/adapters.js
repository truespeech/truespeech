// Adapter interfaces.
//
// True Speech is decoupled from any specific semantic layer or database
// via these two adapter contracts. The runtime calls into them — never
// imports from a specific implementation — so the same runtime works
// against OSI, dbt MetricFlow, Cube, an in-memory mock, or anything
// else that can be wrapped to fit these shapes.
//
// These types deliberately mirror the OSI runtime's public shapes so the
// OsiAdapter wrapper is a near-identity. Future semantic-layer adapters
// can do more translation work as needed.
export {};
