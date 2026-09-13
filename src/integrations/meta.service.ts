import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const DEFAULT_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'instagram_basic',
];
const ALLOWED_READ_SCOPES = new Set([
  'pages_show_list',
  'pages_read_engagement',
  'read_insights',
  'instagram_basic',
  'instagram_manage_insights',
]);

interface OAuthState {
  organizationId: string;
  userId: string;
  issuedAt: number;
  nonce: string;
}

interface MetaTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

interface MetaUser {
  id?: string;
  name?: string;
}

interface MetaPermission {
  permission?: string;
  status?: string;
}

interface MetaPermissionsResponse {
  data?: MetaPermission[];
}

interface MetaInstagramAccount {
  id?: string;
  username?: string;
}

interface MetaPage {
  id?: string;
  name?: string;
  access_token?: string;
  tasks?: string[];
  instagram_business_account?: MetaInstagramAccount;
}

interface MetaPageListResponse {
  data?: MetaPage[];
}

interface MetaPageProfile {
  id?: string;
  name?: string;
  fan_count?: number;
  followers_count?: number;
  talking_about_count?: number;
}

interface MetaInstagramProfile {
  id?: string;
  username?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
}

interface MetaInstagramMedia {
  id?: string;
  caption?: string;
  media_type?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

interface MetaInstagramMediaResponse {
  data?: MetaInstagramMedia[];
}

interface MetaGraphErrorResponse {
  error?: {
    message?: string;
    type?: string;
    code?: number;
  };
}

@Injectable()
export class MetaService {
  private readonly logger = new Logger(MetaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  getAuthorizationUrl(organizationId: string, userId: string) {
    const url = new URL(
      `https://www.facebook.com/${this.apiVersion()}/dialog/oauth`,
    );
    url.searchParams.set('client_id', this.appId());
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.configuredScopes().join(','));
    url.searchParams.set(
      'state',
      this.signState({
        organizationId,
        userId,
        issuedAt: Date.now(),
        nonce: randomBytes(16).toString('hex'),
      }),
    );
    return url.toString();
  }

  async completeAuthorization(code: string, state: string) {
    if (!code || !state) {
      throw new BadRequestException('Réponse OAuth Meta incomplète.');
    }

    const oauthState = this.verifyState(state);
    const organization = await this.prisma.organization.findFirst({
      where: { id: oauthState.organizationId, ownerId: oauthState.userId },
      select: { id: true },
    });
    if (!organization) {
      throw new UnauthorizedException('Organisation OAuth invalide.');
    }

    const shortToken = await this.exchangeAuthorizationCode(code);
    if (!shortToken.access_token) {
      throw new BadGatewayException("Meta n'a pas fourni de jeton d'accès.");
    }
    const longToken = await this.exchangeLongLivedToken(shortToken.access_token);
    if (!longToken.access_token) {
      throw new BadGatewayException(
        "Meta n'a pas fourni de jeton d'accès longue durée.",
      );
    }

    const accessToken = longToken.access_token;
    const [user, permissions, pages, existing] = await Promise.all([
      this.graphGet<MetaUser>('me', accessToken, { fields: 'id,name' }),
      this.graphGet<MetaPermissionsResponse>('me/permissions', accessToken),
      this.fetchPages(accessToken),
      this.prisma.metaConnection.findUnique({
        where: { organizationId: organization.id },
      }),
    ]);

    const grantedScopes = this.grantedScopes(permissions);
    this.assertRequiredScopes(grantedScopes);
    const selectablePages = this.selectablePages(pages);
    const selectedPage =
      selectablePages.find((page) => page.id === existing?.selectedPageId) ??
      (selectablePages.length === 1 ? selectablePages[0] : undefined);

    await this.prisma.metaConnection.upsert({
      where: { organizationId: organization.id },
      create: {
        organizationId: organization.id,
        metaUserId: user.id ?? null,
        metaUserName: user.name ?? null,
        encryptedUserAccessToken: this.encrypt(accessToken),
        grantedScopes: grantedScopes.join(','),
        selectedPageId: selectedPage?.id ?? null,
        selectedPageName: selectedPage?.name ?? null,
        encryptedPageAccessToken: selectedPage?.accessToken
          ? this.encrypt(selectedPage.accessToken)
          : null,
        selectedInstagramAccountId:
          selectedPage?.instagramAccount?.id ?? null,
        selectedInstagramUsername:
          selectedPage?.instagramAccount?.username ?? null,
      },
      update: {
        metaUserId: user.id ?? null,
        metaUserName: user.name ?? null,
        encryptedUserAccessToken: this.encrypt(accessToken),
        grantedScopes: grantedScopes.join(','),
        selectedPageId: selectedPage?.id ?? null,
        selectedPageName: selectedPage?.name ?? null,
        encryptedPageAccessToken: selectedPage?.accessToken
          ? this.encrypt(selectedPage.accessToken)
          : null,
        selectedInstagramAccountId:
          selectedPage?.instagramAccount?.id ?? null,
        selectedInstagramUsername:
          selectedPage?.instagramAccount?.username ?? null,
        connectedAt: new Date(),
      },
    });

    return { connected: true };
  }

