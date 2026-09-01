import { randomBytes } from 'node:crypto';

import {
  CLIENT_CAPABILITIES_META_KEY,
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
} from '@modelcontextprotocol/server';
import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  ServerContext,
} from '@modelcontextprotocol/server';

import {
  confirmationPrompt,
  renderDetails,
  type ConfirmationDetail,
  type ConfirmationStore,
} from './confirm.js';

import { ToolInputError } from './errors.js';
import { textResult } from './result.js';

export interface ApprovalRequest {
  /** What is about to happen, in server-side facts only. */
  what: string;
  /** Why it cannot be undone. */
  consequence: string;
  /** Stable key binding the fallback token to this exact target set. */
  resourceKey: string;
  /** Token the caller supplied, if any. Only used on the fallback path. */
  token: string | undefined;
  /**
   * Names the caller chose — mailboxes above all. Rendered on their own labelled
   * lines rather than inside {@link what}, so a folder named to read like an
   * instruction cannot become part of the server's sentence.
   */
  details?: readonly ConfirmationDetail[];
}

/**
 * Either something to return to the caller instead of acting, or permission to
 * proceed.
 *
 * The result is a question as often as it is an answer: on the 2026-07-28
 * revision asking a human IS a result, and the caller retries the same tool
 * call once they have replied.
 */
export type ApprovalOutcome =
  | { approved: true }
  | { approved: false; result: CallToolResult | InputRequiredResult };

/** The dialog, in one place because it is shown to a person. */
const CONFIRM_SCHEMA = {
  type: 'object' as const,
  properties: {
    confirm: {
      type: 'boolean' as const,
      title: 'Proceed?',
      description: 'Tick to allow this operation, leave it to cancel.',
    },
  },
  required: ['confirm'],
};

/** The key under which the answer comes back. One question, one key. */
const CONFIRM_KEY = 'confirm';

/**
 * Integrity for the state that rides through the client and comes back.
 *
 * `inputResponses` on re-entry is attacker-controlled input — the SDK says so
 * and validates none of it. Without a seal, an accepted answer could simply be
 * asserted, and the whole point of asking a human would be a formality. The
 * spec makes protecting this a MUST for state that decides an authorization,
 * which is exactly what this is.
 *
 * The key is drawn once per process. A stdio server is spawned per session, so
 * the process is the flow; when it ends there is no half-finished operation to
 * resume. Behind mcp-hub a child that gets put to sleep between two rounds
 * comes back with a new key — which is why a state that fails to open is
 * answered with a fresh question rather than an error (see `readAnswer`).
 */
const stateCodec = createRequestStateCodec<{ key: string }>({
  key: randomBytes(32),
  ttlSeconds: 900,
  // Both halves of "this state belongs to this call": the method it was minted
  // under and, where there is one, the authenticated caller.
  bind: (ctx) => `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? ''}`,
});

/**
 * Asks a human before an irreversible operation.
 *
 * Why this exists next to {@link ConfirmationStore}: the confirmation token is
 * not a human-in-the-loop gate and never was. It is returned inside a tool
 * result, which means the model reads it and can call again in the same turn
 * without anyone seeing the dialog. That still catches a model that widens the
 * target set by accident, but a model which has been talked into deleting the
 * mailbox will happily call twice.
 *
 * MCP elicitation closes that hole: the request goes to the client, which shows
 * it to the person sitting there, and the model cannot answer on their behalf.
 * Clients that cannot be asked fall back to the token, because refusing to work
 * at all would push people towards turning the guard off entirely.
 *
 * The question is *returned*, not pushed. On the 2026-07-28 revision there is
 * no server→client request channel at all: the handler answers
 * `input_required`, the call ends, the person decides, and the client retries
 * carrying the answer. On a 2025 connection the SDK's legacy shim turns the
 * same return into the push it used to be — so this is written once and serves
 * both eras, which `elicitInput()` could not do: it throws outright on a
 * 2026-era request.
 */
