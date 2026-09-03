import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { PasswordResetMailService } from './password-reset-mail.service';

describe('AuthService password reset', () => {
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    passwordResetToken: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const jwt = { sign: jest.fn() };
  const config = {
    get: jest.fn((name: string, fallback?: string) =>
      name === 'PASSWORD_RESET_TOKEN_TTL_MINUTES' ? '15' : fallback,
    ),
  };
  const mail = { sendPasswordReset: jest.fn() };
  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      mail as unknown as PasswordResetMailService,
    );
  });

  it('returns the same response when the email is unknown', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const response = await service.forgotPassword({ email: 'absent@example.com' });

    expect(response.message).toContain('Si un compte correspond');
    expect(mail.sendPasswordReset).not.toHaveBeenCalled();
    expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
  });

  it('stores only the token hash and sends the raw token', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash: 'hash',
    });
    prisma.passwordResetToken.findFirst.mockResolvedValue(null);
    prisma.passwordResetToken.deleteMany.mockResolvedValue({ count: 0 });
    prisma.passwordResetToken.create.mockImplementation(({ data }) => ({
      id: 'reset-1',
      ...data,
    }));
    mail.sendPasswordReset.mockResolvedValue(undefined);

    await service.forgotPassword({ email: 'user@example.com' });

    const sentToken = mail.sendPasswordReset.mock.calls[0][1] as string;
    const storedHash = prisma.passwordResetToken.create.mock.calls[0][0].data
      .tokenHash as string;
    expect(storedHash).toBe(
      createHash('sha256').update(sentToken, 'utf8').digest('hex'),
    );
    expect(storedHash).not.toBe(sentToken);
  });

  it('rejects an expired token', async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: 'reset-1',
      userId: 'user-1',
      usedAt: null,
      expiresAt: new Date(Date.now() - 1_000),
    });

    await expect(
      service.resetPassword({ token: 'a'.repeat(43), password: 'password-2' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('consumes a valid token once and revokes existing sessions', async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: 'reset-1',
      userId: 'user-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.update.mockResolvedValue({ id: 'user-1' });
    prisma.passwordResetToken.deleteMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation((callback) => callback(prisma));

    await service.resetPassword({
      token: 'b'.repeat(43),
      password: 'new-password',
    });

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        data: expect.objectContaining({ tokenVersion: { increment: 1 } }),
      }),
    );
  });
});
