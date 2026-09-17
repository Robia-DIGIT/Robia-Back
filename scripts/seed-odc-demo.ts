import 'dotenv/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../src/prisma/prisma.service';
import { OdcProgramsService } from '../src/odc/odc-programs.service';
import { OdcApplicationsService } from '../src/odc/odc-applications.service';
import { seedOdcDemo } from '../src/odc/examples/odc-demo-seed';

// RC-32 — one-off, explicit-invocation-only runner for seedOdcDemo(). Never
// imported by app bootstrap, a module, or the default `prisma db seed`
// (prisma/seed.ts) — an operator runs it by hand against a target
// organization, exactly like RC-20's EXAMPLE_AUTOMATIONS were meant to be
// exercised from a one-off script or a Nest REPL session.
//
// Usage: npm run seed:odc-demo -- <organizationId> <userId>

async function main() {
  const [organizationId, userId] = process.argv.slice(2);
  if (!organizationId || !userId) {
    console.error('Usage: npm run seed:odc-demo -- <organizationId> <userId>');
    process.exit(2);
  }

  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    const programs = new OdcProgramsService(prisma);
    const applications = new OdcApplicationsService(
      prisma,
      new EventEmitter2(),
    );

    const result = await seedOdcDemo(
      { programs, applications },
      organizationId,
      userId,
    );

    console.log(`Programme démo créé : ${result.programId}`);
    for (const application of result.applications) {
      console.log(
        `  - ${application.applicant.displayName} <${application.applicant.email}> — statut : ${application.status}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
