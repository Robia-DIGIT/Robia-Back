import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const BUSINESS_PROFILE_SCOPE =
  'https://www.googleapis.com/auth/business.manage';
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const SYNC_CLAIM_LEASE_MS = 5 * 60 * 1000;
const SYNC_COOLDOWN_MS = 60 * 1000;
// Fields used by ROBIA's extended location-details view. Deliberately
// excludes relationshipData (chain/parent relationships), serviceItems (a
// large structured service catalogue only meaningful for a handful of
// business types) and adWordsLocationExtensions (Google-deprecated) — see
// docs/RC38_GOOGLE_BUSINESS_PROFILE_READONLY.md for the full rationale.
const LOCATION_READ_MASK = [
  'name',
  'languageCode',
  'title',
  'storeCode',
  'storefrontAddress',
  'phoneNumbers',
  'websiteUri',
  'categories',
  'regularHours',
  'specialHours',
  'moreHours',
  'serviceArea',
  'labels',
  'latlng',
  'openInfo',
  'metadata',
  'profile',
].join(',');

interface OAuthState {
  organizationId: string;
  userId: string;
  issuedAt: number;
  nonce: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
}

interface GoogleUserInfo {
  sub?: string;
  email?: string;
}

interface GoogleAccount {
  name: string;
  accountName?: string;
}

interface GoogleAccountsResponse {
  accounts?: GoogleAccount[];
  nextPageToken?: string;
}

interface GoogleCategory {
  displayName?: string;
}

interface GoogleLocation {
  name: string;
  languageCode?: string;
  title?: string;
  storeCode?: string;
  storefrontAddress?: Record<string, unknown>;
  phoneNumbers?: { primaryPhone?: string; additionalPhones?: string[] };
  websiteUri?: string;
  categories?: {
    primaryCategory?: GoogleCategory;
    additionalCategories?: GoogleCategory[];
  };
  regularHours?: Record<string, unknown>;
  specialHours?: Record<string, unknown>;
  moreHours?: Record<string, unknown>[];
  serviceArea?: Record<string, unknown>;
  labels?: string[];
  latlng?: { latitude?: number; longitude?: number };
  openInfo?: { status?: string; canReopen?: boolean; openingDate?: unknown };
  metadata?: Record<string, unknown>;
  profile?: { description?: string };
}

interface GoogleLocationsResponse {
  locations?: GoogleLocation[];
  nextPageToken?: string;
}

@Injectable()
export class GoogleBusinessProfileService {
  private readonly logger = new Logger(GoogleBusinessProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  getAuthorizationUrl(organizationId: string, userId: string) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', this.clientId());
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set(
      'scope',
      ['openid', 'email', BUSINESS_PROFILE_SCOPE].join(' '),
    );
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('prompt', 'consent');
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
      throw new BadRequestException('Réponse OAuth Google incomplète.');
    }
    const oauthState = this.verifyState(state);
    const organization = await this.prisma.organization.findFirst({
      where: { id: oauthState.organizationId, ownerId: oauthState.userId },
      select: { id: true },
    });
    if (!organization) {
      throw new UnauthorizedException('Organisation OAuth invalide.');
    }

    const tokens = await this.exchangeAuthorizationCode(code);
    if (!tokens.access_token) {
      throw new BadGatewayException("Google n'a pas fourni de jeton d'accès.");
    }
    if (!this.hasScope(tokens.scope, BUSINESS_PROFILE_SCOPE)) {
      throw new UnauthorizedException(
        "L'autorisation Google Business Profile est absente.",
      );
    }
    const userInfo = await this.googleGet<GoogleUserInfo>(
      'https://openidconnect.googleapis.com/v1/userinfo',
      tokens.access_token,
    );
    if (!userInfo.sub) {
      throw new BadGatewayException(
        "Google n'a pas fourni l'identité stable du compte.",
      );
    }
    const existing =
      await this.prisma.googleBusinessProfileConnection.findUnique({
        where: { organizationId: organization.id },
      });
    const sameAccount = existing?.googleAccountSubject === userInfo.sub;
    if (!tokens.refresh_token && (!existing || !sameAccount)) {
      throw new BadGatewayException(
        "Google n'a pas fourni de jeton de renouvellement pour ce compte. Recommencez la connexion.",
      );
    }
    const encryptedRefreshToken = tokens.refresh_token
      ? this.encrypt(tokens.refresh_token)
      : existing!.encryptedRefreshToken;
    const accountChanged = Boolean(existing && !sameAccount);

