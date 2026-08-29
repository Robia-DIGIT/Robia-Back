import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterDto } from './register.dto';

describe('RegisterDto', () => {
  it('accepts and normalizes the complete registration payload', async () => {
    const dto = plainToInstance(RegisterDto, {
      name: '  Johnatan Razafindratsara  ',
      company: '  ROBIA  ',
      email: '  HELLO@ROBIA.DIGITAL  ',
      password: 'password-secure',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.name).toBe('Johnatan Razafindratsara');
    expect(dto.company).toBe('ROBIA');
    expect(dto.email).toBe('hello@robia.digital');
  });

  it('rejects a payload without name and company', async () => {
    const dto = plainToInstance(RegisterDto, {
      email: 'hello@robia.digital',
      password: 'password-secure',
    });

    const errors = await validate(dto);
    const properties = errors.map((error) => error.property);

    expect(properties).toEqual(expect.arrayContaining(['name', 'company']));
  });
});
