/**
 * The body of an outgoing message: plain text, or Markdown rendered to a
 * `text/html` alternative.
 *
 * Kept byte-identical in ni-c/imap-mcp and ni-c/smtp-mcp — a draft and a sent
 * message are the same feature, and `test/compose-body.test.ts` pins this
 * file's hash in both. Change both or neither.
 *
 * Markup is never accepted from the caller. Everything in the source is
 * escaped by markdown-it (`html: false`); the only tags in the result are the
 * ones the renderer writes, and `checkRenderedHtml` refuses the message if
 * anything else appears. That is the difference from sanitising HTML, where a
 * regex and the recipient's parser can always be made to disagree.
 */
import { domainToASCII } from 'node:url';

import MarkdownIt from 'markdown-it';
import type { MarkdownIt as Renderer, Token } from 'markdown-it';
import { z } from 'zod';

import { ToolInputError } from './errors.js';

/** Ceiling on a body. */
export const MAX_BODY_CHARS = 500_000;
/** Ceiling on a Markdown body: the one input that is parsed rather than copied. */
export const MAX_MARKDOWN_CHARS = 100_000;

export const bodyParam = z
  .string()
  .max(MAX_BODY_CHARS)
  .describe(
    'Body of the message: plain text, or Markdown when format is "markdown".'
  );

export const formatParam = z
  .enum(['text', 'markdown'])
  .default('text')
  .describe(
    '"text" (default) sends the body as plain text. "markdown" also adds an ' +
      'HTML alternative rendered from it: paragraphs, emphasis, lists, links, ' +
      'headings, block quotes and code. Raw HTML in the body is shown as ' +
      'text, images become links, and only https, http and plain mailto ' +
      'links are kept. The plain-text part is the body exactly as written. ' +
      `A Markdown body may be at most ${MAX_MARKDOWN_CHARS} characters.`
  );

export type BodyFormat = z.infer<typeof formatParam>;

const ALLOWED_TAGS =
  'p|h[1-6]|ul|ol|li|blockquote|pre|code|em|strong|a|br|hr|div';
const TAG = new RegExp(
  `<(\\/?)(${ALLOWED_TAGS})((?: [a-z]+="[^"<>]*")*)>`,
  'g'
);
const ATTRIBUTE = / ([a-z]+)="([^"<>]*)"/g;

/** Invisible format characters: bidi controls, zero-width joiners, soft hyphens. */
const FORMAT_CHARACTER = /\p{Cf}/u;
/** What separates host-shaped runs in link text; a split on it is linear. */
const NOT_HOST_CHARACTER = /[^\p{L}\p{N}\p{M}.-]+/u;
/**
 * Characters that read as a full stop and that NFKC leaves alone: the two a
 * URL parser maps to "." itself (UTS 46), and middle dots and lookalikes from
 * other scripts that a reader takes for one.
 */
const LOOKALIKE_DOTS = /[。｡·⸳∙⋅‧・܁܂ꞏꓸᐧ]/g;
/** A bracketed IPv6 literal, as it would appear inside a URL. */
const IPV6_LITERAL = /\[[0-9a-f:.]+\]/i;
const SCHEME_CHARACTER = /[a-z0-9+.-]/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const ALNUM = /[\p{L}\p{N}]/u;

const MAX_HREF_CHARS = 2_048;
/**
 * Ceiling on the rendered HTML.
 *
 * Without reference links every destination is written out in the source, so
 * the HTML stays a small multiple of it — escaping turns `&` into `&amp;` and an
 * image or rewritten link shows its destination twice; ordinary Markdown stays
 * under ten. Nineteen levels of empty quotes reach about 24 and are refused
 * here, as is anything the reasoning above has missed.
 */
const MAX_HTML_CHARS = 20 * MAX_MARKDOWN_CHARS;

const NOTE_REWRITTEN = (count: number) =>
  `${count} link${count === 1 ? '' : 's'} showed text that did not match ` +
  'the destination, or pointed at an internationalised domain; the HTML ' +
  'part shows the destination itself instead.';
