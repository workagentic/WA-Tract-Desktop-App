/**
 * `fetch()` (and Electron's `net.fetch()`) wrap every underlying failure -
 * DNS, TLS/certificate errors, connection refused, an invalid URL - as the
 * same opaque `TypeError: fetch failed`, with the actual reason nested one
 * or more levels down in `.cause`. Logging `String(err)` alone drops that
 * chain entirely, which is exactly what made a real "every request fails
 * certificate verification" bug indistinguishable in sync.log/pairing.log
 * from a normal transient network blip.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [`${err.name}: ${err.message}`];
  let cause = err.cause;
  while (cause) {
    if (cause instanceof Error) {
      parts.push(`${cause.name}: ${cause.message}`);
      cause = cause.cause;
    } else {
      parts.push(String(cause));
      break;
    }
  }
  return parts.join(' <- caused by <- ');
}
