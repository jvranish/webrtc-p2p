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
 * @param {unknown} obj
 * @returns {string}
 */
export function encodeToken(obj) {
  return btoa(JSON.stringify(obj));
}

/**
 * @param {string} encoded
 * @returns {unknown}
 */
export function decodeToken(encoded) {
  if (!encoded || !encoded.trim()) {
    throw new Error('Invalid token: empty or whitespace-only');
  }
  try {
    const decoded = atob(encoded.trim());
    if (!decoded) {
      throw new Error('Invalid token: decodes to empty string');
    }
    return JSON.parse(decoded);
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
