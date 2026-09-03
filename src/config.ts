/** How the IMAP connection is encrypted. */
export type TlsMode = 'implicit' | 'starttls' | 'none';

export interface ImapConfig {
  host: string | undefined;
  port: number;
  user: string | undefined;
  password: string | undefined;
  tls: TlsMode;
  insecureTls: boolean;
  /** Mailbox the message tools default to. */
  mailbox: string;
  /**
   * Custom IMAP keyword marking messages already handed to the model. Empty
   * means the feature is off and `list_new_messages` is not registered.
   */
  seenKeyword: string;
  /** Overrides the folder auto-detected from the \Drafts special-use flag. */
  draftsMailbox: string | undefined;
  /**
   * The authserv-id this account's own provider stamps into
   * Authentication-Results. Only a header carrying it is treated as
   * non-forgeable; unset, every SPF/DKIM/DMARC verdict is reported as forgeable,
   * because a sender can write that header too and nothing in the message
   * distinguishes theirs from the provider's.
   */
  trustedAuthservId: string | undefined;
  maxMessages: number;
  maxAttachmentBytes: number;
  allowedAttachmentTypes: string[];
  /**
   * Where attachments may be written. Unset means this server never touches the
   * filesystem — setting it is the opt-in, and it is the only source of the
   * target directory. A caller cannot choose where bytes from a stranger land.
   */
  downloadDir: string | undefined;
  maxDownloadBytes: number;
}

export interface Config {
  imap: ImapConfig;
  /**
   * When true — the default — the mailbox write tools are not registered.
   *
   * Note the default, which is the opposite of every other server in this
   * family. This variable replaced `IMAP_ALLOW_WRITE`, and that one was opt-in:
   * setting nothing meant no write access to a mailbox. Renaming it without
   * keeping that default would have handed write access to every installation
   * that upgraded without reading the changelog. The name is now shared with
   * the rest of the family; the default deliberately is not.
   */
  readOnly: boolean;
  /**
   * Whether a client that *can* show a dialog is asked before a guarded tool
   * acts. `ELICITATION=false` turns the dialog off — the guard stays and falls
   * back to the two-call token, so there is no setting in which a guarded call
   * goes unannounced.
   */
  elicitation: boolean;

  /**
   * Raw value of `IMAP_ALLOW_TOOLS` — comma-separated tool names, `list_*`
   * prefixes, or `essential`. Kept unparsed on purpose: this file is a mirror
   * of the environment, and the names can only be checked against the tool
   * catalogue, which `buildToolFilter` does.
   */
  allowTools: string | undefined;
  /** Raw value of `IMAP_DENY_TOOLS`, same shape, subtracted from the above. */
  denyTools: string | undefined;
}

export const DEFAULT_ATTACHMENT_TYPES = [
  'application/pdf',
  'application/json',
  'application/xml',
  'application/zip',
  'application/rtf',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'text/html',
  'text/calendar',
];

const DEFAULT_MAX_MESSAGES = 100;
/** Inline cap: this one protects the model's context window. */
const DEFAULT_MAX_ATTACHMENT_BYTES = 1024 * 1024;
/** Disk cap: this one protects the filesystem, which is a different concern. */
const DEFAULT_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_SEEN_KEYWORD = 'AiSeen';

/** Shown when the configuration is incomplete — at startup and on every call. */
export function missingConfigMessage(missing: string[]): string {
  return (
    `missing required environment variable(s): ${missing.join(', ')}\n` +
    'Required: IMAP_HOST (e.g. imap.example.net), IMAP_USER, IMAP_PASSWORD\n' +
    'Optional: IMAP_PORT, IMAP_TLS (implicit|starttls|none), IMAP_MAILBOX, ' +
    'IMAP_SEEN_KEYWORD, IMAP_READ_ONLY=false to expose the mailbox write ' +
    'tools (it defaults to true), IMAP_ALLOW_TOOLS / IMAP_DENY_TOOLS to narrow ' +
    'the tool list, IMAP_DOWNLOAD_DIR to allow saving attachments to disk, ' +
    'IMAP_INSECURE_TLS=true to accept self-signed certificates'
  );
}

