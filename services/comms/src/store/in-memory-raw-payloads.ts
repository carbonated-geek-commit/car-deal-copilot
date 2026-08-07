/**
 * In-memory raw payload store (design T-009 §3.3). Seam: S3-compatible
 * object store — `stash` returns what becomes the S3 object key.
 *
 * D2: the ref is the sha-256 hex of the canonical JSON serialization of the
 * raw payload (`node:crypto` — a Node builtin, not a dependency). Determinism
 * is the point: provider redelivery of the same unparseable payload produces
 * the same ref, so the quarantine idempotency key
 * (`source + ':quarantine:' + ref`) dedupes exactly like a parsed redelivery.
 *
 * The payload itself NEVER rides the bus or the logs — only the ref does
 * (core CommsInboundQuarantinedV1 contract).
 */

import { createHash } from 'node:crypto';
import type { RawPayloadStore } from '../ports.js';

/**
 * Canonical JSON: recursively key-sorted, so two structurally-equal payloads
 * serialize identically regardless of property insertion order. Non-JSON
 * values degrade deterministically (never throw — a hostile payload must
 * still quarantine).
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return JSON.stringify(value) ?? 'null'; // NaN/Infinity → "null" via JSON semantics
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = obj[k];
        if (v === undefined) continue; // JSON.stringify object semantics
        parts.push(JSON.stringify(k) + ':' + canonicalJson(v));
      }
      return '{' + parts.join(',') + '}';
    }
    default:
      // undefined / function / symbol / bigint — deterministic fallback.
      return JSON.stringify(String(value));
  }
};

export class InMemoryRawPayloadStore implements RawPayloadStore {
  private readonly payloads = new Map<string, unknown>();

  stash(raw_payload: unknown): string {
    const ref = createHash('sha256').update(canonicalJson(raw_payload)).digest('hex');
    if (!this.payloads.has(ref)) {
      this.payloads.set(ref, raw_payload);
    }
    return ref;
  }

  get(ref: string): unknown | undefined {
    return this.payloads.get(ref);
  }
}
