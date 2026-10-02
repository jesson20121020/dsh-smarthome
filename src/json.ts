/**
 * Structural JSON value type.
 *
 * Harness 0.1.x re-exported this from `@deepseek-ai/dsh-tools`. In 0.2.0 it
 * moved to the internal `@deepseek-ai/dsh-util-values` package, which plugins
 * are not expected to depend on directly. The tools half only ever uses it as
 * a cast target for JSON-serializable payloads, so the shape is declared
 * locally — it is the same lossless-JSON union the harness validates with
 * `isJsonValue`.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
