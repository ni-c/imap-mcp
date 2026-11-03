import { z } from 'zod';

/** Ceiling on how many messages one call may return. */
export const MAX_LIMIT = 200;

/**
 * C0 and C1 control characters. Tab is excepted; a folder name may legitimately
 * contain one, and it is the one character in the range that renders as itself.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;

/** The same class, for the mailbox names that arrive through the environment. */
export const MAILBOX_CONTROL_CHARS = CONTROL_CHARS;

/**
 * A mailbox name.
 *
 * IMAP is a line protocol and mailbox names are interpolated into commands.
 * imapflow quotes them, but a CR or LF would still be a command-injection
 * primitive if any layer ever stopped quoting, so they are refused outright —
 * along with the rest of the C0/C1 range, which the CR/LF/NUL check used to
 * leave through. A bare CR was the interesting one: `list_mailboxes` hands the
 * path back for the model to quote into the next call, and the confirmation
 * dialog a person reads before losing messages is line-oriented, so a name
 * carrying control characters is a name that does not read the way it looks.
 *
 * The `%` and `*` wildcards are refused too: they belong to LIST patterns, and
 * a "delete the mailbox `*`" that quietly matched everything is not a mistake
 * worth being one layer away from.
 *
 * Deliberately *not* refused: zero-width and directional-override characters.
 * A folder someone else created may genuinely have them in its name, and a
 * parameter that rejected them would leave that folder unreadable and
 * undeletable through this server. They are handled where they can be handled
 * honestly — `display_name` in the listing, and the escape form in the dialog.
 */
export const mailboxParam = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (v) => !CONTROL_CHARS.test(v),
    'must not contain line breaks or control characters'
  )
  .refine((v) => !/[%*]/.test(v), 'must not contain the wildcards % or *')
  .describe(
    'Mailbox (folder) name exactly as returned by list_mailboxes, e.g. "INBOX" or "INBOX/Archive". Defaults to the configured mailbox.'
  );

export const optionalMailboxParam = mailboxParam.optional();

/** An IMAP UID is an nz-number: 1 to 2^32 - 1 (RFC 3501). */
const MAX_UID = 4_294_967_295;

export const uidParam = z
  .int()
  .positive()
  .max(MAX_UID)
  .describe('IMAP UID of the message, as returned by the listing tools.');

export const uidListParam = z
  .array(z.int().positive().max(MAX_UID))
  .min(1)
  .max(MAX_LIMIT)
  .describe(
    'IMAP UIDs of the messages to act on, as returned by the listing tools.'
  );

export const limitParam = z
  .int()
  .positive()
  .max(MAX_LIMIT)
  .optional()
  .describe(
    `Maximum number of messages to return (default from IMAP_MAX_MESSAGES, hard cap ${MAX_LIMIT}).`
  );

export const offsetParam = z
  .int()
  .min(0)
  .optional()
  .describe('How many messages to skip, newest first, for paging.');

/**
 * A date the IMAP server can search on. Round-tripped through Date because V8
 * happily rolls `2026-02-30` over into March instead of rejecting it.
 */
export const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD form')
  .refine((v) => {
    const parsed = new Date(`${v}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v
    );
  }, 'must be a real calendar date')
  .optional();

/** The characters RFC 5322 allows in an unquoted local-part atom. */
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
/**
 * A bare addr-spec in its plainest form: a dot-atom local part, an ASCII
 * domain of at least two labels. No quoted local part, no comment, no domain
 * literal, no display name, no group.
 */
const ADDR_SPEC = new RegExp(
  `^${ATEXT}(?:\\.${ATEXT})*@${LABEL}(?:\\.${LABEL})+$`
);

/**
 * A single email address.
 *
 * It is written into a mail header of a draft that a person later sends, and
 * the person's mail client decides which recipient it shows. So the accepted
 * set is exactly the addresses every parser reads the same way: a recipient
 * the dialog or the model sees as `alice@example.net` is the one that receives
 * the message. `AliceSmith<alice@evil.example>`, `x@evil.example(Alice)`,
 * `team:x@evil.example;` and `ceo,x@evil.example` all contain one `@` and no
 * whitespace and all name a recipient other than the one they appear to, so
 * "one `@`, no whitespace" was not enough. Non-ASCII is refused outright:
 * zero-width and bidirectional characters make two addresses look alike, and a
 * non-ASCII domain belongs in its punycode form.
 *
 * A host without a dot (`user@localhost`) is refused too; mail to a bare
 * single-label host is almost never what a draft from a mailbox means.
 */
export const addressParam = z
  .string()
  .min(3)
  .max(254)
  .refine((v) => !/[\r\n]/.test(v), 'must not contain line breaks')
  .refine(
    // eslint-disable-next-line no-control-regex
    (v) => /^[\u0000-\u007f]*$/.test(v),
    'must be plain ASCII: write an internationalised domain in its punycode ' +
      'form (xn--…), and use an ASCII local part'
  )
  .refine(
    (v) => ADDR_SPEC.test(v) && v.indexOf('@') <= 64,
    'must be a bare email address such as person@example.net — no display ' +
      'name, angle brackets, comments, quotes, groups or lists, and a domain ' +
      'with at least one dot'
  )
  .describe('A single email address, e.g. person@example.net.');

export const addressListParam = z
  .array(addressParam)
  .min(1)
  .max(50)
  .describe('Recipient email addresses.');

/**
 * An IMAP flag or keyword. System flags start with a backslash; custom keywords
 * are atoms. Anything else could terminate the command it is written into.
 */
export const flagParam = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (v) => /^\\?[A-Za-z0-9$_.-]+$/.test(v),
    'must be a system flag such as \\Seen or a keyword such as AiSeen'
  );

export const flagListParam = z
  .array(flagParam)
  .min(1)
  .max(20)
  .describe(
    'IMAP flags or keywords, e.g. ["\\\\Seen"], ["\\\\Flagged"] or a custom keyword.'
  );

/**
 * mcp-approval issues 16 random bytes as lowercase hex. Anything else cannot be
 * a token this server issued, so it is refused before it reaches the store.
 */
export const confirmTokenParam = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[0-9a-f]+$/, 'must be a token as issued by this server')
  .optional()
  .describe(
    'Confirmation token from a previous call of this tool with the same arguments. Omit on the first call.'
  );

/** Free-text search term. Capped so a whole document cannot become a query. */
export const searchTextParam = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !/[\r\n\0]/.test(v), 'must not contain line breaks')
  .optional();