  async getStatus(organizationId: string) {
    const connection = await this.prisma.metaConnection.findUnique({
      where: { organizationId },
      select: {
        metaUserId: true,
        metaUserName: true,
        grantedScopes: true,
        selectedPageId: true,
        selectedPageName: true,
        selectedInstagramAccountId: true,
        selectedInstagramUsername: true,
        connectedAt: true,
        lastSyncedAt: true,
      },
    });

    return connection
      ? {
          connected: true,
          metaUserId: connection.metaUserId,
          metaUserName: connection.metaUserName,
          grantedScopes: this.splitScopes(connection.grantedScopes),
          requiredScopes: this.configuredScopes(),
          selectedPageId: connection.selectedPageId,
          selectedPageName: connection.selectedPageName,
          selectedInstagramAccountId: connection.selectedInstagramAccountId,
          selectedInstagramUsername: connection.selectedInstagramUsername,
          connectedAt: connection.connectedAt,
          lastSyncedAt: connection.lastSyncedAt,
          readOnly: true,
          scoreInfluence: false,
        }
      : {
          connected: false,
          metaUserId: null,
          metaUserName: null,
          grantedScopes: [],
          requiredScopes: this.configuredScopes(),
          selectedPageId: null,
          selectedPageName: null,
          selectedInstagramAccountId: null,
          selectedInstagramUsername: null,
          connectedAt: null,
          lastSyncedAt: null,
          readOnly: true,
          scoreInfluence: false,
        };
  }

  async listAssets(organizationId: string) {
    const connection = await this.authorizedConnection(organizationId);
    const pages = this.selectablePages(
      await this.fetchPages(this.decrypt(connection.encryptedUserAccessToken)),
    );

    return pages.map((page) => ({
      pageId: page.id,
      pageName: page.name,
      tasks: page.tasks,
      instagramAccount: page.instagramAccount,
      selected: page.id === connection.selectedPageId,
    }));
  }

  async selectPage(organizationId: string, pageId: string) {
    const normalizedPageId = pageId.trim();
    if (!normalizedPageId) {
      throw new BadRequestException('Page Meta invalide.');
    }

    const connection = await this.authorizedConnection(organizationId);
    const pages = this.selectablePages(
      await this.fetchPages(this.decrypt(connection.encryptedUserAccessToken)),
    );
    const selectedPage = pages.find((page) => page.id === normalizedPageId);
    if (!selectedPage) {
      throw new BadRequestException(
        "Cette Page Facebook n'est pas accessible avec ce compte Meta.",
      );
    }

    await this.prisma.metaConnection.update({
      where: { organizationId },
      data: {
        selectedPageId: selectedPage.id,
        selectedPageName: selectedPage.name,
        encryptedPageAccessToken: this.encrypt(selectedPage.accessToken),
        selectedInstagramAccountId: selectedPage.instagramAccount?.id ?? null,
        selectedInstagramUsername:
          selectedPage.instagramAccount?.username ?? null,
      },
    });

    return {
      pageId: selectedPage.id,
      pageName: selectedPage.name,
      instagramAccount: selectedPage.instagramAccount,
    };
  }

