import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const canonicalize: (value: unknown) => string | undefined = createRequire(import.meta.url)('canonicalize');

/** Versioned JCS wire format; not the Python Core-v3 number encoding. */
export function canonical(value: unknown): string {
  assertJson(value);
  return canonicalize(value)!;
}
export function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function assertJson(value: unknown, active = new Set<object>()): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new Error('LONE_SURROGATE');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error('UNSAFE_NUMBER');
    return;
  }
  if (typeof value !== 'object') throw new Error('NON_JSON_PAYLOAD');
  if (active.has(value)) throw new Error('CYCLIC_PAYLOAD');
  active.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertJson(value[i], active);
  } else {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('NON_JSON_OBJECT');
    for (const [key, child] of Object.entries(value)) { assertJson(key); assertJson(child, active); }
  }
  active.delete(value);
}

export function snapshot<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
