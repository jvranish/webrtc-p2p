// @ts-check

/**
 * Cast a value to a specific type with a runtime instanceof check.
 * Prefer this over JSDoc type assertions in event handlers and DOM access.
 * @template T
 * @param {new (...args: never[]) => T} Type
 * @param {unknown} value
 * @returns {T}
 */
export function cast(Type, value) {
  if (!(value instanceof Type)) {
    const got = value == null ? String(value) : Object.getPrototypeOf(value)?.constructor?.name ?? typeof value;
    throw new TypeError(`Expected ${Type.name}, got ${got}`);
  }
  return value;
}

/**
 * Encode an object as a URL-safe base64 token.
 * UTF-8 encodes first (btoa alone throws on chars > U+00FF, e.g. non-Latin names),
 * then uses the base64url alphabet so the token survives URL fragments unmangled.
 * @param {unknown} obj
 * @returns {string}
 */
export function encodeToken(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * Decode a token produced by encodeToken. Accepts both base64url and
 * standard base64 (with or without padding).
 * @param {string} encoded
 * @returns {unknown}
 */
export function decodeToken(encoded) {
  if (!encoded || !encoded.trim()) {
    throw new Error('Invalid token: empty or whitespace-only');
  }
  try {
    let b64 = encoded.trim().replaceAll('-', '+').replaceAll('_', '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(b64);
    if (!bin) {
      throw new Error('Invalid token: decodes to empty string');
    }
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    if (err instanceof Error && err.message.includes('Invalid token')) {
      throw err;
    }
    throw new Error('Invalid token: unable to decode');
  }
}

/**
 * Extract a base64 token from either a raw base64 string or a URL fragment
 * like `https://example.com/#offer=BASE64` or `#offer=BASE64`.
 * @param {string} input
 * @returns {string} raw base64 token
 */
export function extractToken(input) {
  const trimmed = input.trim();
  const hashIdx = trimmed.indexOf('#');
  const fragment = hashIdx === -1 ? trimmed : trimmed.slice(hashIdx + 1);
  const eqIdx = fragment.indexOf('=');
  return eqIdx === -1 ? fragment : fragment.slice(eqIdx + 1);
}
