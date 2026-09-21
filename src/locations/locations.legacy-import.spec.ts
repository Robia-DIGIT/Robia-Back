import { PrismaService } from '../prisma/prisma.service';
import { LocationPlacesService } from './location-places/location-places.service';
import { LocationWeatherService } from './location-weather/location-weather.service';
import { LocationsService } from './locations.service';

describe('LocationsService.importLegacy', () => {
  let location: {
    findFirst: jest.Mock;
    update: jest.Mock;
    upsert: jest.Mock;
    findMany: jest.Mock;
  };
  let prisma: { $transaction: jest.Mock; location: typeof location };
  let service: LocationsService;

  beforeEach(() => {
    location = {
      findFirst: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    };
    prisma = {
      location,
      $transaction: jest.fn((callback: (tx: typeof prisma) => unknown) =>
        callback(prisma),
      ),
    };
    service = new LocationsService(
      prisma as unknown as PrismaService,
      {} as LocationPlacesService,
      {} as LocationWeatherService,
    );
  });

  const legacy = {
    legacyId: 'legacy-1',
    name: 'ROBIA Analakely',
    address: '12 Avenue',
    city: 'Antananarivo',
    country: 'Madagascar',
    phone: '+261340000000',
    isPrimary: true,
  };

  it('adopts an exact pre-existing row instead of duplicating a partial migration', async () => {
    location.findFirst.mockResolvedValue({
      id: 'loc-1',
      legacyImportKey: null,
    });
    location.update.mockResolvedValue({});
    location.findMany.mockResolvedValue([{ id: 'loc-1' }]);

    await expect(service.importLegacy('org-1', [legacy])).resolves.toEqual([
      { id: 'loc-1' },
    ]);

    expect(location.update).toHaveBeenCalledWith({
      where: { id: 'loc-1' },
      data: { legacyImportKey: 'legacy-1' },
    });
    expect(location.upsert).not.toHaveBeenCalled();
  });

  it('is idempotent when the same browser cache is submitted again', async () => {
    location.findFirst.mockResolvedValue({
      id: 'loc-1',
      legacyImportKey: 'legacy-1',
    });

    await service.importLegacy('org-1', [legacy]);
    await service.importLegacy('org-1', [legacy]);

    expect(location.upsert).not.toHaveBeenCalled();
    expect(location.update).not.toHaveBeenCalled();
  });

  it('runs the whole import inside one transaction and propagates a write failure', async () => {
    location.findFirst.mockResolvedValue(null);
    const failure = new Error('database unavailable');
    location.upsert.mockRejectedValue(failure);

    await expect(service.importLegacy('org-1', [legacy])).rejects.toBe(failure);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(location.findMany).not.toHaveBeenCalled();
  });
});
