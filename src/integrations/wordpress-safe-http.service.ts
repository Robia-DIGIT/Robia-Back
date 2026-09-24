import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export interface WordPressHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface WordPressHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  authorization: string;
  body?: unknown;
}

export class WordPressNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WordPressNetworkError';
  }
}

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split('.').map(Number);
}

function isPrivateIpv4(address: string) {
  const bytes = parseIpv4(address);
  if (!bytes) return false;
  const [a, b, c] = bytes;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string) {
  const normalized = address.toLowerCase().split('%')[0];
  // Reject all IPv4-mapped/compatible forms. The same host can use its A
  // record; accepting textual or hex-mapped IPv4 here creates avoidable parser
  // ambiguity around private-range detection.
  if (normalized.startsWith('::ffff:') || normalized.startsWith('::ffff:0:'))
    return true;
  if (normalized.startsWith('::') && normalized.includes('.')) return true;
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89a-f]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('100:') ||
    normalized.startsWith('64:ff9b:') ||
    normalized.startsWith('2001:0:') ||
    normalized.startsWith('2001:10:') ||
    normalized.startsWith('2001:20:') ||
    normalized.startsWith('2001:db8:') ||
    normalized.startsWith('2002:') ||
    normalized.startsWith('3fff:')
  );
}

export function isPublicWordPressAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !isPrivateIpv4(address);
  if (family === 6) return !isPrivateIpv6(address);
  return false;
}

export function validateWordPressUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('URL WordPress invalide.');
  }
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 ||
    ['localhost', 'localhost.localdomain'].includes(url.hostname.toLowerCase())
  ) {
    throw new BadRequestException(
      'WordPress doit utiliser un nom de domaine public en HTTPS sur le port 443.',
    );
  }
  return url;
}

@Injectable()
export class WordPressSafeHttpService {
  async request(input: WordPressHttpRequest): Promise<WordPressHttpResponse> {
    const url = validateWordPressUrl(input.url);
    const addresses = await this.resolvePublicAddresses(url.hostname);
    const payload =
      input.body === undefined ? undefined : JSON.stringify(input.body);
    if (payload && Buffer.byteLength(payload) > MAX_REQUEST_BYTES) {
      throw new BadRequestException('Contenu WordPress trop volumineux.');
    }
    const selected = addresses[0];

    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          protocol: 'https:',
          hostname: url.hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: input.method,
          servername: url.hostname,
          headers: {
            Accept: 'application/json',
            Authorization: input.authorization,
            ...(payload
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload).toString(),
                }
              : {}),
          },
          lookup: (_hostname, _options, callback) => {
            callback(null, selected.address, selected.family);
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              request.destroy(new Error('response_too_large'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown = null;
            if (text) {
              try {
                body = JSON.parse(text);
              } catch {
                body = { message: 'Réponse WordPress non JSON.' };
              }
            }
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body,
            });
          });
        },
      );
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', (error) => {
        reject(new WordPressNetworkError(error.message));
      });
      if (payload) request.write(payload);
      request.end();
    });
  }

  private async resolvePublicAddresses(hostname: string) {
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new ServiceUnavailableException(
        'Le nom de domaine WordPress ne peut pas être résolu.',
      );
    }
    if (
      addresses.length === 0 ||
      addresses.some((entry) => !isPublicWordPressAddress(entry.address))
    ) {
      throw new BadRequestException(
        'La cible WordPress résout vers une adresse non publique.',
      );
    }
    return addresses;
  }
}