const NOTE_REFUSED =
  'At least one link pointed somewhere other than an https, http or plain ' +
  'mailto address and was left as text.';

/**
 * Whether a normalised link destination may become an `href`.
 *
 * markdown-it calls this with the destination already percent-encoded and its
 * host in punycode, so what is checked is what the recipient's client follows.
 */
export function isAllowedHref(href: string): boolean {
  if (href.length > MAX_HREF_CHARS || !/^[\x21-\x7e]+$/.test(href)) {
    return false;
  }
  if (/^mailto:/i.test(href)) {
    // One address and nothing else: a query would prefill cc, bcc or a body,
    // and a percent-escape could hide a second recipient.
    return /^mailto:[^@?#%,;:/\\]+@[^@?#%,;:/\\]+$/i.test(href);
  }
  if (!/^https?:\/\//i.test(href)) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  // A host past DNS limits cannot resolve, and a long one can push its own
  // registrable domain out of a line cut for display.
  return (
    url.hostname !== '' &&
    url.hostname.length <= 253 &&
    url.hostname.split('.').every((label) => label.length <= 63) &&
    url.username === '' &&
    url.password === ''
  );
}

/** Host of an allowed href, or the domain of a mailto address. */
function hrefHost(href: string): string {
  if (/^mailto:/i.test(href)) {
    return (href.split('@')[1] ?? '').toLowerCase();
  }
  return new URL(href).hostname;
}

/**
 * The host a URL written in link text points at, or `null` if it does not
 * parse — which counts as misleading. Found by index, not by an unanchored
 * pattern, so a long word costs one pass.
 */
function urlHostIn(word: string): string | null | undefined {
  const separator = word.indexOf('://');
  if (separator !== -1) {
    let start = separator;
    while (start > 0 && SCHEME_CHARACTER.test(word[start - 1] ?? ''))
      start -= 1;
    let end = word.length;
    while (end > separator && !/[\p{L}\p{N}/\]]/u.test(word[end - 1] ?? '')) {
      end -= 1;
    }
    try {
      return new URL(word.slice(start, end)).hostname;
    } catch {
      return null;
    }
  }
  const literal = IPV6_LITERAL.exec(word);
  if (literal !== null) {
    try {
      return new URL(`http://${literal[0]}`).hostname;
    } catch {
      return null;
    }
  }
  return undefined;
}

/** A word with everything but letters and digits cut from both ends, by index. */
function trimToAlnum(word: string): string {
  const chars = [...word];
  let start = 0;
  let end = chars.length;
  while (start < end && !ALNUM.test(chars[start] ?? '')) start += 1;
  while (end > start && !ALNUM.test(chars[end - 1] ?? '')) end -= 1;
  return chars.slice(start, end).join('');
}

/**
 * The host a run of link text names, if it is shaped like one.
 *
 * A run is a stretch of letters, digits, marks, dots and hyphens. It names a
 * host when, with dots and hyphens trimmed from its ends, it has a dot between
 * two labels and its last label is two characters or more with a letter in
 * it — `docs.example` and `bank.example-login`, not `1.2.3` or `e.g`. An IPv4 address counts too.
 */
function hostOf(run: string): string | undefined {
  let start = 0;
  let end = run.length;
  while (start < end && (run[start] === '.' || run[start] === '-')) start += 1;
  while (end > start && (run[end - 1] === '.' || run[end - 1] === '-'))
    end -= 1;
  const candidate = run.slice(start, end);
  if (IPV4.test(candidate)) return candidate;
  const labels = candidate.split('.');
  if (labels.length < 2 || labels.some((label) => label === ''))
    return undefined;
  // No top-level domain is a single character, so `e.g` names nothing.
  const last = labels.at(-1) ?? '';
  return last.length >= 2 && /\p{L}/u.test(last) ? candidate : undefined;
}

/**
 * Whether link text says something about its destination that is not true.
 *
 * Fails closed: text that names any host other than the destination's — as a
 * URL, a bare domain, an address or a fragment glued to punctuation — counts,
 * and so does anything that can make text look like what it is not.
 */
function misleads(text: string, href: string): boolean {
  if (FORMAT_CHARACTER.test(text)) return true;
  const host = hrefHost(href);
  if (host.split('.').some((label) => label.startsWith('xn--'))) return true;
  const isMailto = /^mailto:/i.test(href);
  // NFKC folds lookalike dots and fullwidth letters into what a URL parser
  // reads; the text the recipient sees is left as written.
  const folded = text.normalize('NFKC').replace(LOOKALIKE_DOTS, '.');

  for (const word of folded.split(/\s+/)) {
    // Numeric and bracketed hosts (`127.1`, `0x7f000001`, `[2001:db8::1]`)
    // have no letter to find below; the URL parser reads them as a browser does.
    const written = urlHostIn(word);
    if (written === null || (written !== undefined && written !== host)) {
      return true;
    }
    if (!word.includes('@')) continue;
    // An address in the text must be the very address a mailto link goes to.
    const address = trimToAlnum(word).toLowerCase();
    if (!isMailto || `mailto:${address}` !== href.toLowerCase()) return true;
  }
  for (const run of folded.split(NOT_HOST_CHARACTER)) {
    const named = hostOf(run);
    if (named === undefined) continue;
    const ascii = domainToASCII(named.toLowerCase());
    if (ascii === '' || ascii !== host) return true;
  }
  return false;
}

function textToken(state: { Token: typeof Token }, content: string): Token {
  const token = new state.Token('text', '', 0);
  token.content = content;
  return token;
}

/**
 * Rewrites the inline tokens of one block.
 *
 * Images become links, so nothing in the message loads by itself. A link
 * inside a link is flattened to its text. Every link keeps its `href` and
 * nothing else — no title — and a link whose text misleads about its
 * destination shows the destination instead.
 */
function guardLinks(
  children: Token[],
  state: { Token: typeof Token },
  counter: LinkCounter
): Token[] {
  const out: Token[] = [];
  let open: Token | undefined;
  let inner: Token[] = [];

  for (const token of children) {
    if (token.type === 'image') {
      const href = String(token.attrGet('src') ?? '');
      const alt = (token.children ?? []).map((child) => child.content).join('');
      if (open !== undefined) {
        inner.push(textToken(state, alt));
        continue;
      }
      const linkOpen = new state.Token('link_open', 'a', 1);
      linkOpen.attrs = [['href', href]];
      out.push(
        ...finishLink(
          linkOpen,
          [textToken(state, alt === '' ? href : alt)],
          state,
          counter
        )
      );
      continue;
    }
    if (token.type === 'link_open') {
      if (open === undefined) {
        open = token;
        inner = [];
      }
      // A link inside a link: its markers are dropped, its text stays.
      continue;
    }
    if (token.type === 'link_close') {
      if (open !== undefined) {
        out.push(...finishLink(open, inner, state, counter));
        open = undefined;
      }
      continue;
    }
    if (open !== undefined) inner.push(token);
    else out.push(token);
  }
  // An unterminated link cannot come out of markdown-it; keep its text if it did.
  if (open !== undefined) out.push(...inner);
  return out;
}

function finishLink(
  open: Token,
  inner: Token[],
  state: { Token: typeof Token },
  counter: LinkCounter
): Token[] {
  const href = String(open.attrGet('href') ?? '');
  // markdown-it keeps an inline link or image whose destination validateLink
  // refused, with an empty href. It is text here, not a link to nowhere.
  if (!isAllowedHref(href)) {
    counter.refused = true;
    return inner;
  }
  const linkOpen = new state.Token('link_open', 'a', 1);
  linkOpen.attrs = [['href', href]];
  const linkClose = new state.Token('link_close', 'a', -1);
  const text = inner
    .map((token) =>
      token.type === 'softbreak' || token.type === 'hardbreak'
        ? ' '
        : token.content
    )
    .join('');
  counter.links.add(href);
  if (misleads(text, href)) {
    counter.rewritten += 1;
    return [linkOpen, textToken(state, href), linkClose];
  }
  return [linkOpen, ...inner, linkClose];
}

let refusedWhileRendering = false;

// A type rather than an interface: markdown-it's Env is an index signature,
// which an interface does not satisfy.
type LinkCounter = {
  refused: boolean;
  rewritten: number;
  /** Every destination kept, in order of first appearance. */
  links: Set<string>;
};

function createRenderer(): Renderer {
  const md = new MarkdownIt('zero', {
    html: false,
    linkify: false,
    typographer: false,
    breaks: true,
  });
  md.enable([
    'code',
    'fence',
    'blockquote',
    'hr',
    'list',
    'heading',
    'lheading',
    'newline',
    'escape',
    'backticks',
    'emphasis',
    'link',
    'image',
    'autolink',
  ]);
  // Two rules stay off on purpose. `reference` lets four characters of source
  // reuse a destination thousands of characters long, so the HTML could grow
  // thousands of times larger than the body it came from. `entity` turns
  // `&#x202E;` into a bidi override and `&#73;` into a letter, so the HTML
  // would say something the plain-text part and the approval dialog do not.

  // markdown-it leaves a refused link as text without a token to say so; the
  // flag is how the result can. Rendering is synchronous, so one is enough.
  // The text of an autolink is the destination exactly as written. markdown-it
  // would percent-decode it, so `%20Your%20account%20is%20suspended` would read
  // as a sentence the source and the dialog do not show.
  md.normalizeLinkText = (url) => url;

  md.validateLink = (href) => {
    const allowed = isAllowedHref(href);
    if (!allowed) refusedWhileRendering = true;
    return allowed;
  };

  md.core.ruler.push('guard_links', (state) => {
    const counter = state.env as unknown as LinkCounter;
    for (const token of state.tokens) {
      if (token.type === 'inline' && token.children !== null) {
        token.children = guardLinks(token.children, state, counter);
      }
    }
  });

  // Past maxNesting markdown-it drops the rest of the block without a word,
  // which would leave text in the plain part that the HTML part does not have.
  const tokenize = md.block.tokenize.bind(md.block);
  md.block.tokenize = (state, startLine, endLine) => {
    if (state.level >= (md.options.maxNesting ?? 0) && startLine < endLine) {
      throw new ToolInputError(
        'A Markdown body may nest block quotes and lists only so deep; ' +
          'flatten it or send it with format "text".'
      );
    }
    tokenize(state, startLine, endLine);
  };

  // No info string, no `class="language-…"`: an attribute the caller chose.
  const code = (tokens: Token[], idx: number) =>
    `<pre><code>${md.utils.escapeHtml(tokens[idx]?.content ?? '')}</code></pre>\n`;
  md.renderer.rules.fence = code;
  md.renderer.rules.code_block = code;
  md.renderer.rules.image = () => {
    throw new Error('compose-body: an image token reached the renderer.');
  };
  return md;
}

const renderer = createRenderer();

/**
 * Proves the HTML contains nothing but the renderer's own tags.
 *
 * Not a sanitiser — it repairs nothing. Every `<` must open a tag from a fixed
 * list, `href` is the only attribute on `a`, `start` the only one on `ol`, and
 * no other tag carries any. Text was escaped on the way in, so a `<`, `>` or
 * `"` left over after the tags are taken out means markdown-it or an override
 * here wrote something it should not have, and the message is refused.
 */
export function checkRenderedHtml(html: string): void {
  let bad = false;
  const remainder = html.replace(
    TAG,
    (_match, closing: string, tag: string, attributes: string) => {
      const pairs = [...attributes.matchAll(ATTRIBUTE)].map(
        (m) => [m[1] ?? '', m[2] ?? ''] as const
      );
      if (closing === '/' && pairs.length > 0) bad = true;
      for (const [name, value] of pairs) {
        if (tag === 'a' && name === 'href') {
          const href = value
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
          if (!isAllowedHref(href)) bad = true;
        } else if (!(
          tag === 'ol' &&
          name === 'start' &&
          /^\d{1,9}$/.test(value)
        )) {
          bad = true;
        }
      }
      if (tag === 'a' && closing === '' && pairs.length !== 1) bad = true;
      return '';
    }
  );
  if (bad || /[<>"]/.test(remainder)) {
    throw new Error(
      'compose-body: the rendered HTML failed its own check; nothing was written.'
    );
  }
}

/** Renders a Markdown body to an HTML fragment. */
export function renderMarkdown(source: string): {
  html: string;
  notes: string[];
  links: string[];
} {
  if (source.length > MAX_MARKDOWN_CHARS) {
    throw new ToolInputError(
      `A Markdown body may be at most ${MAX_MARKDOWN_CHARS} characters; ` +
        'shorten it or send it with format "text".'
    );
  }
  const env: LinkCounter = { refused: false, rewritten: 0, links: new Set() };
  refusedWhileRendering = false;
  const html = renderer.render(source, env);
  if (refusedWhileRendering) env.refused = true;
  if (html.length > MAX_HTML_CHARS) {
    throw new ToolInputError(
      'The HTML rendered from this Markdown body would be too large; flatten ' +
        'nested quotes and lists or send it with format "text".'
    );
  }
  checkRenderedHtml(html);
  const notes: string[] = [];
  if (env.rewritten > 0) notes.push(NOTE_REWRITTEN(env.rewritten));
  if (env.refused) notes.push(NOTE_REFUSED);
  return { html, notes, links: [...env.links] };
}

/** Quoted-reply convention: every line of the original prefixed with "> ". */
function quoteText(quote: string): string {
  return quote
    .split(/\r?\n/)
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

function escapedLines(value: string): string {
  return renderer.utils.escapeHtml(value).replace(/\r?\n/g, '<br>\n');
}

export interface BodyInput {
  body: string;
  format: BodyFormat;
  /** Original text quoted below the body, for a reply or a forward. */
  quote?: string | undefined;
  signature?: string | undefined;
}

export interface ComposedBody {
  /** The `text/plain` part: the body as written, then the quote and signature. */
  text: string;
  /** The `text/html` part, present only for Markdown. */
  html?: string;
  /** What the rendering changed, in this module's words — never the caller's. */
  notes: string[];
  /**
   * Every link destination in the HTML part, in order of first appearance.
   *
   * Caller text: a link shows its text, not where it goes, so whoever approves
   * the message needs these listed on their own.
   */
  links: string[];
}

/**
 * Builds the text and, for Markdown, the HTML part of a message.
 *
 * The plain-text part is always the source: what a person approves or opens
 * as a draft is what the HTML was derived from, so the two cannot say
 * different things.
 */
export function composeBodies(input: BodyInput): ComposedBody {
  const hasQuote = input.quote !== undefined && input.quote !== '';
  const textParts = [input.body];
  if (hasQuote) textParts.push(`\n\n${quoteText(input.quote ?? '')}`);
  if (input.signature !== undefined) {
    // The standard signature delimiter. Mail clients hide everything below it
    // when quoting a reply, which is exactly what a signature is for.
    textParts.push(`\n\n-- \n${input.signature}`);
  }
  const text = textParts.join('');
  if (input.format !== 'markdown') return { text, notes: [], links: [] };

  const rendered = renderMarkdown(input.body);
  const htmlParts = [rendered.html];
  if (hasQuote) {
    htmlParts.push(
      `<blockquote>${escapedLines(input.quote ?? '')}</blockquote>\n`
    );
  }
  if (input.signature !== undefined) {
    htmlParts.push(`<div>-- <br>\n${escapedLines(input.signature)}</div>\n`);
  }
  const fragment = htmlParts.join('');
  checkRenderedHtml(fragment);
  return {
    text,
    html:
      '<!doctype html>\n<html><head><meta charset="utf-8"></head><body>\n' +
      `${fragment}</body></html>\n`,
    notes: rendered.notes,
    links: rendered.links,
  };
}
