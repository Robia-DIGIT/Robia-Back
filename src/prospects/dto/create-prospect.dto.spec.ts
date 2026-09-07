import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateProspectDto } from './create-prospect.dto';

describe('CreateProspectDto', () => {
  it('accepts empty optional fields from the public form', async () => {
    const dto = plainToInstance(CreateProspectDto, {
      name: ' Landry ',
      email: ' LANDRY@EXAMPLE.COM ',
      phone: '',
      company: ' ',
      message: ' Je souhaite une démonstration. ',
      website: '',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.name).toBe('Landry');
    expect(dto.email).toBe('landry@example.com');
    expect(dto.phone).toBeUndefined();
    expect(dto.company).toBeUndefined();
    expect(dto.website).toBeUndefined();
  });

  it('rejects an invalid telephone number', async () => {
    const dto = plainToInstance(CreateProspectDto, {
      name: 'Landry',
      email: 'landry@example.com',
      phone: '<script>alert(1)</script>',
      message: 'Je souhaite une démonstration.',
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'phone')).toBe(true);
  });
});
