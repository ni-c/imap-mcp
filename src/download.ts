import { open, unlink } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

import { ToolInputError } from './errors.js';

/** How many `name (2).pdf`, `name (3).pdf` … variants are tried. */
const MAX_COLLISION_ATTEMPTS = 50;

export interface SavedAttachment {
  path: string;
  bytes: number;
}

/**
 * Writes an attachment into the configured download directory.
 *
 * Everything here exists because this is the first point in the server where
 * bytes from a stranger get a name in the filesystem:
 *
 * - The directory comes only from `IMAP_DOWNLOAD_DIR`. A caller — and therefore
 *   a message that talked the model into a tool call — cannot choose where
 *   anything lands.
 * - The filename is already stripped of path separators and directional
 *   overrides by `sanitizeFilename`, but the resolved path is checked against
 *   the directory anyway, because one guard is not a guard.
 * - `wx` refuses to open an existing path. That covers two attacks at once:
 *   overwriting a file the user cares about, and following a symlink somebody
 *   planted under a predictable attachment name.
 * - Mode 0600, because the content is untrusted and possibly confidential at
 *   the same time.
 */
export async function saveAttachment(
  directory: string,
  filename: string,
  content: Buffer
): Promise<SavedAttachment> {
  const base = resolve(directory);
  const extension = extname(filename);
  const stem =
    extension === '' ? filename : filename.slice(0, -extension.length);

  for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt += 1) {
    const candidate =
      attempt === 1 ? filename : `${stem} (${attempt})${extension}`;
    const target = resolve(join(base, candidate));

    // The sanitizer should already have made this impossible; if it ever stops
    // being true, the write must not be the place where that is discovered.
    if (target !== base && !target.startsWith(base + sep)) {
      throw new ToolInputError(
        'imap-mcp: refused to write outside the configured download directory.'
      );
    }

    let handle;
    try {
      handle = await open(target, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw new ToolInputError(
        `imap-mcp: could not write to the download directory: ${describe(error)}`
      );
    }
    try {
      // writeFile loops until everything is written. A single write() may
      // write fewer bytes than asked and says so only in its return value,
      // which left a truncated file behind a "saved" answer.
      await handle.writeFile(content);
      await handle.close();
      return { path: target, bytes: content.length };
    } catch (error) {
      // The file was created by this call (`wx`), so removing it cannot take
      // anything else with it. A partial attachment under the real name is
      // worse than none.
      await handle.close().catch(() => undefined);
      await unlink(target).catch(() => undefined);
      throw new ToolInputError(
        `imap-mcp: could not write to the download directory: ${describe(error)}`
      );
    }
  }

  throw new ToolInputError(
    `imap-mcp: ${MAX_COLLISION_ATTEMPTS} files with this name already exist in the download directory.`
  );
}

function describe(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return 'the directory does not exist';
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'ENOSPC') return 'no space left on the device';
  return code ?? 'unknown error';
}
