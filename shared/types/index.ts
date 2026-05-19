/**
 * shared/types — single source of truth for runtime + eval + APK
 *
 * The YAML specs in /shared/*.yaml are loaded and validated against these
 * schemas. If validation fails the eval lab refuses to boot and the backend
 * refuses to serve. This is intentional: the spec contract is sacred.
 */

export * from "./procedure.js";
export * from "./taxonomy.js";
export * from "./hardware.js";
export * from "./strategy.js";
export * from "./events.js";
export * from "./run.js";