/** Names of the required environment variables that are unset in `config`. */
export function missingConfigKeys(config: Config): string[] {
  return [
    !config.imap.host && 'IMAP_HOST',
    !config.imap.user && 'IMAP_USER',
    !config.imap.password && 'IMAP_PASSWORD',
  ].filter((v): v is string => Boolean(v));
}

/**
 * Reads the configuration from environment variables.
 *
 * Missing credentials are only a warning, not a fatal error: the server must be
 * able to complete the MCP handshake and answer `tools/list` without them, so
 * registries and sandbox inspectors can introspect it. Malformed values still
 * exit — a host with a newline in it could smuggle a second command into the
 * IMAP session, and a bad port would connect somewhere unintended.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.IMAP_HOST;
  const user = env.IMAP_USER;
  const password = env.IMAP_PASSWORD;

  // Removed here, before any branch below can return or exit: the password must
  // not stay in the environment for the process lifetime, where it is visible
  // to child processes and in /proc/<pid>/environ.
  delete env.IMAP_PASSWORD;

  const tls = parseTlsMode(env.IMAP_TLS);
  // After the password delete, deliberately: this one can exit the process, and
  // an exit above the delete would leave the password in the environment for
  // whatever runs next.
  const elicitation = parseElicitation(env.ELICITATION);

  if (host !== undefined) assertSafeHost(host, 'IMAP_HOST');
  const draftsMailbox = env.IMAP_DRAFTS_MAILBOX;
  if (draftsMailbox !== undefined) {
    assertSingleLine(draftsMailbox, 'IMAP_DRAFTS_MAILBOX');
  }
  const trustedAuthservId = env.IMAP_TRUSTED_AUTHSERV_ID?.trim() || undefined;
  if (trustedAuthservId !== undefined) {
    assertSingleLine(trustedAuthservId, 'IMAP_TRUSTED_AUTHSERV_ID');
  }

  const config: Config = {
    imap: {
      host,
      port: parsePort(
        env.IMAP_PORT,
        tls === 'implicit' ? 993 : 143,
        'IMAP_PORT'
      ),
      user,
      password,
      tls,
      insecureTls: env.IMAP_INSECURE_TLS === 'true',
      mailbox: env.IMAP_MAILBOX || 'INBOX',
      seenKeyword: parseKeyword(env.IMAP_SEEN_KEYWORD),
      draftsMailbox,
      trustedAuthservId,
      maxMessages: parseCount(
        env.IMAP_MAX_MESSAGES,
        DEFAULT_MAX_MESSAGES,
        'IMAP_MAX_MESSAGES'
      ),
      maxAttachmentBytes: parseCount(
        env.IMAP_MAX_ATTACHMENT_BYTES,
        DEFAULT_MAX_ATTACHMENT_BYTES,
        'IMAP_MAX_ATTACHMENT_BYTES'
      ),
      allowedAttachmentTypes: parseTypes(env.IMAP_ATTACHMENT_TYPES),
      downloadDir: env.IMAP_DOWNLOAD_DIR,
      maxDownloadBytes: parseCount(
        env.IMAP_MAX_DOWNLOAD_BYTES,
        DEFAULT_MAX_DOWNLOAD_BYTES,
        'IMAP_MAX_DOWNLOAD_BYTES'
      ),
    },
    // Defaults to true, unlike the rest of the family — see the field comment.
    readOnly: env.IMAP_READ_ONLY !== 'false',
    elicitation,
    allowTools: env.IMAP_ALLOW_TOOLS,
    denyTools: env.IMAP_DENY_TOOLS,
  };

  // Silently ignoring a removed security variable is the worst of the options:
  // whoever set it once believes it is still in force. IMAP_ALLOW_WRITE=true
  // used to be the only way to reach the write tools, so an installation that
  // still sets it is one that wants them — and would otherwise get a read-only
  // server without being told why.
  if (env.IMAP_ALLOW_WRITE !== undefined) {
    console.error(
      'imap-mcp: IMAP_ALLOW_WRITE has been replaced by IMAP_READ_ONLY. Set ' +
        'IMAP_READ_ONLY=false for the write tools, or unset IMAP_ALLOW_WRITE ' +
        'to keep the read-only default.'
    );
    process.exit(1);
  }

  const missing = missingConfigKeys(config);
  if (missing.length > 0) {
    console.error(`imap-mcp: ${missingConfigMessage(missing)}`);
  }
  if (config.imap.tls === 'none' && !isLoopbackHost(host)) {
    console.error(
      'imap-mcp: WARNING: IMAP_TLS=none against a non-local host — the password ' +
        'and every message will cross the network unencrypted.'
    );
  }

  return config;
}

function parseTlsMode(raw: string | undefined): TlsMode {
  if (raw === undefined || raw === '') return 'implicit';
  if (raw === 'implicit' || raw === 'starttls' || raw === 'none') return raw;
  console.error('imap-mcp: IMAP_TLS must be one of implicit, starttls or none');
  process.exit(1);
}

/**
 * Reads `ELICITATION` — deliberately unprefixed, and deliberately fatal on
 * anything it does not recognise.
 *
 * Unprefixed: environment variables are process-wide, so this is one switch for
 * every server in the same environment. That is also its risk, which is why a
 * server started with it off says so on its startup line.
 *
 * Fatal, like `parseTlsMode` above and unlike `IMAP_READ_ONLY`: this is the
 * first variable of the family that defaults to *on*, so a typo that fell back
 * to the default would leave the dialog running while the operator believes it
 * is off — and an operator who believes that has no way to find out.
 */