    await this.prisma.$transaction(async (tx) => {
      const connection = await tx.googleBusinessProfileConnection.upsert({
        where: { organizationId: organization.id },
        create: {
          organizationId: organization.id,
          googleAccountSubject: userInfo.sub,
          googleAccountEmail: userInfo.email ?? null,
          encryptedRefreshToken,
          grantedScopes: tokens.scope ?? null,
        },
        update: {
          googleAccountSubject: userInfo.sub,
          googleAccountEmail: userInfo.email ?? null,
          encryptedRefreshToken,
          grantedScopes: tokens.scope ?? null,
          connectedAt: new Date(),
          ...(accountChanged
            ? {
                lastSyncedAt: null,
                lastSyncAttemptAt: null,
                lastSyncStatus: 'never',
                syncClaimedAt: null,
                syncClaimToken: null,
              }
            : {}),
        },
      });
      if (accountChanged) {
        await tx.googleBusinessProfileLocation.deleteMany({
          where: { connectionId: connection.id },
        });
      }
    });
    return { connected: true };
  }

  async getStatus(organizationId: string) {
    const connection =
      await this.prisma.googleBusinessProfileConnection.findUnique({
        where: { organizationId },
        select: {
          googleAccountEmail: true,
          connectedAt: true,
          lastSyncedAt: true,
          lastSyncAttemptAt: true,
          lastSyncStatus: true,
          _count: { select: { locations: true } },
        },
      });
    return connection
      ? {
          connected: true,
          googleAccountEmail: connection.googleAccountEmail,
          connectedAt: connection.connectedAt,
          lastSyncedAt: connection.lastSyncedAt,
          lastSyncAttemptAt: connection.lastSyncAttemptAt,
          lastSyncStatus: connection.lastSyncStatus,
          locationCount: connection._count.locations,
        }
      : {
          connected: false,
          googleAccountEmail: null,
          connectedAt: null,
          lastSyncedAt: null,
          lastSyncAttemptAt: null,
          lastSyncStatus: 'never',
          locationCount: 0,
        };
  }

  async listLocations(organizationId: string) {
    return this.prisma.googleBusinessProfileLocation.findMany({
      where: { organizationId },
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      include: {
        robiaLocation: {
          select: {
            id: true,
            name: true,
            address: true,
            city: true,
            country: true,
          },
        },
      },
    });
  }

  async syncLocations(organizationId: string) {
    const connection =
      await this.prisma.googleBusinessProfileConnection.findUnique({
        where: { organizationId },
      });
    if (!connection) {
      throw new NotFoundException(
        "Google Business Profile n'est pas connecté.",
      );
    }
    const now = new Date();
    const claimToken = randomUUID();
    const claim = await this.prisma.googleBusinessProfileConnection.updateMany({
      where: {
        id: connection.id,
        OR: [
          { syncClaimedAt: null },
          {
            syncClaimedAt: {
              lt: new Date(now.getTime() - SYNC_CLAIM_LEASE_MS),
            },
          },
        ],
        AND: [
          {
            OR: [
              { lastSyncAttemptAt: null },
              {
                lastSyncAttemptAt: {
                  lte: new Date(now.getTime() - SYNC_COOLDOWN_MS),
                },
              },
            ],
          },
        ],
      },
      data: {
        syncClaimedAt: now,
        syncClaimToken: claimToken,
        lastSyncAttemptAt: now,
        lastSyncStatus: 'running',
      },
    });
    if (claim.count !== 1) {
      const fresh =
        await this.prisma.googleBusinessProfileConnection.findUnique({
          where: { id: connection.id },
          select: { syncClaimedAt: true, lastSyncAttemptAt: true },
        });
      if (
        fresh?.syncClaimedAt &&
        fresh.syncClaimedAt.getTime() > now.getTime() - SYNC_CLAIM_LEASE_MS
      ) {
        throw new ConflictException(
          'Une synchronisation Google Business Profile est déjà en cours.',
        );
      }
      throw new HttpException(
        'Une synchronisation Google Business Profile vient déjà d’être demandée. Réessayez dans une minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let finalized = false;
    try {
      const accessToken = await this.refreshAccessToken(
        this.decrypt(connection.encryptedRefreshToken),
      );
      const accounts = await this.fetchAccounts(accessToken);
      if (accounts.length === 0) {
        const locationCount =
          await this.prisma.googleBusinessProfileLocation.count({
            where: { connectionId: connection.id },
          });
        await this.releaseSyncClaim(connection.id, claimToken, 'partial');
        finalized = true;
        this.logger.warn(
          `GBP : aucun compte observé (organization=${organizationId}) — données précédentes conservées et dernière synchronisation réussie inchangée.`,
        );
        return {
          synced: false,
          status: 'partial' as const,
          locationCount,
          syncedAt: connection.lastSyncedAt,
        };
      }

      // Fetch every page from every account before starting any database
      // reconciliation. A failure halfway through Google pagination leaves
      // the existing mirror and ROBIA mappings untouched.
      const observed: Array<{
        account: GoogleAccount;
        location: GoogleLocation;
      }> = [];
      for (const account of accounts) {
        const locations = await this.fetchLocations(accessToken, account.name);
        for (const location of locations) {
          if (location.name) observed.push({ account, location });
        }
      }

      const syncedAt = new Date();
      const observedNames = [
        ...new Set(observed.map(({ location }) => location.name)),
      ];
      const committed = await this.prisma.$transaction(async (tx) => {
        // This conditional update both proves ownership and locks the
        // connection row until commit. A stale worker cannot interleave its
        // mirror writes with a newer claimant.
        const owned = await tx.googleBusinessProfileConnection.updateMany({
          where: { id: connection.id, syncClaimToken: claimToken },
          data: { syncClaimedAt: syncedAt },
        });
        if (owned.count !== 1) return false;
        for (const { account, location } of observed) {
          await tx.googleBusinessProfileLocation.upsert({
            where: {
              connectionId_googleLocationName: {
                connectionId: connection.id,
                googleLocationName: location.name,
              },
            },
            create: this.locationData(
              organizationId,
              connection.id,
              account,
              location,
              syncedAt,
            ),
            update: this.locationUpdate(account, location, syncedAt),
          });
        }
        await tx.googleBusinessProfileLocation.deleteMany({
          where: {
            connectionId: connection.id,
            ...(observedNames.length
              ? { googleLocationName: { notIn: observedNames } }
              : {}),
          },
        });
        const released = await tx.googleBusinessProfileConnection.updateMany({
          where: { id: connection.id, syncClaimToken: claimToken },
          data: {
            lastSyncedAt: syncedAt,
            lastSyncStatus: 'success',
            syncClaimedAt: null,
            syncClaimToken: null,
          },
        });
        return released.count === 1;
      });
      if (!committed) {
        throw new ConflictException(
          'La synchronisation a perdu son bail et son résultat a été ignoré.',
        );
      }
      finalized = true;
      return {
        synced: true,
        status: 'success' as const,
        locationCount: observedNames.length,
        syncedAt,
      };
    } finally {
      if (!finalized) {
        await this.releaseSyncClaim(connection.id, claimToken, 'failed').catch(
          () =>
            this.logger.warn(
              `GBP : impossible de libérer le bail de synchronisation (organization=${organizationId})`,
            ),
        );
      }
    }
  }

  private async releaseSyncClaim(
    connectionId: string,
    claimToken: string,
    status: 'partial' | 'failed',
  ) {
    await this.prisma.googleBusinessProfileConnection.updateMany({
      where: { id: connectionId, syncClaimToken: claimToken },
      data: {
        syncClaimedAt: null,
        syncClaimToken: null,
        lastSyncStatus: status,
      },
    });
  }

  async linkLocation(
    organizationId: string,
    googleLocationId: string,
    robiaLocationId: string,
  ) {
    const [googleLocation, robiaLocation] = await Promise.all([
      this.prisma.googleBusinessProfileLocation.findFirst({
        where: { id: googleLocationId, organizationId },
        select: { id: true },
      }),
      this.prisma.location.findFirst({
        where: { id: robiaLocationId, organizationId },
        select: { id: true },
      }),
    ]);
    if (!googleLocation || !robiaLocation) {
      throw new NotFoundException('Établissement introuvable.');
    }
    return this.prisma.googleBusinessProfileLocation.update({
      where: { id: googleLocation.id },
      data: { robiaLocationId: robiaLocation.id },
    });
  }

  async unlinkLocation(organizationId: string, googleLocationId: string) {
    const location = await this.prisma.googleBusinessProfileLocation.findFirst({
      where: { id: googleLocationId, organizationId },
      select: { id: true },
    });
    if (!location) throw new NotFoundException('Établissement introuvable.');
    return this.prisma.googleBusinessProfileLocation.update({
      where: { id: location.id },
      data: { robiaLocationId: null },
    });
  }

  async disconnect(organizationId: string) {
    const connection =
      await this.prisma.googleBusinessProfileConnection.findUnique({
        where: { organizationId },
      });
    if (!connection) return { disconnected: true };
    const token = this.decrypt(connection.encryptedRefreshToken);
    let response: Response;
    try {
      response = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
    } catch {
      this.logger.warn(
        `GBP : révocation Google indisponible (organization=${organizationId})`,
      );
      throw new ServiceUnavailableException(
        'Google n’a pas confirmé la révocation. La connexion ROBIA a été conservée afin de pouvoir réessayer.',
      );
    }
    if (!response.ok) {
      this.logger.warn(
        `GBP : révocation Google refusée avec le statut ${response.status} (organization=${organizationId})`,
      );
      throw new ServiceUnavailableException(
        'Google n’a pas confirmé la révocation. La connexion ROBIA a été conservée afin de pouvoir réessayer.',
      );
    }
    await this.prisma.googleBusinessProfileConnection.delete({
      where: { id: connection.id },
    });
    return { disconnected: true, revokedByGoogle: true };
  }

  getDashboardRedirect(status: 'connected' | 'denied' | 'error') {
    const url = new URL('/business-profile', this.dashboardUrl());
    url.searchParams.set('gbp', status);
    return url.toString();
  }

  async getIntelligenceSignal(organizationId: string) {
    const status = await this.getStatus(organizationId);
    if (!status.connected) {
      return { status: 'not_connected' as const, observedAt: null, data: null };
    }
    if (!status.lastSyncedAt) {
      return {
        status: 'not_configured' as const,
        observedAt: null,
        data: null,
      };
    }
    if (status.lastSyncStatus !== 'success') {
      return {
        status: 'partial' as const,
        observedAt: status.lastSyncedAt,
        data: { locationCount: status.locationCount },
      };
    }
    return {
      status: 'ok' as const,
      observedAt: status.lastSyncedAt,
      data: { locationCount: status.locationCount },
    };
  }

  private async fetchAccounts(accessToken: string) {
    const accounts: GoogleAccount[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(
        'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
      );
      url.searchParams.set('pageSize', '20');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response = await this.googleGet<GoogleAccountsResponse>(
        url.toString(),
        accessToken,
      );
      accounts.push(...(response.accounts ?? []).filter((item) => item.name));
      pageToken = response.nextPageToken;
    } while (pageToken);
    return accounts;
  }

  private async fetchLocations(accessToken: string, accountName: string) {
    const locations: GoogleLocation[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations`,
      );
      url.searchParams.set('readMask', LOCATION_READ_MASK);
      url.searchParams.set('pageSize', '100');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response = await this.googleGet<GoogleLocationsResponse>(
        url.toString(),
        accessToken,
      );
      locations.push(...(response.locations ?? []));
      pageToken = response.nextPageToken;
    } while (pageToken);
    return locations;
  }

  private locationData(
    organizationId: string,
    connectionId: string,
    account: GoogleAccount,
    location: GoogleLocation,
    syncedAt: Date,
  ): Prisma.GoogleBusinessProfileLocationUncheckedCreateInput {
    const values = this.locationValues(account, location, syncedAt);
    return {
      organizationId,
      connectionId,
      googleAccountName: account.name,
      ...values,
    };
  }

  private locationUpdate(
    account: GoogleAccount,
    location: GoogleLocation,
    syncedAt: Date,
  ): Prisma.GoogleBusinessProfileLocationUncheckedUpdateInput {
    return this.locationValues(account, location, syncedAt);
  }

  private locationValues(
    account: GoogleAccount,
    location: GoogleLocation,
    syncedAt: Date,
  ) {
    const additionalCategories = (
      location.categories?.additionalCategories ?? []
    )
      .map((category) => category.displayName)
      .filter((name): name is string => Boolean(name));
    return {
      accountDisplayName: account.accountName ?? null,
      googleLocationName: location.name,
      languageCode: location.languageCode ?? null,
      title: location.title?.trim() || 'Établissement sans nom',
      storeCode: location.storeCode ?? null,
      address:
        (location.storefrontAddress as Prisma.InputJsonValue) ??
        Prisma.JsonNull,
      primaryPhone: location.phoneNumbers?.primaryPhone ?? null,
      additionalPhones: location.phoneNumbers?.additionalPhones ?? [],
      websiteUri: location.websiteUri ?? null,
      primaryCategory:
        location.categories?.primaryCategory?.displayName ?? null,
      additionalCategories,
      description: location.profile?.description ?? null,
      regularHours:
        (location.regularHours as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      specialHours:
        (location.specialHours as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      moreHours:
        (location.moreHours as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      serviceArea:
        (location.serviceArea as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      labels: location.labels ?? [],
      latitude: location.latlng?.latitude ?? null,
      longitude: location.latlng?.longitude ?? null,
      openStatus: location.openInfo?.status ?? null,
      metadata: (location.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      lastSyncedAt: syncedAt,
    };
  }

  private async exchangeAuthorizationCode(code: string) {
    const body = new URLSearchParams({
      code,
      client_id: this.clientId(),
      client_secret: this.clientSecret(),
      redirect_uri: this.redirectUri(),
      grant_type: 'authorization_code',
    });
    return this.googlePost<GoogleTokenResponse>(
      'https://oauth2.googleapis.com/token',
      body,
    );
  }

  private async refreshAccessToken(refreshToken: string) {
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: this.clientId(),
      client_secret: this.clientSecret(),
      grant_type: 'refresh_token',
    });
    const response = await this.googlePost<GoogleTokenResponse>(
      'https://oauth2.googleapis.com/token',
      body,
    );
    if (!response.access_token) {
      throw new ServiceUnavailableException(
        'La connexion Google a expiré. Reconnectez Business Profile.',
      );
    }
    return response.access_token;
  }

  private async googleGet<T>(url: string, accessToken: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Google Business Profile est indisponible.',
      );
    }
    if (!response.ok) {
      throw new BadGatewayException(
        `Google Business Profile a refusé la lecture (${response.status}).`,
      );
    }
    return response.json() as Promise<T>;
  }

  private async googlePost<T>(url: string, body: URLSearchParams): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
    } catch {
      throw new ServiceUnavailableException('OAuth Google est indisponible.');
    }
    if (!response.ok) {
      throw new BadGatewayException(
        `OAuth Google a échoué (${response.status}).`,
      );
    }
    return response.json() as Promise<T>;
  }

  private hasScope(scopes: string | null | undefined, expected: string) {
    return Boolean(scopes?.split(' ').includes(expected));
  }

  private signState(state: OAuthState) {
    const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
    const signature = createHmac('sha256', this.stateSecret())
      .update(payload)
      .digest('base64url');
    return `${payload}.${signature}`;
  }

  private verifyState(value: string): OAuthState {
    const [payload, signature, extra] = value.split('.');
    if (!payload || !signature || extra) {
      throw new UnauthorizedException('État OAuth invalide.');
    }
    const expected = createHmac('sha256', this.stateSecret())
      .update(payload)
      .digest();
    const received = Buffer.from(signature, 'base64url');
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      throw new UnauthorizedException('État OAuth invalide.');
    }
    let state: OAuthState;
    try {
      state = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as OAuthState;
    } catch {
      throw new UnauthorizedException('État OAuth invalide.');
    }
    const age = Date.now() - state.issuedAt;
    if (
      !state.organizationId ||
      !state.userId ||
      !state.nonce ||
      !Number.isFinite(state.issuedAt) ||
      age < -60_000 ||
      age > STATE_MAX_AGE_MS
    ) {
      throw new UnauthorizedException('État OAuth expiré ou invalide.');
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
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  private decrypt(value: string) {
    const [version, ivValue, tagValue, ciphertextValue, extra] =
      value.split('.');
    if (
      version !== 'v1' ||
      !ivValue ||
      !tagValue ||
      !ciphertextValue ||
      extra
    ) {
      throw new ServiceUnavailableException('Jeton Google chiffré invalide.');
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
      throw new ServiceUnavailableException('Jeton Google illisible.');
    }
  }

  private required(name: string) {
    const value = this.config.get<string>(name)?.trim();
    if (!value)
      throw new ServiceUnavailableException(
        `Intégration Google non configurée (${name}).`,
      );
    return value;
  }

  private requiredHex(name: string) {
    const value = this.required(name);
    if (!/^[0-9a-f]{64}$/i.test(value)) {
      throw new ServiceUnavailableException(
        `Intégration Google non configurée (${name}).`,
      );
    }
    return Buffer.from(value, 'hex');
  }

  private clientId() {
    return this.required('GOOGLE_OAUTH_CLIENT_ID');
  }
  private clientSecret() {
    return this.required('GOOGLE_OAUTH_CLIENT_SECRET');
  }
  private redirectUri() {
    return this.required('GOOGLE_BUSINESS_PROFILE_REDIRECT_URI');
  }
  private encryptionKey() {
    return this.requiredHex('GOOGLE_TOKEN_ENCRYPTION_KEY');
  }
  private stateSecret() {
    return this.requiredHex('GOOGLE_OAUTH_STATE_SECRET');
  }
  private dashboardUrl() {
    return (
      this.config.get<string>('DASHBOARD_URL')?.trim() ||
      'https://app.robiacopilot.site'
    );
  }
  private timeoutMs() {
    const value = Number(
      this.config.get<string>('GOOGLE_BUSINESS_PROFILE_TIMEOUT_MS', '10000'),
    );
    return Number.isFinite(value) && value >= 1000 && value <= 30000
      ? value
      : 10000;
  }
}