export async function requestApproval(
  server: McpServer,
  ctx: ServerContext,
  confirmations: ConfirmationStore,
  request: ApprovalRequest
): Promise<ApprovalOutcome> {
  const answer = await readAnswer(ctx, request);
  if (answer === 'accepted') return { approved: true };
  if (answer === 'declined') {
    throw new ToolInputError(
      'imap-mcp: the user declined. Nothing was changed.'
    );
  }

  if (canAsk(server, ctx)) {
    return { approved: false, result: await ask(ctx, request) };
  }

  if (confirmations.consume(request.resourceKey, request.token)) {
    return { approved: true };
  }
  return {
    approved: false,
    result: textResult(
      `${confirmationPrompt(
        request.what,
        confirmations.issue(request.resourceKey),
        confirmations.ttlMinutes,
        request.consequence,
        request.details ?? []
      )}\n\nNote: this client cannot ask the user directly, so this check only ` +
        'proves the call was made twice with the same arguments. A human should ' +
        'read the line above before you continue.'
    ),
  };
}

/**
 * What the person said, if this round carries their reply at all.
 *
 * `none` covers two different situations that want the same treatment: nobody
 * has been asked yet, and a reply arrived that this server cannot prove it
 * asked for. Re-asking is the right answer to both — the alternative for the
 * second is an error code nobody can act on, and the most likely cause of it is
 * innocent (a gateway put the server to sleep while the person was reading).
 */
async function readAnswer(
  ctx: ServerContext,
  request: ApprovalRequest
): Promise<'accepted' | 'declined' | 'none'> {
  const responses = ctx.mcpReq.inputResponses;
  if (!responses || !(CONFIRM_KEY in responses)) return 'none';

  const state = ctx.mcpReq.requestState<string>();
  if (typeof state !== 'string' || !(await mintedHere(state, ctx, request))) {
    return 'none';
  }

  // Anything but an accept — declined, cancelled, malformed — is a no. Only a
  // ticked box is a yes.
  const content = acceptedContent(responses, CONFIRM_KEY) as
    { confirm?: unknown } | undefined;
  if (content === undefined) return 'declined';
  return content.confirm === true ? 'accepted' : 'declined';
}

/** Whether this server minted that state, for this exact target set. */
async function mintedHere(
  state: string,
  ctx: ServerContext,
  request: ApprovalRequest
): Promise<boolean> {
  try {
    const payload = await stateCodec.verify(state, ctx);
    return payload.key === request.resourceKey;
  } catch {
    // The reason is a fixed opaque code by design and says nothing worth
    // logging; what matters is that an unproven state grants nothing.
    return false;
  }
}

/**
 * Whether this caller can be asked anything at all.
 *
 * Two places to look, one per era. On 2026 the capabilities ride the request's
 * own `_meta` envelope, which is what makes a stateless gateway able to speak
 * for the client it is currently serving. On a 2025 connection they were
 * declared once at `initialize`. A per-request legacy instance behind a
 * stateless proxy has neither, and correctly reports that nobody can be asked.
 */
function canAsk(server: McpServer, ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY] as
    { elicitation?: unknown } | undefined;
  if (declared?.elicitation !== undefined) return true;
  return server.server.getClientCapabilities()?.elicitation !== undefined;
}

async function ask(
  ctx: ServerContext,
  request: ApprovalRequest
): Promise<InputRequiredResult> {
  return inputRequired({
    inputRequests: {
      [CONFIRM_KEY]: inputRequired.elicit({
        // Server-side facts only: no subject, sender or body reaches this
        // string. It is rendered to a human, but it is composed by us — and
        // the caller-chosen names go through renderDetails rather than into
        // the sentence, so none of it is a place to hide an instruction.
        message:
          `${request.what}\n\n${request.consequence}` +
          renderDetails(request.details ?? []),
        requestedSchema: CONFIRM_SCHEMA,
      }),
    },
    requestState: await stateCodec.mint({ key: request.resourceKey }, ctx),
  });
}
