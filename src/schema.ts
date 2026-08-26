import { z } from 'zod';

/** Ceiling on how many messages one call may return. */
export const MAX_LIMIT = 200;

/**
 * A mailbox name.
 *
 * IMAP is a line protocol and mailbox names are interpolated into commands.
 * imapflow quotes them, but a CR or LF would still be a command-injection
 * primitive if any layer ever stopped quoting, so they are refused outright.
 * The `%` and `*` wildcards are refused too: they belong to LIST patterns, and
 * a "delete the mailbox `*`" that quietly matched everything is not a mistake
 * worth being one layer away from.
 */
export const mailboxParam = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => !/[\r\n\0]/.test(v), 'must not contain line breaks')
  .refine((v) => !/[%*]/.test(v), 'must not contain the wildcards % or *')
  .describe(
    'Mailbox (folder) name exactly as returned by list_mailboxes, e.g. "INBOX" or "INBOX/Archive". Defaults to the configured mailbox.'
  );

export const optionalMailboxParam = mailboxParam.optional();

export const uidParam = z
  .int()
  .positive()
  .describe('IMAP UID of the message, as returned by the listing tools.');

export const uidListParam = z
  .array(z.int().positive())
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

/**
 * An email address or an address list.
 *
 * Line breaks are refused because a recipient is written into a mail header:
 * a CR here would let the caller append headers of its own — a Bcc, a Reply-To
 * pointing somewhere else — to a message a human thought they had approved.
 */
export const addressParam = z
  .string()
  .min(3)
  .max(320)
  .refine((v) => !/[\r\n]/.test(v), 'must not contain line breaks')
  .refine(
    (v) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v),
    'must be a bare email address such as person@example.net'
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

export const confirmTokenParam = z
  .string()
  .min(1)
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
