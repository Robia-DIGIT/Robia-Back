import { BadRequestException } from '@nestjs/common';
import {
  isPublicWordPressAddress,
  validateWordPressUrl,
} from './wordpress-safe-http.service';

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
