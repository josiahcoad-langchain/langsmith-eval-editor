// A fingerprint of what a test asks: its inputs (Given + prompt) and outputs (assertions, checks), not metadata.
// Must match server/content_hash.py byte for byte: each run records the server's, and a test whose fingerprint
// differs from its run's has changed since, so that run's results are out of date. Same canonical JSON: keys
// sorted at every level, no whitespace, non-ASCII as is, whole-number floats as integers (JavaScript already
// writes 1.0 as 1). server/tests/test_content_hash.py runs this file to prove the two agree.
// Self-contained (no imports) so that test can run it with plain Node.

type Value = unknown;

export async function contentHash(inputs: Value, outputs: Value): Promise<string> {
  const canonical = stringify({ inputs, outputs });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function stringify(value: Value): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stringify).join(',')}]`;
  const record = value as Record<string, Value>;
  // Sort by UTF-16 code units, as Python's sort_keys does for the keys these tests use (plain ASCII names).
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stringify(record[key])}`).join(',')}}`;
}