export function parseElicitation(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  console.error(
    `imap-mcp: ELICITATION must be "true" or "false" — got "${raw}". ` +
      'Refusing to start rather than guess.'
  );
  process.exit(1);
}

function parsePort(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    // The value itself is not echoed: config errors end up in logs.
    console.error(`imap-mcp: ${name} must be an integer between 1 and 65535`);
    process.exit(1);
  }
  return value;
}

function parseCount(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`imap-mcp: ${name} must be a positive integer`);
    process.exit(1);
  }
  return value;
}

/**
 * An IMAP keyword is an atom: no spaces and none of the characters that would
 * end it early or open a literal. Empty turns the new-mail tracking off.
 */
function parseKeyword(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_SEEN_KEYWORD;
  if (raw === '') return '';
  if (!/^[A-Za-z0-9$_.-]+$/.test(raw)) {
    console.error(
      'imap-mcp: IMAP_SEEN_KEYWORD must consist of letters, digits, $, _, . or -'
    );
    process.exit(1);
  }
  return raw;
}

function parseTypes(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ATTACHMENT_TYPES;
  return raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== '');
}

/**
 * Rejects anything that could break out of the line it is written on. IMAP is a
 * line protocol; a CR or LF in a hostname is a command-smuggling primitive, not
 * a typo.
 */
function assertSafeHost(value: string, name: string): void {
  // A hostname or IPv4 address — or an IPv6 address, which is the only place
  // a colon is legal. Allowing ":" everywhere would silently accept
  // "imap.example.net:993", which the error message promises to reject.
  const hostname = /^[A-Za-z0-9._-]+$/.test(value);
  const ipv6 = /^\[?[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*\]?$/.test(value);
  if (!hostname && !ipv6) {
    console.error(
      `imap-mcp: ${name} must be a plain hostname or IP address without ` +
        'scheme, port, credentials or whitespace'
    );
    process.exit(1);
  }
}

/** Spaces are fine in a mailbox name; a line break would end the command. */
function assertSingleLine(value: string, name: string): void {
  if (/[\r\n]/.test(value)) {
    console.error(`imap-mcp: ${name} must not contain line breaks`);
    process.exit(1);
  }
}

function isLoopbackHost(hostname: string | undefined): boolean {
  // URL.hostname keeps the brackets around an IPv6 literal, may carry a %zone
  // suffix, and 'localhost.' with its root label is the same name as
  // 'localhost'. The comparison this replaced saw none of them — which is why
  // its bare '::1' branch could never match a hostname taken from a URL.
  if (hostname === undefined) return false;
  const host = hostname
    .toLowerCase()
    .replace(/^\[|]$/g, '')
    .replace(/%.*$/, '')
    .replace(/\.+$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.startsWith('127.') ||
    host === '::1' ||
    // Every dual-stack client dials ::ffff:127.0.0.1 as plain 127.0.0.1, and
    // URL normalises the mapped form to hex (::ffff:7f00:1).
    /^::ffff:(?:7f[0-9a-f]{0,2}:|127\.)/.test(host)
  );
}
