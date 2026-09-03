import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { PasswordResetMailService } from './password-reset-mail.service';

const RESET_RESPONSE = {
  message:
    'Si un compte correspond à cette adresse, un lien de réinitialisation a été envoyé.',
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly passwordResetMail: PasswordResetMailService,
  ) {}

  async register(dto: RegisterDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('Un compte existe déjà pour cet email');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        passwordHash,
        provider: 'email',
        company: dto.company,
      },
    });

    return this.buildAuthResponse(
      user.id,
      user.email,
      user.name,
      user.company,
      user.tokenVersion,
    );
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Identifiants invalides');
    }

    const isPasswordValid = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Identifiants invalides');
    }

    return this.buildAuthResponse(
      user.id,
      user.email,
      user.name,
      user.company,
      user.tokenVersion,
    );
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const startedAt = Date.now();

    try {
      const user = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });

      if (!user?.passwordHash) {
        return RESET_RESPONSE;
      }

      const cooldown = new Date(Date.now() - 60_000);
      const recentRequest = await this.prisma.passwordResetToken.findFirst({
        where: {
          userId: user.id,
          usedAt: null,
          createdAt: { gte: cooldown },
        },
      });

      if (recentRequest) {
        return RESET_RESPONSE;
      }

      const token = randomBytes(32).toString('base64url');
      const tokenHash = this.hashResetToken(token);
      const ttlMinutes = this.resetTokenTtlMinutes();

      await this.prisma.passwordResetToken.deleteMany({
        where: { userId: user.id, usedAt: null },
      });

      const resetToken = await this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
        },
      });

      try {
        await this.passwordResetMail.sendPasswordReset(user.email, token);
      } catch (error) {
        await this.prisma.passwordResetToken.deleteMany({
          where: { id: resetToken.id },
        });
        this.logger.error(
          'Password reset email could not be delivered',
          error instanceof Error ? error.stack : undefined,
        );
      }

      return RESET_RESPONSE;
    } finally {
      const remainingDelay = 300 - (Date.now() - startedAt);
      if (remainingDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingDelay));
      }
    }
  }

  async resetPassword(dto: ResetPasswordDto) {
    const tokenHash = this.hashResetToken(dto.token);
    const resetToken = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });
    const now = new Date();

    if (!resetToken || resetToken.usedAt || resetToken.expiresAt <= now) {
      throw new BadRequestException(
        'Ce lien de réinitialisation est invalide ou expiré.',
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    await this.prisma.$transaction(async (transaction) => {
      const consumed = await transaction.passwordResetToken.updateMany({
        where: {
          id: resetToken.id,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });

      if (consumed.count !== 1) {
        throw new BadRequestException(
          'Ce lien de réinitialisation est invalide ou expiré.',
        );
      }

      await transaction.user.update({
        where: { id: resetToken.userId },
        data: {
          passwordHash,
          tokenVersion: { increment: 1 },
        },
      });

      await transaction.passwordResetToken.deleteMany({
        where: { userId: resetToken.userId, id: { not: resetToken.id } },
      });
    });

    return {
      message:
        'Votre mot de passe a été modifié. Vous pouvez maintenant vous connecter.',
    };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        company: true,
        provider: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException();
    }

    return user;
  }

  private resetTokenTtlMinutes() {
    const configured = Number(
      this.config.get<string>('PASSWORD_RESET_TOKEN_TTL_MINUTES', '15'),
    );
    return Number.isInteger(configured) && configured >= 5 && configured <= 60
      ? configured
      : 15;
  }

  private hashResetToken(token: string) {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private buildAuthResponse(
    userId: string,
    email: string,
    name: string | null,
    company: string | null,
    tokenVersion: number,
  ) {
    const payload = { sub: userId, email, ver: tokenVersion };
    return {
      accessToken: this.jwtService.sign(payload),
      user: { id: userId, name, email, company },
    };
  }
}
