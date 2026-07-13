import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

interface AuthenticatedRequest extends Request {
  user: { userId: string; email: string };
  organizationId?: string;
}

@Injectable()
export class OrgScopeGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const org = await this.prisma.organization.findFirst({
      where: { ownerId: req.user.userId },
      select: { id: true },
    });

    if (!org) {
      throw new NotFoundException(
        "Aucune organisation associée à cet utilisateur. Créez d'abord votre profil PME.",
      );
    }

    req.organizationId = org.id;
    return true;
  }
}
