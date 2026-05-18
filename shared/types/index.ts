/**
 * shared/types — single source of truth for runtime + eval + APK
 *
 * The YAML specs in /shared/*.yaml are loaded and validated against these
 * schemas. If validation fails the eval lab refuses to boot and the backend
 * refuses to serve. This is intentional: the spec contract is sacred.
 */

export * from "./procedure";
export * from "./taxonomy";
export * from "./hardware";
export * from "./strategy";
export * from "./events";
export * from "./run";
