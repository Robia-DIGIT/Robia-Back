//données de test, nanandramako an'ilay integration prisma

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });

  console.log('Creating test user...');
  const user = await prisma.user.create({
    data: {
      email: 'test@robia.dev',
      passwordHash: 'fake_hash_for_test',
    },
  });
  console.log('User created:', user);

  console.log('Creating test organization...');
  const org = await prisma.organization.create({
    data: {
      name: 'Boulangerie Test',
      sector: 'Alimentation',
      city: 'Antananarivo',
      country: 'Madagascar',
      ownerId: user.id,
    },
  });
  console.log('Organization created:', org);

  console.log('Fetching user with organizations (test relation)...');
  const userWithOrgs = await prisma.user.findUnique({
    where: { id: user.id },
    include: { organizations: true },
  });
  console.log('User with orgs:', JSON.stringify(userWithOrgs, null, 2));

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
