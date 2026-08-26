import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_MS = 5 * 60 * 1000;
/** Bounds the map so a loop of refused calls cannot grow it without limit. */
const MAX_PENDING = 100;

/**
 * Issues short-lived confirmation tokens for irreversible operations.
 *
 * A plain boolean `confirm` parameter could be set by the model on the very
 * first call — or be talked into it by instructions hidden in upstream content —
 * whereas a random token that only ever appears in a *previous* tool result
 * cannot be guessed. The token is bound to a resource key, so a confirmation for
 * one target cannot be replayed for another.
 */
export class ConfirmationStore {
  private readonly pending = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  constructor(private readonly ttlMs: number = TOKEN_TTL_MS) {}

  /** Creates (or replaces) the pending token for `resource`. */
  issue(resource: string): string {
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    const token = randomBytes(16).toString('hex');
    this.pending.set(resource, { token, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  /**
   * Returns true and consumes the token when it matches the pending one for
   * `resource` and has not expired. Tokens are single-use.
   */
  consume(resource: string, token: string | undefined): boolean {
    const entry = this.pending.get(resource);
    if (entry === undefined || token === undefined) return false;
    const supplied = Buffer.from(token);
    const expected = Buffer.from(entry.token);
    // Constant-time comparison. Guessing 128 random bits through a timing
    // side channel is not a realistic attack on a local tool, but the safe
    // comparison costs one line and removes the question.
    const matches =
      supplied.length === expected.length &&
      timingSafeEqual(supplied, expected);
    if (!matches || Date.now() >= entry.expiresAt) return false;
    this.pending.delete(resource);
    return true;
  }

  /** Minutes the issued tokens stay valid, for use in messages. */
  get ttlMinutes(): number {
    return Math.round(this.ttlMs / 60_000);
  }
}

/**
 * Resource key for an operation on a *set* of targets. Without the fingerprint a
 * confirmation for ["a.txt"] would also execute ["a.txt", "secrets.env"] — the
 * model chooses the second list, and only the id would have been checked.
 */
export function setResourceKey(operation: string, targets: string[]): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([...targets].sort()))
    .digest('hex')
    .slice(0, 16);
  return `${operation}:${fingerprint}`;
}

/**
 * Builds the text returned by the first call of a destructive tool.
 *
 * Note what is NOT in here: no subject, sender or filename coming out of the
 * mailbox. Those are attacker-controllable and this string is read by a model.
 *
 * The send tools are the one deliberate exception — they pass the recipient
 * addresses in `what`. Those are caller-supplied rather than mailbox content,
 * and naming them is the entire point: an address smuggled in by a message the
 * model just read is only visible to a human if the confirmation prints it.
 * Subject and body stay out even there.
 */
export function confirmationPrompt(
  what: string,
  token: string,
  ttlMinutes: number,
  consequence = 'The operation is irreversible.'
): string {
  return (
    `This will ${what}. ${consequence}\n\n` +
    `To proceed, call this tool again with confirm_token="${token}".\n` +
    `The token is valid for ${ttlMinutes} minutes and can be used once.`
  );
}
