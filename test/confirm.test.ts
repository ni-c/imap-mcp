import { describe, expect, it } from 'vitest';

import {
  ConfirmationStore,
  confirmationPrompt,
  setResourceKey,
} from '../src/confirm.js';

describe('ConfirmationStore', () => {
  it('issues a token that is not guessable', () => {
    const store = new ConfirmationStore();
    const token = store.issue('delete:1');
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(store.issue('delete:1')).not.toBe(token);
  });

  it('accepts the token exactly once', () => {
    const store = new ConfirmationStore();
    const token = store.issue('delete:1');
    expect(store.consume('delete:1', token)).toBe(true);
    expect(store.consume('delete:1', token)).toBe(false);
  });

  it('rejects a missing, wrong or foreign token', () => {
    const store = new ConfirmationStore();
    const token = store.issue('delete:1');
    expect(store.consume('delete:1', undefined)).toBe(false);
    expect(store.consume('delete:1', 'deadbeef')).toBe(false);
    expect(store.consume('delete:2', token)).toBe(false);
  });

  it('rejects a token for a resource that was never issued', () => {
    expect(new ConfirmationStore().consume('delete:1', 'abc')).toBe(false);
  });

  it('expires the token', async () => {
    const store = new ConfirmationStore(1);
    const token = store.issue('delete:1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.consume('delete:1', token)).toBe(false);
  });

  it('replaces the pending token when re-issued', () => {
    const store = new ConfirmationStore();
    const first = store.issue('delete:1');
    store.issue('delete:1');
    expect(store.consume('delete:1', first)).toBe(false);
  });

  it('stays bounded under a flood of refused calls', () => {
    const store = new ConfirmationStore();
    const first = store.issue('delete:0');
    for (let i = 1; i <= 200; i += 1) store.issue(`delete:${i}`);
    expect(store.consume('delete:0', first)).toBe(false);
    // The most recent one still works, so the eviction takes the oldest.
    const last = store.issue('delete:999');
    expect(store.consume('delete:999', last)).toBe(true);
  });

  it('reports the TTL in whole minutes', () => {
    expect(new ConfirmationStore(5 * 60 * 1000).ttlMinutes).toBe(5);
  });
});

describe('setResourceKey', () => {
  it('is stable regardless of order', () => {
    expect(setResourceKey('delete', ['2', '1'])).toBe(
      setResourceKey('delete', ['1', '2'])
    );
  });

  it('does not mutate the caller list', () => {
    const targets = ['2', '1'];
    setResourceKey('delete', targets);
    expect(targets).toEqual(['2', '1']);
  });

  it('changes when a target is added', () => {
    // The attack this prevents: the model confirms deleting [1] and then calls
    // again with [1, 2]. Only the operation name would have matched.
    expect(setResourceKey('delete', ['1'])).not.toBe(
      setResourceKey('delete', ['1', '2'])
    );
  });

  it('changes when the operation changes', () => {
    expect(setResourceKey('delete', ['1'])).not.toBe(
      setResourceKey('move', ['1'])
    );
  });

  it('is not usable across UID sets end to end', () => {
    const store = new ConfirmationStore();
    const token = store.issue(setResourceKey('delete_messages:INBOX', ['1']));
    expect(
      store.consume(setResourceKey('delete_messages:INBOX', ['1', '2']), token)
    ).toBe(false);
  });
});

describe('confirmationPrompt', () => {
  it('names the token, the TTL and the consequence', () => {
    const text = confirmationPrompt(
      'delete 3 message(s) from "INBOX"',
      'abc123',
      5,
      'They are expunged, not moved to Trash.'
    );
    expect(text).toContain('confirm_token="abc123"');
    expect(text).toContain('5 minutes');
    expect(text).toContain('expunged');
  });

  it('defaults to the irreversible wording', () => {
    expect(confirmationPrompt('do a thing', 't', 5)).toContain('irreversible');
  });
});
