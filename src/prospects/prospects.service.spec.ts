import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { ProspectsService } from './prospects.service';

describe('ProspectsService', () => {
  const dto = {
    name: 'Prospect ROBIA',
    email: 'prospect@example.com',
    phone: '+261340000000',
    company: 'Entreprise Test',
    message: 'Je souhaite obtenir une démonstration de ROBIA.',
  };
  let webhooks: { notifyProspectCreated: jest.Mock };
  let service: ProspectsService;

  beforeEach(() => {
    webhooks = { notifyProspectCreated: jest.fn().mockResolvedValue(true) };
    service = new ProspectsService(webhooks as any);
  });

  it('delivers a valid prospect to n8n', async () => {
    await expect(service.submit(dto, '203.0.113.10')).resolves.toEqual(
      expect.objectContaining({ message: expect.any(String) }),
    );
    expect(webhooks.notifyProspectCreated).toHaveBeenCalledWith(dto);
  });

  it('silently accepts a filled honeypot without sending an email', async () => {
    await expect(
      service.submit(
        { ...dto, website: 'https://spam.example' },
        '203.0.113.11',
      ),
    ).resolves.toEqual(
      expect.objectContaining({ message: expect.any(String) }),
    );
    expect(webhooks.notifyProspectCreated).not.toHaveBeenCalled();
  });

  it('asks the visitor to retry when n8n is unavailable', async () => {
    webhooks.notifyProspectCreated.mockResolvedValue(false);

    await expect(service.submit(dto, '203.0.113.12')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('limits repeated submissions from the same address', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.submit(dto, '203.0.113.13');
    }

    await expect(service.submit(dto, '203.0.113.13')).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(webhooks.notifyProspectCreated).toHaveBeenCalledTimes(5);
  });
});
