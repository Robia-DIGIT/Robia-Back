import 'dotenv/config';
import { readdir, rm, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service';
import { storageKeyBelongsTo } from '../src/odc/storage/odc-storage-key';

// RC-33 hardening — one-off, explicit-invocation-only operator script (same
// "never imported by app bootstrap or a module" posture as
// scripts/seed-odc-demo.ts). Two independent, safety-net checks against
// ODC_UPLOAD_DIR and the odc_documents table drifting apart:
//
//   1. Orphan files: something under ODC_UPLOAD_DIR that no 'received'
//      OdcDocument row's storageKey points at (a file OdcStorage.delete()'s
//      own rollback should already have caught going forward — RC-33's
//      upload() now rolls a file back if the DB write fails — but this
//      catches anything that slipped through before that rollback existed,
//      or any other drift).
//   2. Non-canonical legacy rows: a 'received' OdcDocument whose storageKey
//      does not canonically belong to its own organizationId/applicationId/
//      id (pre-RC-33-hardening rows, or anything else that predates
//      storageKeyBelongsTo()'s check in OdcDocumentsService.getFile()).
//      These can never be downloaded again — getFile() 404s them by
//      design — so they are reported for manual re-upload, never
//      auto-deleted (deleting the row would also lose the application's
//      history of having had a document at all).
//
// Dry-run by default: reports what it would do. Pass --delete to actually
// remove orphan files (never rows — never automated for rows, see above).
//
// Usage: npx ts-node -r tsconfig-paths/register scripts/cleanup-odc-orphan-files.ts [--delete]

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

async function main() {
  const shouldDelete = process.argv.includes('--delete');
  const root = resolve(process.env.ODC_UPLOAD_DIR ?? 'var/odc-uploads');

  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    const documents = await prisma.odcDocument.findMany({
      where: { status: 'received', storageKey: { not: null } },
      select: {
        id: true,
        organizationId: true,
        applicationId: true,
        storageKey: true,
      },
    });

    const referencedKeys = new Set(
      documents.map((d) => d.storageKey).filter((k): k is string => !!k),
    );

    const nonCanonical = documents.filter(
      (d) =>
        !d.storageKey ||
        !storageKeyBelongsTo(
          d.storageKey,
          d.organizationId,
          d.applicationId,
          d.id,
        ),
    );

    if (nonCanonical.length > 0) {
      console.log(
        `${nonCanonical.length} non-canonical legacy document(s) — never auto-deleted, ` +
          `can no longer be downloaded (getFile() 404s them by design), flag for manual re-upload:`,
      );
      for (const doc of nonCanonical) {
        console.log(
          `  - document ${doc.id} (application ${doc.applicationId})`,
        );
      }
    } else {
      console.log('No non-canonical legacy documents found.');
    }

    const filesOnDisk = await listFilesRecursive(root);
    const orphans = filesOnDisk.filter(
      (f) => !referencedKeys.has(relative(root, f)),
    );

    if (orphans.length === 0) {
      console.log('No orphan files found under', root);
      return;
    }

    console.log(`${orphans.length} orphan file(s) found under ${root}:`);
    for (const file of orphans) {
      const size = (await stat(file)).size;
      console.log(`  - ${relative(root, file)} (${size} bytes)`);
    }

    if (shouldDelete) {
      for (const file of orphans) {
        await rm(file, { force: true });
      }
      console.log(`Deleted ${orphans.length} orphan file(s).`);
    } else {
      console.log('Dry run only — re-run with --delete to remove these files.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