  async getPerformance(organizationId: string) {
    const connection = await this.authorizedConnection(organizationId);
    if (!connection.selectedPageId || !connection.encryptedPageAccessToken) {
      throw new BadRequestException(
        "Sélectionnez d'abord une Page Facebook accessible.",
      );
    }

    const pageToken = this.decrypt(connection.encryptedPageAccessToken);
    const page = await this.graphGet<MetaPageProfile>(
      connection.selectedPageId,
      pageToken,
      { fields: 'id,name,fan_count,followers_count,talking_about_count' },
    );

    let instagram: MetaInstagramProfile | null = null;
    let recentInstagramMedia: MetaInstagramMedia[] = [];
    if (connection.selectedInstagramAccountId) {
      instagram = await this.graphGet<MetaInstagramProfile>(
        connection.selectedInstagramAccountId,
        pageToken,
        {
          fields:
            'id,username,followers_count,follows_count,media_count',
        },
      );
      try {
        const media = await this.graphGet<MetaInstagramMediaResponse>(
          `${connection.selectedInstagramAccountId}/media`,
          pageToken,
          {
            fields:
              'id,caption,media_type,permalink,timestamp,like_count,comments_count',
            limit: '10',
          },
        );
        recentInstagramMedia = media.data ?? [];
      } catch (error) {
        this.logger.warn(
          `Meta recent media unavailable for organization=${organizationId}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }

    const lastSyncedAt = new Date();
    await this.prisma.metaConnection.update({
      where: { organizationId },
      data: { lastSyncedAt },
    });

    return {
      source: 'meta',
      readOnly: true,
      scoreInfluence: false,
      lastSyncedAt,
      facebook: {
        pageId: page.id ?? connection.selectedPageId,
        pageName: page.name ?? connection.selectedPageName,
        fanCount: page.fan_count ?? null,
        followersCount: page.followers_count ?? null,
        talkingAboutCount: page.talking_about_count ?? null,
      },
      instagram: instagram
        ? {
            accountId:
              instagram.id ?? connection.selectedInstagramAccountId,
            username:
              instagram.username ?? connection.selectedInstagramUsername,
            followersCount: instagram.followers_count ?? null,
            followsCount: instagram.follows_count ?? null,
            mediaCount: instagram.media_count ?? null,
            recentMedia: recentInstagramMedia.map((media) => ({
              id: media.id ?? null,
              caption: media.caption ?? null,
              mediaType: media.media_type ?? null,
              permalink: media.permalink ?? null,
              timestamp: media.timestamp ?? null,
              likeCount: media.like_count ?? null,
              commentsCount: media.comments_count ?? null,
            })),
          }
        : null,
    };
  }

  async disconnect(organizationId: string) {
    await this.prisma.metaConnection.deleteMany({ where: { organizationId } });
    return { disconnected: true };
  }

  getDashboardRedirect(status: 'connected' | 'denied' | 'error') {
    const url = new URL('/analyse', this.dashboardUrl());
    url.searchParams.set('meta', status);
    return url.toString();
  }

  private async authorizedConnection(organizationId: string) {
    const connection = await this.prisma.metaConnection.findUnique({
      where: { organizationId },
    });
    if (!connection) {
      throw new NotFoundException("Meta n'est pas connecté pour cette organisation.");
    }
    return connection;
  }

  private async fetchPages(accessToken: string) {
    return this.graphGet<MetaPageListResponse>('me/accounts', accessToken, {
      fields:
        'id,name,access_token,tasks,instagram_business_account{id,username}',
      limit: '100',
    });
  }

  private selectablePages(response: MetaPageListResponse) {
    return (response.data ?? [])
      .filter(
        (page): page is MetaPage & { id: string; name: string; access_token: string } =>
          Boolean(page.id && page.name && page.access_token),
      )
      .map((page) => ({
        id: page.id,
        name: page.name,
        accessToken: page.access_token,
        tasks: page.tasks ?? [],
        instagramAccount: page.instagram_business_account?.id
          ? {
              id: page.instagram_business_account.id,
              username: page.instagram_business_account.username ?? null,
            }
          : null,
      }));
  }

  private async exchangeAuthorizationCode(code: string) {
    return this.graphGet<MetaTokenResponse>('oauth/access_token', undefined, {
      client_id: this.appId(),
      client_secret: this.appSecret(),
      redirect_uri: this.redirectUri(),
      code,
    });
  }

  private async exchangeLongLivedToken(shortLivedToken: string) {
    return this.graphGet<MetaTokenResponse>('oauth/access_token', undefined, {
      grant_type: 'fb_exchange_token',
      client_id: this.appId(),
      client_secret: this.appSecret(),
      fb_exchange_token: shortLivedToken,
    });
  }

  private grantedScopes(response: MetaPermissionsResponse) {
    return (response.data ?? [])
      .filter((item) => item.status === 'granted' && item.permission)
      .map((item) => item.permission as string);
  }

  private assertRequiredScopes(grantedScopes: string[]) {
    const missing = this.configuredScopes().filter(
      (scope) => !grantedScopes.includes(scope),
    );
    if (missing.length > 0) {
      throw new UnauthorizedException(
        `Autorisations Meta en lecture seule absentes: ${missing.join(', ')}.`,
      );
    }
  }

  private async graphGet<T>(
    path: string,
    accessToken?: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const url = new URL(
      `${this.graphBaseUrl()}/${path.replace(/^\//, '')}`,
    );
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    if (accessToken) {
      url.searchParams.set('access_token', accessToken);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Meta est temporairement indisponible.',
      );
    }

    const payload = (await response.json().catch(() => ({}))) as
      | T
      | MetaGraphErrorResponse;
    if (!response.ok) {
      const graphError = payload as MetaGraphErrorResponse;
      throw new BadGatewayException(
        graphError.error?.message || 'Meta a refusé la requête.',
      );
    }
    return payload as T;
  }

  private graphBaseUrl() {
    return `https://graph.facebook.com/${this.apiVersion()}`;
  }

  private apiVersion() {
    const value =
      this.config.get<string>('META_GRAPH_API_VERSION')?.trim() || 'v26.0';
    if (!/^v\d+\.\d+$/.test(value)) {
      throw new ServiceUnavailableException(
        'META_GRAPH_API_VERSION doit respecter le format vNN.N.',
      );
    }
    return value;
  }

  private configuredScopes() {
    const raw = this.config.get<string>('META_OAUTH_SCOPES')?.trim();
    const scopes = raw
      ? raw
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean)
      : DEFAULT_SCOPES;
    const unsupported = scopes.filter(
      (scope) => !ALLOWED_READ_SCOPES.has(scope),
    );
    if (unsupported.length > 0) {
      throw new ServiceUnavailableException(
        `META_OAUTH_SCOPES contient des permissions non autorisées en RC18: ${unsupported.join(', ')}.`,
      );
    }
    return [...new Set(scopes)];
  }

  private splitScopes(value: string | null) {
    return value
      ? value
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean)
      : [];
  }

  private signState(state: OAuthState) {
    const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
    const signature = createHmac('sha256', this.stateSecret())
      .update(payload)
      .digest('base64url');
    return `${payload}.${signature}`;
  }

  private verifyState(signedState: string) {
    const [payload, signature, ...extra] = signedState.split('.');
    if (!payload || !signature || extra.length > 0) {
      throw new UnauthorizedException('État OAuth Meta invalide.');
    }
    const expected = createHmac('sha256', this.stateSecret())
      .update(payload)
      .digest('base64url');
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new UnauthorizedException('État OAuth Meta invalide.');
    }

    let state: OAuthState;
    try {
      state = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as OAuthState;
    } catch {
      throw new UnauthorizedException('État OAuth Meta invalide.');
    }
    if (
      !state.organizationId ||
      !state.userId ||
      !state.nonce ||
      !Number.isFinite(state.issuedAt) ||
      Date.now() - state.issuedAt > STATE_MAX_AGE_MS ||
      state.issuedAt - Date.now() > 30_000
    ) {
      throw new UnauthorizedException('État OAuth Meta expiré ou invalide.');
    }
    return state;
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  private decrypt(value: string) {
    const [version, ivValue, tagValue, ciphertextValue, ...extra] =
      value.split('.');
    if (
      version !== 'v1' ||
      !ivValue ||
      !tagValue ||
      !ciphertextValue ||
      extra.length > 0
    ) {
      throw new ServiceUnavailableException('Jeton Meta chiffré invalide.');
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey(),
        Buffer.from(ivValue, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException('Jeton Meta chiffré invalide.');
    }
  }

  private appId() {
    return this.required('META_APP_ID');
  }

  private appSecret() {
    return this.required('META_APP_SECRET');
  }

  private redirectUri() {
    return this.required('META_OAUTH_REDIRECT_URI');
  }

  private dashboardUrl() {
    return (
      this.config.get<string>('DASHBOARD_URL')?.trim() ||
      'https://app.robiacopilot.site'
    );
  }

  private encryptionKey() {
    return this.requiredHex('META_TOKEN_ENCRYPTION_KEY');
  }

  private stateSecret() {
    return this.requiredHex('META_OAUTH_STATE_SECRET');
  }

  private timeoutMs() {
    const value = Number(
      this.config.get<string>('META_GRAPH_TIMEOUT_MS')?.trim() || '10000',
    );
    return Number.isFinite(value) && value >= 1000 && value <= 30000
      ? value
      : 10000;
  }

  private required(name: string) {
    const value = this.config.get<string>(name)?.trim();
    if (!value || value === 'CHANGE_ME') {
      throw new ServiceUnavailableException(`${name} n'est pas configuré.`);
    }
    return value;
  }

  private requiredHex(name: string) {
    const value = this.required(name);
    if (!/^[0-9a-fA-F]{64}$/.test(value)) {
      throw new ServiceUnavailableException(
        `${name} doit contenir exactement 64 caractères hexadécimaux.`,
      );
    }
    return Buffer.from(value, 'hex');
  }
}
