/**
 * Assert a value round-trips through JSON without silent corruption.
 *
 * `JSON.stringify` is not enough: it silently turns Dates into strings, Maps/Sets
 * into `{}`, drops functions/undefined, and writes `null` for NaN/Infinity. A flow
 * store that contains any of these works in memory but resurrects wrong (or empty)
 * after a durable restart. This walk rejects them up front with a path-pointed error.
 */
export function assertJsonSafe(value: unknown, path = "value"): void {
  walk(value, path, new Set());
}

function walk(value: unknown, path: string, seen: Set<object>): void {
  if (value === null) return;
  const t = typeof value;
  if (t === "string" || t === "boolean") return;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new TypeError(
        `${path} is ${String(value)}, which is not JSON-serializable (becomes null on restart)`,
      );
    }
    return;
  }
  if (t === "undefined" || t === "bigint" || t === "function" || t === "symbol") {
    throw new TypeError(`${path} is a ${t}, which is not JSON-serializable`);
  }
  if (t === "object") {
    const obj = value as object;
    if (seen.has(obj)) {
      throw new TypeError(`${path} is a circular reference, which is not JSON-serializable`);
    }
    seen.add(obj);
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) walk(obj[i], `${path}[${i}]`, seen);
      seen.delete(obj);
      return;
    }
    const proto = Object.getPrototypeOf(obj) as object | null;
    if (proto !== null && proto !== Object.prototype) {
      const name = (obj as { constructor?: { name?: string } }).constructor?.name ?? "object";
      throw new TypeError(
        `${path} is a ${name} instance, which is not JSON-serializable (use a plain object/array)`,
      );
    }
    for (const [key, v] of Object.entries(obj)) {
      // undefined object values are dropped by JSON (harmless for optional keys) — skip them
      if (v === undefined) continue;
      walk(v, `${path}.${key}`, seen);
    }
    seen.delete(obj);
    return;
  }
}
