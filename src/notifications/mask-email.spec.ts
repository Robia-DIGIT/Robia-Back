import { maskEmail } from './mask-email';

describe('maskEmail', () => {
  it('keeps the domain and a single leading character of the local part', () => {
    expect(maskEmail('jane@example.com')).toBe('j***@example.com');
  });

  it('never returns the full local part', () => {
    expect(maskEmail('romeo.landry@robiacopilot.site')).not.toContain(
      'romeo.landry',
    );
  });

  it('falls back to a fully-masked placeholder for a malformed address', () => {
    expect(maskEmail('not-an-email')).toBe('***');
  });
});
