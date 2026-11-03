/** Anything holding a session that has to be ended before the process exits. */
export interface Closable {
  close(): Promise<void>;
}

/**
 * The one way this process ends on purpose.
 *
 * The IMAP socket keeps Node alive after the client closes stdin, so a client
 * that exits without a signal used to leave this process — and a logged-in
 * IMAP session — behind, one per restart. Every open client is logged out,
 * bounded by `graceMs` so a server that does not answer the LOGOUT cannot hold
 * the exit, and the second call is a no-op.
 */
export function createShutdown(
  closables: () => Iterable<Closable>,
  exit: (code: number) => void,
  graceMs = 3_000
): (code?: number) => Promise<void> {
  let started = false;
  return async (code = 0) => {
    if (started) return;
    started = true;
    const timer = setTimeout(() => exit(code), graceMs);
    timer.unref?.();
    await Promise.allSettled([...closables()].map((item) => item.close()));
    clearTimeout(timer);
    exit(code);
  };
}
