import { NotFoundException } from '@nestjs/common';
import { LocationsService } from './locations.service';
import { PrismaService } from '../prisma/prisma.service';
import { LocationPlacesService } from './location-places/location-places.service';
import { LocationWeatherService } from './location-weather/location-weather.service';

// remove() (DELETE /locations/:id, added alongside RC-38's GBP connector —
// the frontend's own "Supprimer" button on /business-profile calls it
// directly) had no test coverage at all before this. It has no FK-related
// pre-check because it doesn't need one: audits.location_id and
// opportunities.location_id have always been ON DELETE SET NULL at the DB
// level (see prisma/migrations/20260827144755_add_locations/migration.sql)
// — deleting a Location detaches its audit/opportunity history rather than
// being blocked by it. This suite locks that behavior in.
describe('LocationsService.remove()', () => {
  const orgA = 'org-a';

  function build() {
    const prisma = {
      location: { findFirst: jest.fn(), delete: jest.fn() },
    };
    const service = new LocationsService(
      prisma as unknown as PrismaService,
      {} as LocationPlacesService,
      {} as LocationWeatherService,
    );
    return { service, prisma };
  }

  it('deletes a location scoped to its own organization', async () => {
    const { service, prisma } = build();
    prisma.location.findFirst.mockResolvedValue({ id: 'loc-1' });
    prisma.location.delete.mockResolvedValue({ id: 'loc-1' });

    const result = await service.remove(orgA, 'loc-1');

    expect(prisma.location.findFirst).toHaveBeenCalledWith({
      where: { id: 'loc-1', organizationId: orgA },
      select: { id: true },
    });
    expect(prisma.location.delete).toHaveBeenCalledWith({
      where: { id: 'loc-1' },
    });
    expect(result).toEqual({ deleted: true });
  });

  it('404s (never a raw DB error) for a location belonging to another organization', async () => {
    const { service, prisma } = build();
    prisma.location.findFirst.mockResolvedValue(null);

    await expect(service.remove('org-b', 'loc-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.location.delete).not.toHaveBeenCalled();
  });

  it('404s for a location id that does not exist at all', async () => {
    const { service, prisma } = build();
    prisma.location.findFirst.mockResolvedValue(null);

    await expect(service.remove(orgA, 'does-not-exist')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // Regression guard for the exact scenario this test suite exists for:
  // a location with existing audit/opportunity history must delete
  // cleanly, never throw a foreign-key constraint error. The DB-level
  // ON DELETE SET NULL is what actually guarantees this (Prisma's own
  // .delete() call is identical either way) — this test documents that
  // remove() itself adds no additional risk on top of that guarantee, by
  // asserting it never does more than the plain delete the DB already
  // handles safely.
  it('performs a plain delete, relying on the DB-level ON DELETE SET NULL for referencing audits/opportunities', async () => {
    const { service, prisma } = build();
    prisma.location.findFirst.mockResolvedValue({ id: 'loc-with-history' });
    prisma.location.delete.mockResolvedValue({ id: 'loc-with-history' });

    await service.remove(orgA, 'loc-with-history');

    expect(prisma.location.delete).toHaveBeenCalledTimes(1);
    expect(prisma.location.delete).toHaveBeenCalledWith({
      where: { id: 'loc-with-history' },
    });
  });
});
