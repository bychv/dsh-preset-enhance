/** Keep compiled history bounded independently of durable session variables. */
export class CompilationCache {
    #rows = new Map();
    #bytes = 0;
    latest(sessionId, presetId) {
        const row = this.#rows.get(sessionId)?.value;
        return row?.presetId === presetId ? row : undefined;
    }
    get(sessionId, presetId, key, variables) {
        const row = this.#rows.get(sessionId);
        if (!row || row.value.presetId !== presetId || row.value.key !== key || row.variables !== variables)
            return;
        this.#rows.delete(sessionId);
        this.#rows.set(sessionId, row);
        return structuredClone(row.value);
    }
    set(sessionId, value, variables) {
        this.delete(sessionId);
        const budget = 16 * 1024 * 1024;
        let bytes;
        let detached;
        try {
            bytes = Buffer.byteLength(JSON.stringify(value));
            if (bytes > budget)
                return;
            // Detach from host history without changing typed attachment data.
            detached = structuredClone(value);
        }
        catch {
            // An unsupported host value must not prevent the prepared request from sending.
            return;
        }
        this.#rows.set(sessionId, { value: detached, bytes, variables });
        this.#bytes += bytes;
        while (this.#rows.size > 64 || this.#bytes > budget)
            this.delete(this.#rows.keys().next().value);
    }
    delete(sessionId) {
        const row = this.#rows.get(sessionId);
        if (row)
            this.#bytes -= row.bytes;
        this.#rows.delete(sessionId);
    }
    clear() {
        this.#rows.clear();
        this.#bytes = 0;
    }
}
/** Retain only the previous values touched by this compilation, including deletions. */
export function macroChanges(before, after) {
    const changes = new Map();
    for (const [key, value] of Object.entries(before)) {
        if (!Object.hasOwn(after, key) || after[key] !== value)
            changes.set(key, value);
    }
    for (const key of Object.keys(after)) {
        if (!Object.hasOwn(before, key))
            changes.set(key, null);
    }
    return changes.size ? Object.fromEntries(changes) : undefined;
}
/** Restore the inputs to a replay on a copy. Committed values are never rolled back. */
export function replayMacros(values, before) {
    if (!before)
        return values;
    const input = Object.assign(Object.create(null), values);
    for (const [key, value] of Object.entries(before)) {
        if (value === null)
            delete input[key];
        else
            input[key] = value;
    }
    return input;
}
