// Deterministic hashing and canonical serialization for audit checksums.

import { sha256Sync } from './sha256.js';

export { sha256Sync };

export function fnv1a(input) {
  const text = typeof input === 'string' ? input : canonicalStringify(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function stableSortValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.toJSON === 'function') {
    const json = value.toJSON();
    return stableSortValue(json);
  }
  if (Array.isArray(value)) return value.map(stableSortValue);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v === undefined || typeof v === 'function') continue;
    out[key] = stableSortValue(v);
  }
  return out;
}

export function canonicalStringify(value) {
  return JSON.stringify(stableSortValue(value));
}

export async function sha256Hex(value) {
  const text = typeof value === 'string' ? value : canonicalStringify(value);
  return sha256Sync(text);
}

export function shortChecksum(hex, length = 12) {
  return typeof hex === 'string' ? hex.slice(0, length) : '';
}
