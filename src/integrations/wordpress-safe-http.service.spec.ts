import { BadRequestException } from '@nestjs/common';
import { request as httpsRequest } from 'node:https';
import * as dnsPromises from 'node:dns/promises';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { LookupFunction } from 'node:net';
import {
  createPinnedLookup,
  isPublicWordPressAddress,
  validateWordPressUrl,
  WordPressSafeHttpService,
} from './wordpress-safe-http.service';

// node:dns/promises's module namespace is non-configurable in this Node
// version, so jest.spyOn() can't patch it directly - replace the whole
// module instead, matching what the service itself imports.
jest.mock('node:dns/promises', () => ({
  __esModule: true,
  lookup: jest.fn(),
}));
// The service only ever calls lookup(hostname, { all: true, verbatim: true }),
// so pin the mock to that one overload (jest.mocked() otherwise collapses an
// overloaded function to its last, single-address signature).
const mockedLookup = jest.mocked(
  dnsPromises.lookup,
) as unknown as jest.MockedFunction<
  (
    hostname: string,
    options: { all: true; verbatim?: boolean },
  ) => Promise<Array<{ address: string; family: number }>>
>;

/**
 * A port on 127.0.0.1 that is guaranteed free but has nothing listening on
 * it: bind an ephemeral server, read its port, close it. A connection
 * attempt against it fails fast (ECONNREFUSED) - real enough to exercise
 * Node's actual connection-establishment path (where the custom `lookup`
 * option is invoked) without any external network dependency or a
 * self-signed TLS server to stand up.
 */
async function getClosedLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function attemptConnection(
  lookupFn: LookupFunction,
  port: number,
): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: 'pinned.invalid.example',
        port,
        path: '/',
        method: 'GET',
        lookup: lookupFn,
        timeout: 2000,
      },
      () => resolve({ ok: true }),
    );
    req.on('error', (error) => resolve({ ok: false, message: error.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, message: 'timeout' });
    });
    req.end();
  });
}

describe('WordPressSafeHttpService policy', () => {
  it('accepts only a public HTTPS hostname on the default port', () => {
    expect(validateWordPressUrl('https://example.com/wp-json').hostname).toBe(
      'example.com',
    );
    for (const unsafe of [
      'http://example.com',
      'https://example.com:8443',
      'https://127.0.0.1',
      'https://[::1]',
      'https://localhost',
      'https://user:secret@example.com',
    ]) {
      expect(() => validateWordPressUrl(unsafe)).toThrow(BadRequestException);
    }
  });

  it('rejects private, link-local, documentation and multicast IPv4 ranges', () => {
    for (const address of [
      '0.0.0.1',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '192.0.2.10',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
    ]) {
      expect(isPublicWordPressAddress(address)).toBe(false);
    }
    expect(isPublicWordPressAddress('8.8.8.8')).toBe(true);
  });

  it('rejects private, local, mapped-private and documentation IPv6 ranges', () => {
    for (const address of [
      '::',
      '::1',
      'fc00::1',
      'fd00::1',
      'fe80::1',
      'ff02::1',
      'fec0::1',
      '100::1',
      '64:ff9b::127.0.0.1',
      '2001:0::1',
      '2002:7f00:1::',
      '2001:db8::1',
      '3fff::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
    ]) {
      expect(isPublicWordPressAddress(address)).toBe(false);
    }
    expect(isPublicWordPressAddress('2606:4700:4700::1111')).toBe(true);
  });
});

describe('createPinnedLookup - Node http/https lookup callback contract', () => {
  it('replies with an array of {address, family} when options.all is true (Node 22 Happy Eyeballs contract)', () => {
    const lookupFn = createPinnedLookup({
      address: '93.184.216.34',
      family: 4,
    });
    const callback = jest.fn();

    lookupFn('ignored-hostname', { all: true }, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(null, [
      { address: '93.184.216.34', family: 4 },
    ]);
  });

  it('replies positionally (address, family) when options.all is not set', () => {
    const lookupFn = createPinnedLookup({
      address: '93.184.216.34',
      family: 4,
    });
    const callback = jest.fn();

    lookupFn('ignored-hostname', {}, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('returns exactly the prevalidated address in both call shapes, for the same hostname', () => {
    const selected = { address: '2606:4700:4700::1111', family: 6 };
    const lookupFn = createPinnedLookup(selected);
    const allCallback = jest.fn();
    const oneCallback = jest.fn();

    lookupFn('host', { all: true }, allCallback);
    lookupFn('host', {}, oneCallback);

    expect(allCallback).toHaveBeenCalledWith(null, [
      { address: selected.address, family: selected.family },
    ]);
    expect(oneCallback).toHaveBeenCalledWith(
      null,
      selected.address,
      selected.family,
    );
  });

  it('accepts both IPv4 and IPv6 pinned addresses', () => {
    for (const selected of [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]) {
      const lookupFn = createPinnedLookup(selected);
      const callback = jest.fn();
      lookupFn('host', { all: true }, callback);
      expect(callback).toHaveBeenCalledWith(null, [
        { address: selected.address, family: selected.family },
      ]);
    }
  });

  it('never performs a fresh DNS resolution itself - it only ever echoes the pinned address', () => {
    mockedLookup.mockClear();
    const lookupFn = createPinnedLookup({
      address: '93.184.216.34',
      family: 4,
    });

    lookupFn('host', { all: true }, jest.fn());
    lookupFn('host', {}, jest.fn());

    expect(mockedLookup).not.toHaveBeenCalled();
  });
});

describe('createPinnedLookup - real Node connection-establishment path', () => {
  it('reproduces the real "Invalid IP address: undefined" crash with the old positional-only lookup (regression baseline)', async () => {
    const port = await getClosedLocalPort();
    // This is the exact shape the code used before the RC42 fix: always
    // positional, regardless of what Node's options actually ask for.
    const legacyBuggyLookup: LookupFunction = (
      _hostname,
      _options,
      callback,
    ) => {
      callback(null, '127.0.0.1', 4);
    };

    const result = await attemptConnection(legacyBuggyLookup, port);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Invalid IP address');
  });

  it('createPinnedLookup no longer crashes and reaches a real connection attempt', async () => {
    const port = await getClosedLocalPort();
    const fixedLookup = createPinnedLookup({ address: '127.0.0.1', family: 4 });

    const result = await attemptConnection(fixedLookup, port);

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('Invalid IP address');
    expect(result.message).toMatch(/ECONNREFUSED|ECONNRESET/);
  });

  it('performs no new DNS resolution while Node establishes the connection (pinning holds end to end)', async () => {
    const port = await getClosedLocalPort();
    mockedLookup.mockClear();
    const fixedLookup = createPinnedLookup({ address: '127.0.0.1', family: 4 });

    await attemptConnection(fixedLookup, port);

    expect(mockedLookup).not.toHaveBeenCalled();
  });
});

describe('WordPressSafeHttpService.request - resolution guard', () => {
  afterEach(() => {
    mockedLookup.mockReset();
  });

  it('refuses a private/non-public resolved address before ever attempting a connection, after exactly one DNS resolution', async () => {
    mockedLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const service = new WordPressSafeHttpService();

    await expect(
      service.request({
        method: 'GET',
        url: 'https://intranet.example.com/wp-json',
        authorization: 'Bearer test-token',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // The guard must reject from the resolved address alone - it never
    // needs, and never performs, a second resolution to reach this verdict.
    expect(mockedLookup).toHaveBeenCalledTimes(1);
  });
});
