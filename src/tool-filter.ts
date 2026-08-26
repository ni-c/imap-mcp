import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ALL_TOOLS, ESSENTIAL_TOOLS, READ_TOOLS } from './tools/catalogue.js';

/**
 * A tool list that names something this server does not have.
 *
 * Thrown rather than `process.exit(1)`: `createServer` is called in-process by
 * the tests, and an exiting constructor cannot be tested. `src/index.ts` turns
 * it back into an exit code.
 */
export class ToolFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolFilterError';
  }
}

export interface ToolFilter {
  /** False when neither variable was set — then nothing is wrapped at all. */
  readonly active: boolean;
  /** The tools that survive. Only meaningful while `active`. */
  readonly selected: ReadonlySet<string>;
}

/** The `essential` preset is spelled out here so it cannot collide with a tool name. */
const PRESET = 'essential';

/**
 * Splits a comma-separated value into entries.
 *
 * Empty entries are dropped, so `a,,b` and a trailing comma are both fine, and
 * a value that is empty or only whitespace counts as *unset* — `X_ALLOW_TOOLS=`
 * in a compose file must not mean "allow nothing". Entries are lowercased: the
 * catalogue is entirely lowercase, so this is lossless, and a shell that
 * upper-cased a name should not take the server down.
 */
function entriesOf(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const entries = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

/**
 * Expands one entry to the catalogue tools it names.
 *
 * A pattern is a literal prefix plus exactly one trailing `*`. Anything else is
 * rejected outright: `*_zone` and `list_*_x` look plausible, match nothing, and
 * would otherwise be silent forever.
 */
function expand(entry: string, variable: string): string[] {
  const star = entry.indexOf('*');
  if (star !== -1) {
    if (star !== entry.length - 1) {
      throw new ToolFilterError(
        `${variable}: "${entry}" is not a valid entry — a pattern is a prefix ` +
          'followed by a single trailing "*", for example "list_*". Everything ' +
          'else is an exact tool name.'
      );
    }
    const prefix = entry.slice(0, -1);
    return ALL_TOOLS.filter((tool) => tool.startsWith(prefix));
  }
  return ALL_TOOLS.filter((tool) => tool === entry);
}

/** The full catalogue, for the "these are the names that exist" half of an error. */
function catalogueList(): string {
  return [...ALL_TOOLS].sort().join(', ');
}

/**
 * Reads `<PREFIX>_ALLOW_TOOLS` / `<PREFIX>_DENY_TOOLS` and works out which
 * tools survive.
 *
 * Every entry has to match at least one tool in the catalogue. An entry that
 * matches nothing is fatal rather than ignored, because the failure it produces
 * otherwise — a tool quietly missing from `tools/list` — is invisible: nobody
 * looks for the cause of an absence in an environment variable.
 */
export function buildToolFilter(config: {
  allowTools: string | undefined;
  denyTools: string | undefined;
  readOnly: boolean;
}): ToolFilter {
  const allow = entriesOf(config.allowTools);
  const deny = entriesOf(config.denyTools);
  if (allow === undefined && deny === undefined) {
    return { active: false, selected: new Set() };
  }

  // What would be registered without any filter. In read-only mode the write
  // tools never reach `registerTool`, but they stay in the catalogue so that a
  // name from that half is answered with "read-only suppresses it", never with
  // "no such tool".
  const registered = new Set<string>(
    config.readOnly ? READ_TOOLS : (ALL_TOOLS as readonly string[])
  );

  // Set when an allow entry named real tools and read-only suppressed all of
  // them, so that "nothing is left" can name the reason rather than shrugging.
  let suppressedByReadOnly = false;

  let selected: Set<string>;
  if (allow === undefined) {
    selected = new Set(registered);
  } else {
    selected = new Set<string>();
    for (const entry of allow) {
      if (entry === PRESET) {
        // Preset members are not names the operator typed, so a member that
        // read-only suppresses is dropped silently rather than being an error.
        for (const tool of ESSENTIAL_TOOLS) {
          if (registered.has(tool)) selected.add(tool);
        }
        continue;
      }

      const matches = expand(entry, 'IMAP_ALLOW_TOOLS');
      if (matches.length === 0) {
        throw new ToolFilterError(
          `IMAP_ALLOW_TOOLS: no tool matches "${entry}". ` +
            `Valid tools: ${catalogueList()}. "${PRESET}" selects the curated preset.`
        );
      }

      const survivors = matches.filter((tool) => registered.has(tool));
      if (survivors.length === 0) {
        if (entry.endsWith('*')) {
          // A pattern is a template, not a claim about one tool: warn, continue.
          console.error(
            `imap-mcp: IMAP_ALLOW_TOOLS: "${entry}" matches only write ` +
              'tools, which IMAP_READ_ONLY suppresses — it contributes nothing.'
          );
          suppressedByReadOnly = true;
          continue;
        }
        // An exact name, though, was typed by someone who believes it is exposed.
        throw new ToolFilterError(
          `IMAP_ALLOW_TOOLS: "${entry}" is a write tool, but IMAP_READ_ONLY ` +
            'is set — it is never registered. Remove it from IMAP_ALLOW_TOOLS, ' +
            `or unset IMAP_READ_ONLY. Available in read-only mode: ${[...READ_TOOLS].sort().join(', ')}.`
        );
      }
      for (const tool of survivors) selected.add(tool);
    }
  }

  for (const entry of deny ?? []) {
    // Deny lists are written defensively — "never expose delete_*, whatever
    // else is on" — so matching nothing that survives is fine. Matching nothing
    // in the catalogue is still a typo.
    const matches = expand(entry, 'IMAP_DENY_TOOLS');
    if (matches.length === 0) {
      throw new ToolFilterError(
        `IMAP_DENY_TOOLS: no tool matches "${entry}". Valid tools: ${catalogueList()}.`
      );
    }
    for (const tool of matches) selected.delete(tool);
  }

  if (selected.size === 0) {
    throw new ToolFilterError(
      suppressedByReadOnly
        ? 'IMAP_ALLOW_TOOLS selects only write tools, but IMAP_READ_ONLY is ' +
            'set — the server would start with an empty tool list.'
        : 'IMAP_ALLOW_TOOLS/IMAP_DENY_TOOLS leave no tools registered — the ' +
            'server would start with an empty tool list.'
    );
  }

  return { active: true, selected };
}

/**
 * Makes `server` register only the tools the filter selected.
 *
 * The tool is registered and then removed again rather than skipped. Skipping
 * looks cheaper and breaks one case: the SDK installs its `tools/list` handler
 * from inside the registration path, so a server whose every tool was skipped
 * would answer `tools/list` with "method not found" instead of an empty list.
 * `remove()` deletes the entry from the SDK's tool map outright, which makes a
 * filtered tool answer `Tool X not found` — exactly what a tool the read-only
 * mode never registered already does. `disable()` would be wrong: it hides the
 * tool from `tools/list` but still answers a call with "disabled", which is the
 * advertising-a-refusal this server avoids everywhere else.
 */
export function installToolFilter(server: McpServer, filter: ToolFilter): void {
  if (!filter.active) return;
  const register = server.registerTool.bind(server);
  // An object literal rather than a plain function so the method picks up the
  // SDK's generic signature by contextual typing — the call sites keep their
  // typed handler arguments and nothing needs a cast.
  const wrapper: Pick<McpServer, 'registerTool'> = {
    registerTool(name, config, cb) {
      const tool = register(name, config, cb);
      if (!filter.selected.has(name)) tool.remove();
      return tool;
    },
  };
  server.registerTool = wrapper.registerTool;
}
