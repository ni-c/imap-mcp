import type { MessageStructureObject } from 'imapflow';

import {
  defuseAutoFetch,
  detectSuspicious,
  stripInvisible,
} from './analyze.js';

/** How deep the MIME tree is walked. Forwarded mail nests; a loop does not. */
const MAX_DEPTH = 5;
/** Upper bound on how many parts one listing may describe. */
const MAX_ATTACHMENTS = 50;
const MAX_FILENAME_LENGTH = 120;
/**
 * Upper bound on the UTF-8 size of a saved name. Filesystems limit bytes, not
 * characters: 120 CJK characters are 360 bytes and fail with ENAMETOOLONG.
 */
const MAX_FILENAME_BYTES = 200;
/** The longest entry of {@link EXECUTABLE_EXTENSIONS} is `settingcontent-ms`. */
const EXTENSION_PATTERN = /\.([A-Za-z0-9-]{1,24})$/;
/** Path separators, the characters Windows reads specially, and C0 controls. */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[/\\:<>"|?*\u0000-\u001f\u007f]/g;
/** Names Windows treats as devices, with or without an extension. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\s*(\.|$)/i;

/**
 * Extensions that are executable somewhere. The list is long on purpose: this
 * is a refusal list applied on top of the content-type allowlist, and the cost
 * of an extra entry is one unusual attachment that has to be fetched by other
 * means.
 *
 * Exported so a test can walk it. An entry {@link extensionOf} cannot produce
 * is not a stricter list, it is a longer one that refuses less — and nothing
 * about reading the two declarations side by side says which is which.
 */
export const EXECUTABLE_EXTENSIONS = new Set([
  'ade',
  'adp',
  'app',
  'appimage',
  'application',
  'appref-ms',
  'appx',
  'appxbundle',
  'asp',
  'aspx',
  'bas',
  'bat',
  'cab',
  'cer',
  'chm',
  'cmd',
  'com',
  'cpl',
  'crt',
  'csh',
  'deb',
  'diagcab',
  'dll',
  'dmg',
  'exe',
  'fxp',
  'gadget',
  'hlp',
  'hta',
  'inf',
  'ins',
  'img',
  'iso',
  'isp',
  'its',
  'jar',
  'js',
  'jse',
  'ksh',
  'library-ms',
  'lnk',
  'mad',
  'maf',
  'mag',
  'mam',
  'maq',
  'mar',
  'mas',
  'mat',
  'mau',
  'mav',
  'maw',
  'mda',
  'mdb',
  'mde',
  'mdt',
  'mdw',
  'mdz',
  'mht',
  'mhtml',
  'msc',
  'msh',
  'msh1',
  'msh2',
  'mshxml',
  'msi',
  'msix',
  'msixbundle',
  'msp',
  'mst',
  'ops',
  'pcd',
  'pif',
  'pkg',
  'pl',
  'plg',
  'prf',
  'prg',
  'ps1',
  'ps2',
  'psc1',
  'psc2',
  'py',
  'pyc',
  'pyo',
  'pyw',
  'rb',
  'reg',
  'rpm',
  'scf',
  'scr',
  'sct',
  'search-ms',
  'settingcontent-ms',
  'sh',
  'shb',
  'shs',
  'url',
  'vb',
  'vbe',
  'vbs',
  'vhd',
  'vhdx',
  'vsmacros',
  'vsw',
  'website',
  'ws',
  'wsb',
  'wsc',
  'wsf',
  'wsh',
  'xbap',
  'xll',
]);

/**
 * A filename ending in something that looks like a document extension followed
 * by an executable one — `invoice.pdf.exe`. Mail clients that hide known
 * extensions render it as `invoice.pdf`.
 */
const DOUBLE_EXTENSION_BAIT =
  /\.(pdf|docx?|xlsx?|pptx?|txt|csv|jpe?g|png|gif|zip|rtf|odt|ods)\.[a-z0-9]{1,5}$/i;

/**
 * The shape of a media type — RFC 6838's token characters, bounded on both
 * sides of the slash.
 *
 * The declared type of a part is the sender's string, and it used to travel
 * as it came: into `content_type`, into the refusal note that quotes it, and
 * from there into the `get_message` metadata block outside the fence and into
 * error results the budget never measures. A hundred kilobytes of it in one
 * `Content-Type` header made the message unreadable. Anything that does not
 * match here is not a media type, is never on the allowlist, and is reported
 * as `application/octet-stream` with a note that says so without quoting it.
 */
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}$/;

