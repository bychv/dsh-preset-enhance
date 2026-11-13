import type { MacroBefore, SessionCompilation } from './types.mjs';

/** Keep compiled history bounded independently of durable session variables. */
export class CompilationCache {
  #rows = new Map<string, { value: SessionCompilation; bytes: number; variables: string }>();
  #bytes = 0;

  latest(sessionId: string, presetId: string | undefined): SessionCompilation | undefined {
    const row = this.#rows.get(sessionId)?.value;
    return row?.presetId === presetId ? row : undefined;
  }

  get(sessionId: string, presetId: string, key: string, variables: string): SessionCompilation | undefined {
    const row = this.#rows.get(sessionId);
    if (!row || row.value.presetId !== presetId || row.value.key !== key || row.variables !== variables) return;
    this.#rows.delete(sessionId);
    this.#rows.set(sessionId, row);
    return structuredClone(row.value);
  }

  set(sessionId: string, value: SessionCompilation, variables: string): void {
    this.delete(sessionId);
    const budget = 16 * 1024 * 1024;
    let bytes: number;
    let detached: SessionCompilation;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes > budget) return;
      // Detach from host history without changing typed attachment data.
      detached = structuredClone(value);
    } catch {
      // An unsupported host value must not prevent the prepared request from sending.
      return;
    }
    this.#rows.set(sessionId, { value: detached, bytes, variables });
    this.#bytes += bytes;
    while (this.#rows.size > 64 || this.#bytes > budget) this.delete(this.#rows.keys().next().value!);
  }

  delete(sessionId: string): void {
    const row = this.#rows.get(sessionId);
    if (row) this.#bytes -= row.bytes;
    this.#rows.delete(sessionId);
  }

  clear(): void {
    this.#rows.clear();
    this.#bytes = 0;
  }
}

/** Retain only the previous values touched by this compilation, including deletions. */
export function macroChanges(before: Record<string, string>, after: Record<string, string>): MacroBefore | undefined {
  const changes = new Map<string, string | null>();
  for (const [key, value] of Object.entries(before)) {
    if (!Object.hasOwn(after, key) || after[key] !== value) changes.set(key, value);
  }
  for (const key of Object.keys(after)) {
    if (!Object.hasOwn(before, key)) changes.set(key, null);
  }
  return changes.size ? Object.fromEntries(changes) : undefined;
}

/** Restore the inputs to a replay on a copy. Committed values are never rolled back. */
export function replayMacros(values: Record<string, string>, before?: MacroBefore): Record<string, string> {
  if (!before) return values;
  const input = Object.assign(Object.create(null) as Record<string, string>, values);
  for (const [key, value] of Object.entries(before)) {
    if (value === null) delete input[key];
    else input[key] = value;
  }
  return input;
}
