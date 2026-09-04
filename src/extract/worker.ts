import { parentPort, workerData } from 'node:worker_threads';

import type { ExtractRequest, ExtractResponse } from './types.js';

/**
 * The extraction worker: the only code in this server that parses a binary a
 * stranger sent, and the reason it runs somewhere that can be terminated.
 *
 * Read the import rules before editing this file. It is started from its own
 * source — `worker.ts` under vitest, which runs the TypeScript directly, and
 * `worker.js` from `dist/` in production — so Node loads it and everything it
 * reaches, without vitest's resolver. Node strips types; it does not rewrite a
 * `./x.js` specifier to the `./x.ts` sitting beside it. So:
 *
 * - static imports here may only be bare specifiers (`node:*`, a package) or
 *   `import type`, which is erased before it can fail to resolve;
 * - anything relative is loaded through {@link sibling}, which picks the
 *   extension from this module's own;
 * - no enums, no namespaces, no parameter properties — type stripping cannot
 *   erase syntax that emits code.
 *
 * Get this wrong in one direction and every test fails while the build stays
 * green; get it wrong in the other and every test passes while the published
 * package throws on first use. The second is why `npm run build` is followed by
 * a real extraction against `dist/`.
 */
const EXTENSION = import.meta.url.endsWith('.ts') ? 'ts' : 'js';

function sibling(path: string): string {
  return new URL(`${path}.${EXTENSION}`, import.meta.url).href;
}

async function run(request: ExtractRequest): Promise<ExtractResponse> {
  if (request.kind === 'pdf') {
    const { extractPdf } = (await import(
      sibling('./pdf')
    )) as typeof import('./pdf.js');
    return extractPdf(request.bytes, request.maxChars);
  }
  const [{ extractZipDocument }, { htmlToText }] = await Promise.all([
    import(sibling('./ooxml')) as Promise<typeof import('./ooxml.js')>,
    import(sibling('../analyze')) as Promise<typeof import('../analyze.js')>,
  ]);
  return extractZipDocument(
    request.kind,
    request.bytes,
    request.maxChars,
    htmlToText
  );
}

if (parentPort) {
  const port = parentPort;
  run(workerData as ExtractRequest).then(
    (response) => {
      port.postMessage(response);
    },
    () => {
      // Never the caught error. pdf.js and fflate quote the document in their
      // exception messages — byte offsets, object fragments, what they found
      // where they expected something else. That is text a stranger wrote, and
      // an error message is read as the server's own voice, outside the fence
      // every other piece of message content passes through. A code crosses;
      // the words are the host's.
      port.postMessage({
        ok: false,
        reason: 'internal',
      } satisfies ExtractResponse);
    }
  );
}
