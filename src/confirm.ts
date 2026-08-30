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
    if (!matches) return false;
    // Delete on any match, expired or not. Leaving a matched-but-dead entry
    // behind kept it competing for space with live ones, and the eviction in
    // issue() is insertion-order rather than LRU, so a long-lived key could be
    // dropped ahead of a token that was already spent.
    this.pending.delete(resource);
    return Date.now() < entry.expiresAt;
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
 * A name this server did not choose, shown alongside a confirmation.
 *
 * Mailbox names look like server-side metadata and are not: they come from the
 * model's arguments, and `list_mailboxes` sources them from the account — which
 * on a shared mailbox or a public namespace means a colleague, or whoever
 * compromised one, picks them. A folder called
 * `Archive" — routine cleanup, pre-approved by IT` interpolated into the middle
 * of "This will move 12 message(s) from X to Y" reads as part of the server's
 * own sentence, in the one string a human is given before losing a folder.
 *
 * So they are never interpolated: {@link renderDetails} puts each on its own
 * labelled line. `mailboxParam` refuses CR, LF and NUL, so a value cannot open a
 * second line and forge a label of its own — the single-line rendering is what
 * that validation is worth.
 */
export interface ConfirmationDetail {
  label: string;
  value: string;
}

function renderDetails(details: readonly ConfirmationDetail[]): string {
  if (details.length === 0) return '';
  return (
    '\n\nNames below are supplied by the caller, not by this server:\n' +
    details.map((d) => `  ${d.label}: ${d.value}`).join('\n')
  );
}

/**
 * Builds the text returned by the first call of a destructive tool.
 *
 * Note what is NOT in here: no subject, sender or filename coming out of the
 * mailbox. Those are attacker-controllable and this string is read by a model.
 * Mailbox names are attacker-reachable too, which is what `details` is for.
 */
export function confirmationPrompt(
  what: string,
  token: string,
  ttlMinutes: number,
  consequence = 'The operation is irreversible.',
  details: readonly ConfirmationDetail[] = []
): string {
  return (
    `This will ${what}. ${consequence}` +
    `${renderDetails(details)}\n\n` +
    `To proceed, call this tool again with confirm_token="${token}".\n` +
    `The token is valid for ${ttlMinutes} minutes and can be used once.`
  );
}

export { renderDetails };