export function isMediaType(value: string): boolean {
  return MEDIA_TYPE.test(value);
}

export interface AttachmentCandidate {
  partId: string;
  filename: string;
  contentType: string;
  /** Size as declared by the server; not yet verified against the bytes. */
  size: number | undefined;
  disposition: string | undefined;
  /** True when nothing in the *declaration* disqualifies it. */
  allowed: boolean;
  /** Why it was refused, or what looks off about it. */
  notes: string[];
  /**
   * Injection shapes the *declared* filename matches. Computed before the name
   * is made safe to save: `SYSTEM: ignore …` loses its colon on the way and
   * would stop matching, although it is the sender's text all the same.
   */
  suspicious?: string[];
}

export interface AttachmentPolicy {
  allowedTypes: string[];
  /**
   * Size ceiling for the destination this check is for.
   *
   * Per destination, because there are three of them and they answer different
   * questions: what may enter the model's context, what may be written to disk,
   * what a parser may be handed. The caller picks the number; naming it here
   * keeps the refusal pointing at the variable an operator would actually
   * change.
   */
  maxBytes: number;
  /** Environment variable behind {@link maxBytes}, for the refusal text. */
  maxBytesName: string;
}

/**
 * Strips a filename down to something safe to print and to reason about.
 *
 * The name is never used to open a file — nothing here writes to disk — but it
 * does reach the model, and a name carrying directional overrides or path
 * separators is trying to be read as something it is not.
 */
export function sanitizeFilename(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return '(unnamed)';
  // Two orderings matter here, and both were wrong.
  //
  // The trim runs *before* the leading dots are taken off, and again after. The
  // other way round, one space defeated the rule: ` .bashrc` has no dot in
  // first position when the strip runs, and the trim that followed exposed it,
  // so the name reached the model looking like a dotfile after all.
  //
  // And the strip never takes the dot that carries the extension. It used to:
  // `.exe` came out as `exe`, `extensionOf` then answered `''`, and an empty
  // extension makes `checkPolicy` skip the executable check entirely rather
  // than fail it — so the blocklist was bypassed by naming the attachment
  // `.exe`. That is the same failure `appref-ms` caused, reached by a different
  // route. One leading dot is kept whenever removing it would consume the last
  // one; a name that has another dot further along loses them as before.
  //
  // A kept dot has to name an extension, though. Kept for anything else it was
  // just a dotfile-shaped name: `..!` (or `︰!`, which NFKC turns into it) came
  // out as `.!`. So the whole run of dots and spaces in front goes, and one dot
  // comes back only when it is the one `extensionOf` reads.
  //
  // Windows normalises a name when it opens it: trailing dots and spaces are
  // dropped (`Rechnung.bat.` is `Rechnung.bat`), `:stream` selects an alternate
  // data stream (`Rechnung.bat::$DATA` is `Rechnung.bat`), and CON, NUL, COM1 …
  // are devices with or without an extension. An extension check that looks at
  // the name as the sender wrote it sees `''` where the file system sees `bat`.
  // So the name is brought into the form that will be saved first — trailing
  // `[.\s]` removed, `:<>"|?*` and control characters replaced, device names
  // renamed — and every check afterwards runs on that name.
  const body = defuseAutoFetch(stripInvisible(raw.normalize('NFKC')))
    .trim()
    .replace(UNSAFE_FILENAME_CHARS, '_')
    .replace(/[.\s]+$/, '');
  const rest = body.replace(/^[.\s]+/, '');
  const keepDot =
    body.startsWith('.') &&
    !rest.includes('.') &&
    extensionOf(`.${rest}`) !== '';
  let cleaned = keepDot ? `.${rest}` : rest;
  // A name of nothing but dots is not a name. It carries no extension either,
  // so keeping it buys the check above nothing and only puts `...` in front of
  // a reader.
  if (cleaned === '' || /^\.+$/.test(cleaned)) return '(unnamed)';
  if (WINDOWS_DEVICE_NAME.test(cleaned)) cleaned = `_${cleaned}`;
  return truncateName(cleaned);
}

