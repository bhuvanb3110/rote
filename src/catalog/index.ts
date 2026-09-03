// Agent-facing capability catalog: discover compiled artifacts (list, with JSON-Schema-shaped
// typed contracts derived from each Capability's own inputs/outputs) and invoke them by id
// through the existing runReplay/tenant-override path. See schema.ts, registry.ts, invoke.ts,
// http.ts for the pieces.
export * from "./schema.js";
export * from "./registry.js";
export * from "./invoke.js";
export * from "./http.js";
