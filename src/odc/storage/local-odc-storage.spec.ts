import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalOdcStorage } from './local-odc-storage';

describe('LocalOdcStorage', () => {
  let root: string;
  let storage: LocalOdcStorage;
  let previousEnv: string | undefined;

  beforeEach(async () => {
    previousEnv = process.env.ODC_UPLOAD_DIR;
    root = await mkdtemp(join(tmpdir(), 'odc-storage-test-'));
    process.env.ODC_UPLOAD_DIR = root;
    storage = new LocalOdcStorage();
  });

  afterEach(async () => {
    process.env.ODC_UPLOAD_DIR = previousEnv;
    await rm(root, { recursive: true, force: true });
  });

  it('writes a file that can then be read back byte-for-byte', async () => {
    const key = 'org-1/app-1/doc-1/file.pdf';
    await storage.put(key, Buffer.from('%PDF-1.4 demo content'));

    expect(await storage.exists(key)).toBe(true);
    const onDisk = await readFile(join(root, key));
    expect(onDisk.toString()).toBe('%PDF-1.4 demo content');
  });

  it('creates intermediate directories from the key segments', async () => {
    await storage.put('org-1/app-2/doc-9/nested-uuid.pdf', Buffer.from('x'));
    expect(await storage.exists('org-1/app-2/doc-9/nested-uuid.pdf')).toBe(
      true,
    );
  });

  it('reports a key that was never written as not existing', async () => {
    expect(await storage.exists('org-1/app-1/doc-404/missing.pdf')).toBe(false);
  });

  it('returns null from get() for a key that was never written', async () => {
    expect(await storage.get('org-1/app-1/doc-404/missing.pdf')).toBeNull();
  });

  it('streams back exactly what was written', async () => {
    const key = 'org-1/app-1/doc-1/file.pdf';
    await storage.put(key, Buffer.from('stream me'));
    const stream = await storage.get(key);
    expect(stream).not.toBeNull();

    const chunks: Buffer[] = [];
    for await (const chunk of stream!) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toBe('stream me');
  });

  it('refuses to resolve a key that tries to escape the upload root', async () => {
    await expect(
      storage.put('../../etc/passwd', Buffer.from('x')),
    ).rejects.toThrow(/outside the upload root/);
  });

  it('delete() removes a written file', async () => {
    const key = 'org-1/app-1/doc-1/file.pdf';
    await storage.put(key, Buffer.from('x'));

    await storage.delete(key);

    expect(await storage.exists(key)).toBe(false);
  });

  it('delete() is a safe no-op for a key that was never written', async () => {
    await expect(
      storage.delete('org-1/app-1/doc-404/missing.pdf'),
    ).resolves.toBeUndefined();
  });

  it('delete() called twice on the same key is still a safe no-op', async () => {
    const key = 'org-1/app-1/doc-1/file.pdf';
    await storage.put(key, Buffer.from('x'));

    await storage.delete(key);
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });
});