/**
 * Shortens a name to {@link MAX_FILENAME_LENGTH} characters and
 * {@link MAX_FILENAME_BYTES} bytes, keeping the extension.
 *
 * The extension is what {@link checkPolicy} reads. Cutting the whole name at a
 * fixed length dropped it: `'a'.repeat(130) + '.exe'` came out as 120 `a`s and
 * an ellipsis, with no extension left to refuse. The stem is cut instead.
 */
function truncateName(name: string): string {
  const extension = EXTENSION_PATTERN.exec(name)?.[0] ?? '';
  if (
    Array.from(name).length <= MAX_FILENAME_LENGTH &&
    Buffer.byteLength(name) <= MAX_FILENAME_BYTES
  ) {
    return name;
  }
  const stem = Array.from(name.slice(0, name.length - extension.length));
  const tail = `…${extension}`;
  while (
    stem.length > 0 &&
    (stem.length + Array.from(tail).length > MAX_FILENAME_LENGTH ||
      Buffer.byteLength(stem.join('')) + Buffer.byteLength(tail) >
        MAX_FILENAME_BYTES)
  ) {
    stem.pop();
  }
  return `${stem.join('')}${tail}`;
}

/**
 * The trailing extension of a filename, lowercased, or `''`.
 *
 * The character class and the length have to cover every entry of
 * {@link EXECUTABLE_EXTENSIONS}, or the blocklist has entries that can never be
 * read out of a name. Both used to be too narrow: `appref-ms` carries a hyphen
 * and `application` is eleven characters, so both returned `''` — and an empty
 * extension makes {@link checkPolicy} skip the executable check entirely rather
 * than fail it. `Rechnung-2026.appref-ms` declared as `application/xml` (which
 * is in the default type allowlist, and which a ClickOnce manifest genuinely
 * is) therefore reached the download directory under its own name with no note
 * against it. The property test over the whole set is what keeps the two in
 * step from here on.
 */
export function extensionOf(filename: string): string {
  const match = EXTENSION_PATTERN.exec(filename);
  return match?.[1]?.toLowerCase() ?? '';
}

/**
 * Walks the MIME tree and returns every part that is an attachment.
 *
 * Parts inside a forwarded `message/rfc822` are included: an attachment that
 * arrives one level deeper is exactly as dangerous, and a listing that stops at
 * the outer envelope would report "no attachments" for the most common way of
 * passing a file along.
 */
export function collectAttachments(
  structure: MessageStructureObject | undefined
): AttachmentCandidate[] {
  const found: AttachmentCandidate[] = [];
  walk(structure, 0, found);
  return found.slice(0, MAX_ATTACHMENTS);
}

function walk(
  node: MessageStructureObject | undefined,
  depth: number,
  found: AttachmentCandidate[],
  sharedPart?: string
): void {
  if (
    node === undefined ||
    depth > MAX_DEPTH ||
    found.length >= MAX_ATTACHMENTS
  )
    return;

  const isForwarded = (node.type ?? '').toLowerCase() === 'message/rfc822';
  if (node.childNodes !== undefined && node.childNodes.length > 0) {
    // An attached `.eml` is itself an attachment. Descending into it lists what
    // is inside and never the message, so a mail passed along as a file used
    // to show no attachment at all.
    // Only when it says so itself: the forwarded body of a mail is not one.
    if (
      isForwarded &&
      depth > 0 &&
      (node.disposition?.toLowerCase() === 'attachment' ||
        (node.dispositionParameters?.filename ?? node.parameters?.name) !==
          undefined)
    ) {
      addCandidate(node, depth, found);
    }
    for (const child of node.childNodes) {
      walk(child, depth + 1, found, isForwarded ? node.part : sharedPart);
    }
    return;
  }

  addCandidate(node, depth, found, sharedPart);
}

