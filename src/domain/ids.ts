/** Identifier helpers. */

/** Random id for user-created entities. */
export function newId(prefix = 'e'): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `${prefix}_${uuid.replace(/-/g, '').slice(0, 12)}`
}

/**
 * Counter-backed ids for solver output.
 *
 * The solver must be deterministic — the same project has to produce byte-identical
 * results so tests can assert on them and so re-solving doesn't churn the scene graph.
 */
export function makeIdFactory(prefix: string): () => string {
  let n = 0
  return () => `${prefix}_${(n++).toString(36)}`
}
