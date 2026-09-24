import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  evaluatePublication,
  publicationOperationKey,
  type PublicationBinding,
} from '../content-studio/publication-policy';
import { PrismaService } from '../prisma/prisma.service';
import { ApproveWordPressDraftDto } from './dto/approve-wordpress-draft.dto';
import { ConnectWordPressDto } from './dto/connect-wordpress.dto';
import { CreateWordPressDraftDto } from './dto/create-wordpress-draft.dto';
import {
  validateWordPressUrl,
  type WordPressHttpResponse,
  WordPressNetworkError,
  WordPressSafeHttpService,
} from './wordpress-safe-http.service';

const RECONCILIATION_LEASE_MS = 5 * 60 * 1000;

interface CanonicalDraftPayload {
  title: string;
  content: string;
  status: 'draft';
  slug: string;
}

interface WordPressPostResponse {
  id?: number | string;
  link?: string;
  slug?: string;
  status?: string;
  content?: { raw?: string };
}

@Injectable()
export class WordPressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly http: WordPressSafeHttpService,
  ) {}

  async connect(organizationId: string, dto: ConnectWordPressDto) {
    const website = await this.prisma.website.findFirst({
      where: { id: dto.websiteId, organizationId },
      select: { id: true, url: true },
    });
    if (!website) throw new NotFoundException('Site ROBIA non trouvé.');

    const { siteUrl, apiBaseUrl } = this.wordpressUrls(website.url);
    this.encryptionKey();
    const username = dto.username.trim();
    const applicationPassword = dto.applicationPassword.replace(/\s+/g, '');
    if (!username || applicationPassword.length < 8) {
      throw new BadRequestException('Identifiants WordPress invalides.');
    }
    const authorization = this.basicAuthorization(
      username,
      applicationPassword,
    );
    const response = await this.http.request({
      method: 'GET',
      url: `${apiBaseUrl}/users/me?context=edit`,
      authorization,
    });
    if (response.status !== 200 || !this.remoteUser(response.body)) {
      throw new UnprocessableEntityException(
        'WordPress a refusé la vérification des identifiants.',
      );
    }
    const remoteUser = this.remoteUser(response.body)!;
    if (!remoteUser.canCreatePosts && !remoteUser.canCreatePages) {
      throw new UnprocessableEntityException(
        'Le compte WordPress ne peut créer ni article ni page.',
      );
    }
    const encryptedApplicationPassword = this.encrypt(
      applicationPassword,
      organizationId,
      website.id,
    );
    const now = new Date();
    const connection = await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.wordPressConnection.findFirst({
          where: { organizationId, websiteId: website.id },
          select: { id: true },
        });
        if (existing) {
          await this.assertNoActiveAttempt(tx, existing.id);
          return tx.wordPressConnection.update({
            where: { id: existing.id },
            data: {
              siteUrl,
              apiBaseUrl,
              username,
              encryptedApplicationPassword,
              remoteUserId: String(remoteUser.id),
              remoteUserName: remoteUser.name ?? null,
              canCreatePosts: remoteUser.canCreatePosts,
              canCreatePages: remoteUser.canCreatePages,
              status: 'ready',
              disconnectedAt: null,
              lastVerifiedAt: now,
              connectionVersion: { increment: 1 },
            },
            select: this.connectionSelect(),
          });
        }
        return tx.wordPressConnection.create({
          data: {
            organizationId,
            websiteId: website.id,
            siteUrl,
            apiBaseUrl,
            username,
            encryptedApplicationPassword,
            remoteUserId: String(remoteUser.id),
            remoteUserName: remoteUser.name ?? null,
            canCreatePosts: remoteUser.canCreatePosts,
            canCreatePages: remoteUser.canCreatePages,
            status: 'ready',
            lastVerifiedAt: now,
          },
          select: this.connectionSelect(),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return { connection };
  }

  async status(organizationId: string, websiteId: string) {
    await this.requireWebsite(organizationId, websiteId);
    const connection = await this.prisma.wordPressConnection.findFirst({
      where: { organizationId, websiteId },
      select: this.connectionSelect(),
    });
    return { connected: connection?.status === 'ready', connection };
  }

  async disconnect(organizationId: string, websiteId: string) {
    await this.requireWebsite(organizationId, websiteId);
    const result = await this.prisma.$transaction(
      async (tx) => {
        const connection = await tx.wordPressConnection.findFirst({
          where: { organizationId, websiteId },
          select: { id: true, status: true },
        });
        if (!connection || connection.status === 'disconnected') {
          return { count: 0 };
        }
        await this.assertNoActiveAttempt(tx, connection.id);
        return tx.wordPressConnection.updateMany({
          where: {
            id: connection.id,
            organizationId,
            status: { not: 'disconnected' },
          },
          data: {
            encryptedApplicationPassword: null,
            status: 'disconnected',
            disconnectedAt: new Date(),
            connectionVersion: { increment: 1 },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return {
      disconnected: result.count === 1,
      localOnly: true,
      remoteApplicationPasswordRevoked: false,
    };
  }

  async approveDraft(
    organizationId: string,
    userId: string,
    dto: ApproveWordPressDraftDto,
  ) {
    const [connection, document, action] = await Promise.all([
      this.readyConnection(organizationId, dto.websiteId),
      this.prisma.document.findFirst({
        where: {
          id: dto.documentId,
          organizationId,
          websiteId: dto.websiteId,
        },
      }),
      this.prisma.actionItem.findFirst({
        where: { id: dto.actionItemId, organizationId },
      }),
    ]);
    if (!document) throw new NotFoundException('Document non trouvé.');
    if (!action) throw new NotFoundException('Action non trouvée.');
    if (document.revision !== dto.expectedRevision) {
      throw new ConflictException(
        'Le document a changé. Rechargez-le avant de l’approuver.',
      );
    }
    if (action.documentId !== document.id) {
      throw new BadRequestException(
        'Cette action n’est pas liée au document demandé.',
      );
    }
    if (
      action.approvalStatus !== 'approved' ||
      action.executionStatus !== 'ready'
    ) {
      throw new BadRequestException(
        'L’action doit être approuvée et prête avant la création du brouillon.',
      );
    }
    if (
      (dto.postType === 'post' && !connection.canCreatePosts) ||
      (dto.postType === 'page' && !connection.canCreatePages)
    ) {
      throw new BadRequestException(
        `Le compte WordPress ne peut pas créer de ${dto.postType === 'post' ? 'brouillon d’article' : 'brouillon de page'}.`,
      );
    }

    const payload = this.canonicalPayload(document, connection, dto.postType);
    const binding = this.binding(connection, document, dto.postType, payload);
    const operationKey = publicationOperationKey(binding);
    const existing = await this.prisma.wordPressDraftApproval.findUnique({
      where: { operationKey },
      select: this.approvalSelect(),
    });
    if (existing) return { approval: existing, idempotent: true };

    try {
      const approval = await this.prisma.wordPressDraftApproval.create({
        data: {
          organizationId,
          connectionId: connection.id,
          documentId: document.id,
          actionItemId: action.id,
          approvedById: userId,
          documentRevision: document.revision,
          contentDigest: binding.contentDigest,
          postType: dto.postType,
          targetId: binding.targetId,
          connectionVersion: connection.connectionVersion,
          operationKey,
          canonicalPayload: payload as unknown as Prisma.InputJsonValue,
        },
        select: this.approvalSelect(),
      });
      return { approval, idempotent: false };
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const approval = await this.prisma.wordPressDraftApproval.findUnique({
        where: { operationKey },
        select: this.approvalSelect(),
      });
      if (!approval) throw error;
      return { approval, idempotent: true };
    }
  }

  async createDraft(
    organizationId: string,
    userId: string,
    dto: CreateWordPressDraftDto,
  ) {
    const context = await this.publicationContext(
      organizationId,
      dto.approvalId,
    );
    const current = this.binding(
      context.connection,
      context.document,
      context.approval.postType as 'post' | 'page',
      this.canonicalPayload(
        context.document,
        context.connection,
        context.approval.postType as 'post' | 'page',
      ),
    );
    const existing = await this.prisma.wordPressDraftAttempt.findFirst({
      where: {
        organizationId,
        OR: [
          { operationKey: context.approval.operationKey },
          { idempotencyKey: dto.idempotencyKey.trim() },
        ],
      },
    });
    if (existing) return this.existingAttempt(existing, context.approval.id);

    const decision = evaluatePublication({
      current,
      approval: {
        organizationId: context.approval.organizationId,
        documentId: context.approval.documentId,
        revision: context.approval.documentRevision,
        contentDigest: context.approval.contentDigest,
        destination: 'wordpress_post',
        targetId: context.approval.targetId,
        connectionVersion: context.approval.connectionVersion,
        approvedBy: context.approval.approvedById,
        revoked: context.approval.revokedAt !== null,
      },
      publishingEnabled: true,
      connectionReady:
        context.connection.status === 'ready' &&
        Boolean(context.connection.encryptedApplicationPassword),
      previousAttempt: null,
    });
    if (!decision.allowed) {
      throw new ConflictException(
        `Création du brouillon refusée (${decision.reason}).`,
      );
    }
    if (decision.operationKey !== context.approval.operationKey) {
      throw new ConflictException(
        'L’approbation ne correspond plus au contenu.',
      );
    }

    const claimToken = randomUUID();
    let attemptId: string;
    try {
      const attempt = await this.prisma.wordPressDraftAttempt.create({
        data: {
          organizationId,
          connectionId: context.connection.id,
          approvalId: context.approval.id,
          documentId: context.document.id,
          actionItemId: context.action.id,
          idempotencyKey: dto.idempotencyKey.trim(),
          operationKey: decision.operationKey,
          status: 'in_flight',
          claimToken,
          claimedAt: new Date(),
        },
      });
      attemptId = attempt.id;
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const raced = await this.prisma.wordPressDraftAttempt.findFirst({
        where: {
          organizationId,
          OR: [
            { operationKey: decision.operationKey },
            { idempotencyKey: dto.idempotencyKey.trim() },
          ],
        },
      });
      if (!raced) throw error;
      return this.existingAttempt(raced, context.approval.id);
    }

    const claimedContext = await this.publicationContext(
      organizationId,
      dto.approvalId,
    );
    const claimedPayload = this.canonicalPayload(
      claimedContext.document,
      claimedContext.connection,
      claimedContext.approval.postType as 'post' | 'page',
    );
    const claimedBinding = this.binding(
      claimedContext.connection,
      claimedContext.document,
      claimedContext.approval.postType as 'post' | 'page',
      claimedPayload,
    );
    if (
      publicationOperationKey(claimedBinding) !==
      claimedContext.approval.operationKey
    ) {
      await this.finishFailedAttempt(
        attemptId,
        claimToken,
        'failed',
        'binding_changed_before_dispatch',
      );
      throw new ConflictException(
        'Le document ou la connexion a changé avant l’envoi.',
      );
    }
    const authorization = this.connectionAuthorization(
      claimedContext.connection,
    );
    const payload = claimedContext.approval
      .canonicalPayload as unknown as CanonicalDraftPayload;
    try {
      const response = await this.http.request({
        method: 'POST',
        url: `${claimedContext.connection.apiBaseUrl}/${claimedContext.approval.postType}s`,
        authorization,
        body: payload,
      });
      if (response.status < 200 || response.status >= 300) {
        const ambiguous = response.status >= 500;
        await this.finishFailedAttempt(
          attemptId,
          claimToken,
          ambiguous ? 'unknown' : 'failed',
          `wordpress_http_${response.status}`,
        );
        if (ambiguous) {
          throw new ServiceUnavailableException(
            'Réponse WordPress ambiguë. Une réconciliation est requise.',
          );
        }
        throw new UnprocessableEntityException(
          `WordPress a refusé le brouillon (HTTP ${response.status}).`,
        );
      }
      const remote = this.remotePost(response.body);
      if (!remote || remote.status !== 'draft') {
        await this.finishFailedAttempt(
          attemptId,
          claimToken,
          'unknown',
          'invalid_wordpress_response',
        );
        throw new ServiceUnavailableException(
          'Réponse WordPress invalide. Une réconciliation est requise.',
        );
      }
      return this.confirmAttempt(
        claimedContext,
        attemptId,
        claimToken,
        remote,
        userId,
      );
    } catch (error) {
      if (error instanceof WordPressNetworkError) {
        await this.finishFailedAttempt(
          attemptId,
          claimToken,
          'unknown',
          'wordpress_network_error',
        );
        throw new ServiceUnavailableException(
          'Résultat WordPress inconnu. Le brouillon doit être réconcilié avant toute nouvelle tentative.',
        );
      }
      throw error;
    }
  }

  async revokeApproval(organizationId: string, approvalId: string) {
    const result = await this.prisma.wordPressDraftApproval.updateMany({
      where: { id: approvalId, organizationId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count !== 1) {
      const exists = await this.prisma.wordPressDraftApproval.findFirst({
        where: { id: approvalId, organizationId },
        select: { id: true, revokedAt: true },
      });
      if (!exists) {
        throw new NotFoundException('Approbation WordPress non trouvée.');
      }
      return { revoked: true, changed: false };
    }
    return { revoked: true, changed: true };
  }

  async reconcileDraft(
    organizationId: string,
    userId: string,
    attemptId: string,
  ) {
    const attempt = await this.prisma.wordPressDraftAttempt.findFirst({
      where: { id: attemptId, organizationId },
      include: {
        approval: true,
        connection: true,
        document: true,
        actionItem: true,
      },
    });
    if (!attempt)
      throw new NotFoundException('Tentative WordPress non trouvée.');
    if (attempt.status === 'confirmed') return { attempt, idempotent: true };
    if (!['unknown', 'in_flight'].includes(attempt.status)) {
      throw new ConflictException(
        'Cette tentative ne peut pas être réconciliée.',
      );
    }
    const claimToken = randomUUID();
    const cutoff = new Date(Date.now() - RECONCILIATION_LEASE_MS);
    const claimed = await this.prisma.wordPressDraftAttempt.updateMany({
      where: {
        id: attempt.id,
        organizationId,
        OR: [
          { status: 'unknown' },
          { status: 'in_flight', claimedAt: { lt: cutoff } },
        ],
      },
      data: { status: 'in_flight', claimToken, claimedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new ConflictException('Cette tentative est encore en cours.');
    }
    const payload = attempt.approval
      .canonicalPayload as unknown as CanonicalDraftPayload;
    const query = new URLSearchParams({
      slug: payload.slug,
      status: 'draft',
      context: 'edit',
      _fields: 'id,link,slug,status,content',
    });
    let response: WordPressHttpResponse;
    try {
      response = await this.http.request({
        method: 'GET',
        url: `${attempt.connection.apiBaseUrl}/${attempt.approval.postType}s?${query}`,
        authorization: this.connectionAuthorization(attempt.connection),
      });
    } catch (error) {
      await this.finishFailedAttempt(
        attempt.id,
        claimToken,
        'unknown',
        error instanceof WordPressNetworkError
          ? 'wordpress_reconcile_network_error'
          : 'wordpress_reconcile_local_error',
      );
      if (error instanceof WordPressNetworkError) {
        throw new ServiceUnavailableException(
          'Réconciliation WordPress indisponible.',
        );
      }
      throw error;
    }
    if (response.status !== 200 || !Array.isArray(response.body)) {
      await this.finishFailedAttempt(
        attempt.id,
        claimToken,
        'unknown',
        `wordpress_reconcile_http_${response.status}`,
      );
      throw new ServiceUnavailableException(
        'Réconciliation WordPress impossible.',
      );
    }
    const marker = this.marker(
      organizationId,
      attempt.documentId,
      attempt.approval.documentRevision,
      attempt.connectionId,
      attempt.approval.connectionVersion,
      attempt.approval.postType,
    );
    const matches = response.body
      .map((entry) => this.remotePost(entry))
      .filter((entry): entry is Required<WordPressPostResponse> =>
        Boolean(
          entry &&
          entry.slug === payload.slug &&
          entry.content?.raw?.includes(marker),
        ),
      );
    if (matches.length !== 1) {
      await this.finishFailedAttempt(
        attempt.id,
        claimToken,
        'unknown',
        matches.length > 1
          ? 'multiple_remote_matches'
          : 'remote_match_not_found',
      );
      return { attemptId: attempt.id, status: 'unknown', found: false };
    }
    const context = {
      approval: attempt.approval,
      connection: attempt.connection,
      document: attempt.document,
      action: attempt.actionItem,
    };
    return this.confirmAttempt(
      context,
      attempt.id,
      claimToken,
      matches[0],
      userId,
    );
  }

  async listAttempts(organizationId: string, websiteId: string) {
    await this.requireWebsite(organizationId, websiteId);
    return this.prisma.wordPressDraftAttempt.findMany({
      where: { organizationId, connection: { websiteId } },
      select: {
        id: true,
        approvalId: true,
        documentId: true,
        actionItemId: true,
        status: true,
        remotePostId: true,
        remoteUrl: true,
        remoteEditorUrl: true,
        errorCode: true,
        createdAt: true,
        updatedAt: true,
        confirmedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  private async publicationContext(organizationId: string, approvalId: string) {
    const approval = await this.prisma.wordPressDraftApproval.findFirst({
      where: { id: approvalId, organizationId },
      include: {
        connection: true,
        document: true,
        actionItem: true,
      },
    });
    if (!approval)
      throw new NotFoundException('Approbation WordPress non trouvée.');
    if (
      approval.document.organizationId !== organizationId ||
      approval.actionItem.organizationId !== organizationId ||
      approval.connection.organizationId !== organizationId
    ) {
      throw new NotFoundException('Approbation WordPress non trouvée.');
    }
    if (
      approval.actionItem.documentId !== approval.document.id ||
      approval.actionItem.approvalStatus !== 'approved' ||
      approval.actionItem.executionStatus !== 'ready'
    ) {
      throw new ConflictException(
        'L’action liée n’est plus prête à être exécutée.',
      );
    }
    return {
      approval,
      connection: approval.connection,
      document: approval.document,
      action: approval.actionItem,
    };
  }

  private binding(
    connection: { id: string; connectionVersion: number },
    document: {
      id: string;
      organizationId: string;
      revision: number;
    },
    postType: 'post' | 'page',
    payload: CanonicalDraftPayload,
  ): PublicationBinding {
    return {
      organizationId: document.organizationId,
      documentId: document.id,
      revision: document.revision,
      contentDigest: this.sha256(JSON.stringify(payload)),
      destination: 'wordpress_post',
      targetId: `${connection.id}:${postType}`,
      connectionVersion: connection.connectionVersion,
    };
  }

  private canonicalPayload(
    document: {
      id: string;
      organizationId: string;
      revision: number;
      title: string;
      content: string;
    },
    connection: { id: string; connectionVersion: number },
    postType: 'post' | 'page',
  ): CanonicalDraftPayload {
    const marker = this.marker(
      document.organizationId,
      document.id,
      document.revision,
      connection.id,
      connection.connectionVersion,
      postType,
    );
    return {
      title: document.title.trim(),
      content: `${document.content.trim()}\n\n<!-- ${marker} -->`,
      status: 'draft',
      slug: `robia-${this.sha256(document.id).slice(0, 12)}-r${document.revision}`,
    };
  }

  private marker(
    organizationId: string,
    documentId: string,
    revision: number,
    connectionId: string,
    connectionVersion: number,
    postType: string,
  ) {
    return `robia-draft:${this.sha256(
      JSON.stringify([
        organizationId,
        documentId,
        revision,
        connectionId,
        connectionVersion,
        postType,
      ]),
    )}`;
  }

  private async confirmAttempt(
    context: {
      approval: { id: string; operationKey: string; postType: string };
      connection: { siteUrl: string };
      document: { id: string };
      action: { id: string };
    },
    attemptId: string,
    claimToken: string,
    remote: Required<WordPressPostResponse>,
    userId: string,
  ) {
    const remotePostId = String(remote.id);
    const remoteUrl = this.safeRemoteLink(
      context.connection.siteUrl,
      remote.link,
    );
    const remoteEditorUrl = `${context.connection.siteUrl.replace(/\/$/, '')}/wp-admin/post.php?post=${encodeURIComponent(remotePostId)}&action=edit`;
    const finalized = await this.prisma.wordPressDraftAttempt.updateMany({
      where: { id: attemptId, claimToken, status: 'in_flight' },
      data: {
        status: 'confirmed',
        claimToken: null,
        claimedAt: null,
        remotePostId,
        remoteUrl,
        remoteEditorUrl,
        errorCode: null,
        errorMessage: null,
        confirmedAt: new Date(),
      },
    });
    if (finalized.count !== 1) {
      throw new ConflictException(
        'La tentative a perdu son bail; son résultat local a été ignoré.',
      );
    }

    const evidence = {
      destination: 'wordpress',
      mode: 'draft_only',
      postType: context.approval.postType,
      remotePostId,
      remoteUrl,
      remoteEditorUrl,
      documentId: context.document.id,
    };
    await this.prisma.$transaction(async (tx) => {
      const action = await tx.actionItem.updateMany({
        where: {
          id: context.action.id,
          approvalStatus: 'approved',
          executionStatus: 'ready',
        },
        data: {
          status: 'done',
          executionStatus: 'succeeded',
          executionEvidence: evidence,
          attemptCount: { increment: 1 },
        },
      });
      if (action.count !== 1) return;
      await tx.actionExecutionEvent.create({
        data: {
          organizationId: (
            await tx.actionItem.findUniqueOrThrow({
              where: { id: context.action.id },
              select: { organizationId: true },
            })
          ).organizationId,
          actionItemId: context.action.id,
          userId,
          eventType: 'execution_succeeded',
          idempotencyKey: `${context.action.id}:wordpress:${context.approval.operationKey}`,
          payload: evidence,
        },
      });
    });
    return {
      attempt: {
        id: attemptId,
        status: 'confirmed',
        remotePostId,
        remoteUrl,
        remoteEditorUrl,
      },
      idempotent: false,
    };
  }

  private async finishFailedAttempt(
    id: string,
    claimToken: string,
    status: 'unknown' | 'failed',
    errorCode: string,
  ) {
    await this.prisma.wordPressDraftAttempt.updateMany({
      where: { id, claimToken, status: 'in_flight' },
      data: {
        status,
        claimToken: null,
        claimedAt: null,
        errorCode,
        errorMessage: null,
      },
    });
  }

  private existingAttempt(
    attempt: { approvalId: string; status: string },
    approvalId: string,
  ) {
    if (attempt.approvalId !== approvalId) {
      throw new ConflictException(
        'Cette clé d’idempotence est déjà utilisée pour une autre approbation.',
      );
    }
    if (attempt.status === 'confirmed') {
      return { attempt, idempotent: true };
    }
    throw new ConflictException(
      'Une tentative existe déjà et doit être réconciliée avant toute suite.',
    );
  }

  private async readyConnection(organizationId: string, websiteId: string) {
    const connection = await this.prisma.wordPressConnection.findFirst({
      where: { organizationId, websiteId },
    });
    if (
      !connection ||
      connection.status !== 'ready' ||
      !connection.encryptedApplicationPassword
    ) {
      throw new BadRequestException(
        'WordPress n’est pas connecté pour ce site.',
      );
    }
    return connection;
  }

  private async requireWebsite(organizationId: string, websiteId: string) {
    const website = await this.prisma.website.findFirst({
      where: { id: websiteId, organizationId },
      select: { id: true },
    });
    if (!website) throw new NotFoundException('Site ROBIA non trouvé.');
    return website;
  }

  private async assertNoActiveAttempt(
    tx: Prisma.TransactionClient,
    connectionId: string,
  ) {
    const active = await tx.wordPressDraftAttempt.count({
      where: { connectionId, status: 'in_flight' },
    });
    if (active > 0) {
      throw new ConflictException(
        'Une création WordPress est en cours; la connexion ne peut pas être modifiée.',
      );
    }
  }

  private wordpressUrls(rawWebsiteUrl: string) {
    const url = validateWordPressUrl(rawWebsiteUrl);
    url.search = '';
    url.hash = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    const siteUrl = url.toString().replace(/\/$/, '');
    const apiBaseUrl = new URL('wp-json/wp/v2', url)
      .toString()
      .replace(/\/$/, '');
    return { siteUrl, apiBaseUrl };
  }

  private connectionAuthorization(connection: {
    username: string;
    encryptedApplicationPassword: string | null;
    organizationId: string;
    websiteId: string;
  }) {
    if (!connection.encryptedApplicationPassword) {
      throw new BadRequestException('Connexion WordPress indisponible.');
    }
    return this.basicAuthorization(
      connection.username,
      this.decrypt(
        connection.encryptedApplicationPassword,
        connection.organizationId,
        connection.websiteId,
      ),
    );
  }

  private basicAuthorization(username: string, applicationPassword: string) {
    return `Basic ${Buffer.from(`${username}:${applicationPassword}`).toString('base64')}`;
  }

  private encryptionKey() {
    const value = this.config
      .get<string>('WORDPRESS_CREDENTIAL_ENCRYPTION_KEY')
      ?.trim();
    if (!value || !/^[0-9a-f]{64}$/i.test(value)) {
      throw new ServiceUnavailableException(
        'Intégration WordPress non configurée (WORDPRESS_CREDENTIAL_ENCRYPTION_KEY).',
      );
    }
    return Buffer.from(value, 'hex');
  }

  private encrypt(value: string, organizationId: string, websiteId: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    cipher.setAAD(Buffer.from(`${organizationId}:${websiteId}`));
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  private decrypt(value: string, organizationId: string, websiteId: string) {
    const [version, iv, tag, ciphertext, extra] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !ciphertext || extra) {
      throw new ServiceUnavailableException(
        'Identifiant WordPress chiffré invalide.',
      );
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey(),
        Buffer.from(iv, 'base64url'),
      );
      decipher.setAAD(Buffer.from(`${organizationId}:${websiteId}`));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException('Identifiant WordPress illisible.');
    }
  }

  private remoteUser(body: unknown) {
    if (!body || typeof body !== 'object') return null;
    const user = body as {
      id?: unknown;
      name?: unknown;
      capabilities?: unknown;
    };
    if (!['string', 'number'].includes(typeof user.id)) return null;
    const capabilities =
      user.capabilities && typeof user.capabilities === 'object'
        ? (user.capabilities as Record<string, unknown>)
        : {};
    return {
      id: user.id as string | number,
      name: typeof user.name === 'string' ? user.name : null,
      canCreatePosts: capabilities.edit_posts === true,
      canCreatePages: capabilities.edit_pages === true,
    };
  }

  private remotePost(body: unknown): Required<WordPressPostResponse> | null {
    if (!body || typeof body !== 'object') return null;
    const post = body as WordPressPostResponse;
    if (!['string', 'number'].includes(typeof post.id)) return null;
    return {
      id: post.id!,
      link: typeof post.link === 'string' ? post.link : '',
      slug: typeof post.slug === 'string' ? post.slug : '',
      status: typeof post.status === 'string' ? post.status : '',
      content:
        post.content && typeof post.content === 'object'
          ? {
              raw: typeof post.content.raw === 'string' ? post.content.raw : '',
            }
          : { raw: '' },
    };
  }

  private sha256(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private safeRemoteLink(siteUrl: string, value: string) {
    if (!value) return null;
    try {
      const site = new URL(siteUrl);
      const remote = new URL(value);
      return remote.protocol === 'https:' && remote.origin === site.origin
        ? remote.toString()
        : null;
    } catch {
      return null;
    }
  }

  private isUniqueViolation(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private connectionSelect() {
    return {
      id: true,
      websiteId: true,
      siteUrl: true,
      remoteUserId: true,
      remoteUserName: true,
      username: true,
      canCreatePosts: true,
      canCreatePages: true,
      status: true,
      connectionVersion: true,
      lastVerifiedAt: true,
      disconnectedAt: true,
      createdAt: true,
      updatedAt: true,
    } satisfies Prisma.WordPressConnectionSelect;
  }

  private approvalSelect() {
    return {
      id: true,
      documentId: true,
      actionItemId: true,
      documentRevision: true,
      postType: true,
      contentDigest: true,
      operationKey: true,
      connectionVersion: true,
      revokedAt: true,
      createdAt: true,
    } satisfies Prisma.WordPressDraftApprovalSelect;
  }
}
