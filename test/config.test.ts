import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadConfig,
  missingConfigKeys,
  missingConfigMessage,
} from '../src/config.js';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    IMAP_HOST: 'imap.example.net',
    IMAP_USER: 'me@example.net',
    IMAP_PASSWORD: 'secret-password',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadConfig', () => {
  it('reads the defaults', () => {
    const config = loadConfig(env());
    expect(config.imap.host).toBe('imap.example.net');
    expect(config.imap.port).toBe(993);
    expect(config.imap.tls).toBe('implicit');
    expect(config.imap.mailbox).toBe('INBOX');
    expect(config.imap.seenKeyword).toBe('AiSeen');
    expect(config.imap.maxMessages).toBe(100);
    expect(config.allowWrite).toBe(false);
    expect(config.imap.downloadDir).toBeUndefined();
  });

  it('removes the password from the environment', () => {
    const environment = env();
    loadConfig(environment);
    expect(environment.IMAP_PASSWORD).toBeUndefined();
  });

  it('removes the password even when the rest of the config is missing', () => {
    // The early return for "no host" used to run before the delete in an
    // earlier project; a token then survived on exactly the failure path.
    const environment: NodeJS.ProcessEnv = { IMAP_PASSWORD: 'secret-password' };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(environment);
    expect(environment.IMAP_PASSWORD).toBeUndefined();
    expect(errors).toHaveBeenCalled();
  });

  it('starts without credentials and only warns', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig({});
    expect(config.imap.host).toBeUndefined();
    expect(missingConfigKeys(config)).toEqual([
      'IMAP_HOST',
      'IMAP_USER',
      'IMAP_PASSWORD',
    ]);
    expect(errors).toHaveBeenCalledOnce();
  });

  it('defaults the port to 143 without implicit TLS', () => {
    expect(loadConfig(env({ IMAP_TLS: 'starttls' })).imap.port).toBe(143);
    expect(loadConfig(env({ IMAP_TLS: 'none' })).imap.port).toBe(143);
  });

  it('compares booleans against the literal string true', () => {
    expect(loadConfig(env({ IMAP_ALLOW_WRITE: 'true' })).allowWrite).toBe(true);
    expect(loadConfig(env({ IMAP_ALLOW_WRITE: 'True' })).allowWrite).toBe(
      false
    );
    expect(loadConfig(env({ IMAP_ALLOW_WRITE: '1' })).allowWrite).toBe(false);
    expect(loadConfig(env({ IMAP_ALLOW_WRITE: 'yes' })).allowWrite).toBe(false);
  });

  it('warns about cleartext to a remote host but keeps going', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig(env({ IMAP_TLS: 'none' }));
    expect(config.imap.tls).toBe('none');
    expect(errors.mock.calls.flat().join(' ')).toContain('unencrypted');
  });

  it('does not warn about cleartext to loopback', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(env({ IMAP_TLS: 'none', IMAP_HOST: '127.0.0.1' }));
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([
    ['IMAP_HOST', { IMAP_HOST: 'imap.example.net\r\nX-Evil: 1' }],
    ['IMAP_HOST with a scheme', { IMAP_HOST: 'imaps://imap.example.net' }],
    ['IMAP_HOST with credentials', { IMAP_HOST: 'user:pass@imap.example.net' }],
    ['IMAP_PORT', { IMAP_PORT: '99999' }],
    ['IMAP_PORT non-numeric', { IMAP_PORT: 'imap' }],
    ['IMAP_TLS', { IMAP_TLS: 'sometimes' }],
    ['IMAP_SEEN_KEYWORD', { IMAP_SEEN_KEYWORD: 'Ai Seen' }],
    ['IMAP_MAX_MESSAGES', { IMAP_MAX_MESSAGES: 'lots' }],
    ['IMAP_MAX_MESSAGES zero', { IMAP_MAX_MESSAGES: '0' }],
  ])('exits on a malformed %s', (_name, overrides) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);
    expect(() => loadConfig(env(overrides))).toThrow('exited');
    expect(exit).toHaveBeenCalledWith(1);
    // The rejected value is never echoed: config errors end up in logs.
    expect(errors.mock.calls.flat().join(' ')).not.toContain('secret-password');
  });

  it('treats an empty keyword as new-mail tracking off', () => {
    expect(loadConfig(env({ IMAP_SEEN_KEYWORD: '' })).imap.seenKeyword).toBe(
      ''
    );
  });

  it('parses the attachment type allowlist', () => {
    const config = loadConfig(
      env({ IMAP_ATTACHMENT_TYPES: 'application/pdf, IMAGE/PNG ,' })
    );
    expect(config.imap.allowedAttachmentTypes).toEqual([
      'application/pdf',
      'image/png',
    ]);
  });
});

describe('missingConfigMessage', () => {
  it('names the variables and the optional ones', () => {
    const message = missingConfigMessage(['IMAP_HOST']);
    expect(message).toContain('IMAP_HOST');
    expect(message).toContain('IMAP_ALLOW_WRITE');
    expect(message).toContain('IMAP_DOWNLOAD_DIR');
  });
});