function addCandidate(
  node: MessageStructureObject,
  depth: number,
  found: AttachmentCandidate[],
  sharedPart?: string
): void {
  // A single, non-multipart message has no `part` on its root: its body is
  // part 1 (BODY[1]).
  const partId = node.part ?? (depth === 0 ? '1' : undefined);
  // The sole part of a forwarded single-part message carries the id of the
  // wrapper that holds it. Fetching that id returns the wrapper, not the child,
  // so a second candidate under the same id would be a lie about what it names.
  if (partId === undefined || partId === sharedPart) return;

  const declaredType = (node.type ?? 'application/octet-stream').toLowerCase();
  const type = isMediaType(declaredType)
    ? declaredType
    : 'application/octet-stream';
  const disposition = node.disposition?.toLowerCase();
  const declaredName =
    node.dispositionParameters?.filename ?? node.parameters?.name;

  // A part is an attachment when it says so, or when it carries a filename, or
  // when it is simply not one of the two body types. Inline images count: they
  // are still bytes from a stranger.
  const isBody =
    (type === 'text/plain' || type === 'text/html') &&
    disposition !== 'attachment' &&
    declaredName === undefined;
  if (isBody) return;

  const filename = sanitizeFilename(declaredName);
  const notes: string[] = [];
  if (type !== declaredType) {
    notes.push(
      'the declared content type is not a valid media type and is reported as application/octet-stream'
    );
  }
  if (declaredName !== undefined && DOUBLE_EXTENSION_BAIT.test(declaredName)) {
    notes.push(
      'filename has a double extension — it renders as a document but is not one'
    );
  }
  found.push({
    partId,
    filename,
    contentType: type,
    // imapflow reads the size with `Number(value) || 0`, so a server that
    // writes `1e400` hands over Infinity — which JSON renders as null, and
    // null fails the `size: number` the output schema promises for the whole
    // listing. A size that is not a safe non-negative integer is unknown.
    size:
      Number.isSafeInteger(node.size) && (node.size as number) >= 0
        ? node.size
        : undefined,
    disposition,
    allowed: true,
    notes,
    suspicious:
      declaredName === undefined
        ? []
        : detectSuspicious(stripInvisible(declaredName.normalize('NFKC'))),
  });
}

/**
 * Applies the declaration-level policy.
 *
 * Everything checked here comes from the sender, so a pass means only "nothing
 * in what it claims about itself disqualifies it". The bytes are checked
 * separately in {@link sniffContent} when they are actually fetched.
 */
export function checkPolicy(
  candidate: AttachmentCandidate,
  policy: AttachmentPolicy
): AttachmentCandidate {
  const notes = [...candidate.notes];
  let allowed = true;

  const extension = extensionOf(candidate.filename);
  if (extension !== '' && EXECUTABLE_EXTENSIONS.has(extension)) {
    allowed = false;
    notes.push(`refused: .${extension} is an executable file type`);
  }
  if (!policy.allowedTypes.includes(candidate.contentType)) {
    allowed = false;
    notes.push(
      `refused: content type ${candidate.contentType} is not in the allowlist (IMAP_ATTACHMENT_TYPES)`
    );
  }
  if (candidate.size !== undefined && candidate.size > policy.maxBytes) {
    allowed = false;
    notes.push(
      `refused: declared size ${candidate.size} exceeds ${policy.maxBytesName} (${policy.maxBytes})`
    );
  }

  return { ...candidate, allowed, notes };
}

export interface ContentVerdict {
  executable: boolean;
  detectedType: string | undefined;
}

/**
 * Whether bytes that start with `MZ` are an executable rather than text that
 * happens to begin with those letters (`MZ,Mozambique` in a CSV).
 *
 * A Windows executable has `PE\0\0` — or the older `NE`, `LE`, `LX` — at the
 * offset stored in the little-endian dword at 0x3c. A plain DOS executable has
 * no such header, but its 28-byte `MZ` header is made of 16-bit fields and is
 * never free of control bytes, which text is.
 */
function looksLikeDosExecutable(buffer: Buffer): boolean {
  if (buffer.length >= 0x40) {
    const offset = buffer.readUInt32LE(0x3c);
    if (offset <= buffer.length - 4) {
      const signature = buffer.toString('latin1', offset, offset + 4);
      if (signature === 'PE\0\0' || /^(NE|LE|LX)/.test(signature)) return true;
    }
  }
  const header = buffer.subarray(0, 64);
  return header.some(
    (value) =>
      value < 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0d
  );
}

/**
 * Identifies content by its leading bytes.
 *
 * The declared content type is a claim by the sender; this is the only check
 * that looks at what was actually sent. An executable renamed to `.txt` and
 * declared as `text/plain` passes every other gate and fails here.
 */
