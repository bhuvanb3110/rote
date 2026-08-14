// LLM-driven discovery loop: figures out how to do a UI task once, compiling the result into a
// Capability artifact. See discover.ts for the loop, tools.ts for the tool schema, compile.ts
// for transcript-to-artifact compilation.
export * from "./types.js";
export * from "./goals.js";
export * from "./fieldHints.js";
export * from "./tools.js";
export * from "./compile.js";
export * from "./discover.js";
