import {
  buildOdcStorageKey,
  extensionForMimeType,
  sanitizeContentDispositionFilename,
} from './odc-storage-key';

describe('extensionForMimeType', () => {
  it('maps known MIME types to their real extension', () => {
    expect(extensionForMimeType('application/pdf')).toBe('.pdf');
    expect(extensionForMimeType('image/png')).toBe('.png');
    expect(extensionForMimeType('image/jpeg')).toBe('.jpg');
  });

  it('derives a safe extension from an unknown but short MIME type instead of trusting client input', () => {
    expect(extensionForMimeType('application/msword')).toBe('.msword');
  });

  it('caps a long, unknown MIME subtype instead of producing an unbounded extension', () => {
    expect(extensionForMimeType('application/octet-stream')).toBe(
      '.octetstrea',
    );
    expect(
      extensionForMimeType('application/octet-stream').length,
    ).toBeLessThanOrEqual(11);
  });

  it('never produces an extension containing a path separator or dot from the MIME type itself', () => {
    const ext = extensionForMimeType('application/x-evil/../../etc');
    expect(ext).not.toMatch(/[./\\]{2,}/);
  });
});

describe('buildOdcStorageKey', () => {
  it('is scoped to organizationId/applicationId/documentId and never includes client input', () => {
    const key = buildOdcStorageKey(
      'org-1',
      'app-1',
      'doc-1',
      'application/pdf',
    );
    expect(key.startsWith('org-1/app-1/doc-1/')).toBe(true);
    expect(key.endsWith('.pdf')).toBe(true);
  });

  it('never produces the same key twice for the same document', () => {
    const first = buildOdcStorageKey(
      'org-1',
      'app-1',
      'doc-1',
      'application/pdf',
    );
    const second = buildOdcStorageKey(
      'org-1',
      'app-1',
      'doc-1',
      'application/pdf',
    );
    expect(first).not.toBe(second);
  });
});

describe('sanitizeContentDispositionFilename', () => {
  it('keeps an ordinary filename unchanged', () => {
    expect(sanitizeContentDispositionFilename('cv-fitia.pdf')).toBe(
      'cv-fitia.pdf',
    );
  });

  it('strips characters that could inject a header or break out of the quoted value', () => {
    const malicious = 'cv.pdf"\r\nX-Injected: 1\\';
    const sanitized = sanitizeContentDispositionFilename(malicious);
    expect(sanitized).not.toMatch(/[\r\n"\\]/);
  });

  it('falls back to a safe default when nothing legible survives sanitization', () => {
    expect(sanitizeContentDispositionFilename('\r\n')).toBe('document');
  });
});