export function sniffContent(buffer: Buffer): ContentVerdict {
  const byte = (i: number): number => buffer[i] ?? -1;

  if (byte(0) === 0x4d && byte(1) === 0x5a && looksLikeDosExecutable(buffer)) {
    return { executable: true, detectedType: 'application/x-msdownload' };
  }
  if (
    byte(0) === 0x7f &&
    byte(1) === 0x45 &&
    byte(2) === 0x4c &&
    byte(3) === 0x46
  ) {
    return { executable: true, detectedType: 'application/x-elf' };
  }
  // `>>> 0` is load-bearing: JS bitwise operators produce a *signed* 32-bit
  // result, so without it 0xfeedface arrives as a negative number and none of
  // the Mach-O comparisons below can ever match.
  const magic32 =
    ((byte(0) << 24) | (byte(1) << 16) | (byte(2) << 8) | byte(3)) >>> 0;
  if (
    magic32 === 0xfeedface ||
    magic32 === 0xfeedfacf ||
    // The same two magics as written by a little-endian host: 32-bit and 64-bit
    // Mach-O on Apple silicon and Intel, which is most of them.
    magic32 === 0xcefaedfe ||
    magic32 === 0xcffaedfe ||
    magic32 === 0xcafebabe
  ) {
    return { executable: true, detectedType: 'application/x-mach-binary' };
  }
  if (byte(0) === 0x23 && byte(1) === 0x21) {
    return { executable: true, detectedType: 'text/x-shellscript' };
  }

  const starts = (signature: number[]): boolean =>
    signature.every((value, index) => byte(index) === value);

  if (starts([0x25, 0x50, 0x44, 0x46])) {
    return { executable: false, detectedType: 'application/pdf' };
  }
  if (starts([0x89, 0x50, 0x4e, 0x47])) {
    return { executable: false, detectedType: 'image/png' };
  }
  if (starts([0xff, 0xd8, 0xff])) {
    return { executable: false, detectedType: 'image/jpeg' };
  }
  if (starts([0x47, 0x49, 0x46, 0x38])) {
    return { executable: false, detectedType: 'image/gif' };
  }
  if (
    starts([0x52, 0x49, 0x46, 0x46]) &&
    byte(8) === 0x57 &&
    byte(9) === 0x45 &&
    byte(10) === 0x42 &&
    byte(11) === 0x50
  ) {
    return { executable: false, detectedType: 'image/webp' };
  }
  if (starts([0x50, 0x4b, 0x03, 0x04])) {
    // Also every modern Office and OpenDocument file.
    return { executable: false, detectedType: 'application/zip' };
  }
  return { executable: false, detectedType: undefined };
}

/**
 * What a refusal says about bytes {@link sniffContent} called executable.
 *
 * A script is refused even when it declares `text/plain`: a `#!` line is the
 * kernel's instruction to run the file, and a text type does not change that.
 * The refusal says so, because "executable" next to a `.txt` is otherwise a
 * surprise.
 */
export function describeExecutable(verdict: ContentVerdict): string {
  return verdict.detectedType === 'text/x-shellscript'
    ? 'a script (it starts with "#!", an interpreter line, so it runs as a program even when declared as text)'
    : `an executable (${verdict.detectedType ?? 'unknown type'})`;
}

/**
 * The image type to hand to a client for these bytes, or `undefined`.
 *
 * The declared type is the sender's claim, and a client decodes by the type it
 * is given: `image/png` over bytes that are something else is a request to
 * parse the wrong format. The sniffed type is what the bytes are, and it is
 * used only if it is an image and the operator allows it.
 */
export function imageTypeOf(
  verdict: ContentVerdict,
  allowedTypes: readonly string[]
): string | undefined {
  const detected = verdict.detectedType;
  return detected !== undefined &&
    detected.startsWith('image/') &&
    allowedTypes.includes(detected)
    ? detected
    : undefined;
}

/**
 * The resource URI for one attachment.
 *
 * It carries the mailbox unless it is the default one: a UID means nothing
 * without its mailbox, and the old form read UID n of the default mailbox
 * whichever folder the listing had come from.
 */
export function attachmentUri(
  uid: number,
  partId: string,
  mailbox: string,
  defaultMailbox: string
): string {
  const base = `imap://message/${uid}/part/${partId}`;
  return mailbox === defaultMailbox
    ? base
    : `${base}?mailbox=${encodeURIComponent(mailbox)}`;
}
