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

const SEARCH_CONSOLE_SCOPE =
  'https://www.googleapis.com/auth/webmasters.readonly';
const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

interface OAuthState {
  organizationId: string;
  userId: string;
  issuedAt: number;
  nonce: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

interface GoogleUserInfo {
  email?: string;
}

interface SearchConsoleSite {
  siteUrl: string;
  permissionLevel: string;
}

interface SearchConsoleSitesResponse {
  siteEntry?: SearchConsoleSite[];
}

interface SearchAnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
}

interface AnalyticsPropertySummary {
  property?: string;
  displayName?: string;
  propertyType?: string;
}

interface AnalyticsAccountSummary {
  account?: string;
  displayName?: string;
  propertySummaries?: AnalyticsPropertySummary[];
}

interface AnalyticsAccountSummariesResponse {
  accountSummaries?: AnalyticsAccountSummary[];
  nextPageToken?: string;
}

interface AnalyticsValue {
  value?: string;
}

interface AnalyticsReportRow {
  dimensionValues?: AnalyticsValue[];
  metricValues?: AnalyticsValue[];
}

interface AnalyticsReportResponse {
  rows?: AnalyticsReportRow[];
}

type SearchConsoleUnavailableReason =
  'not_connected' | 'no_property_selected' | 'not_synced_recently';

/**
 * Additive, audit-attached Search Console evidence (RC-13). Same
 * status/unavailableReason contract as PageSpeedInsightsResult (RC-10):
 * never thrown, never influences global_score/seo_score_v2 — a future
 * tranche decides whether and how these signals feed the score.
 */
export interface SearchConsoleAuditSignals {
  status: 'ok' | 'unavailable';
  source: 'search_console';
  siteUrl: string | null;
  period: { startDate: string; endDate: string } | null;
  summary: {
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  } | null;
  lastSyncedAt: Date | null;
  unavailableReason: SearchConsoleUnavailableReason | null;
}

@Injectable()
export class GoogleSearchConsoleService {
  private readonly logger = new Logger(GoogleSearchConsoleService.name);

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
      ['openid', 'email', SEARCH_CONSOLE_SCOPE, ANALYTICS_SCOPE].join(' '),
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
    if (!tokens.scope?.split(' ').includes(SEARCH_CONSOLE_SCOPE)) {
      throw new UnauthorizedException(
        "L'autorisation Search Console en lecture seule est absente.",
      );
    }
    if (!tokens.scope?.split(' ').includes(ANALYTICS_SCOPE)) {
      throw new UnauthorizedException(
        "L'autorisation Google Analytics en lecture seule est absente.",
      );
    }

    const existing = await this.prisma.googleSearchConsoleConnection.findUnique(
      {
        where: { organizationId: organization.id },
      },
    );
    const encryptedRefreshToken = tokens.refresh_token
      ? this.encrypt(tokens.refresh_token)
      : existing?.encryptedRefreshToken;
    if (!encryptedRefreshToken) {
      throw new BadGatewayException(
        "Google n'a pas fourni de jeton de renouvellement.",
      );
    }

    const [userInfo, sites] = await Promise.all([
      this.fetchGoogleUserInfo(tokens.access_token),
      this.fetchSites(tokens.access_token),
    ]);
    const selectableSites = this.selectableSites(sites);
    const previousSelection = selectableSites.find(
      (site) => site.siteUrl === existing?.selectedSiteUrl,
    );
    const selectedSite =
      previousSelection ??
      (selectableSites.length === 1 ? selectableSites[0] : undefined);

    await this.prisma.googleSearchConsoleConnection.upsert({
      where: { organizationId: organization.id },
      create: {
        organizationId: organization.id,
        googleAccountEmail: userInfo.email ?? null,
        encryptedRefreshToken,
        grantedScopes: tokens.scope ?? null,
        selectedSiteUrl: selectedSite?.siteUrl ?? null,
        permissionLevel: selectedSite?.permissionLevel ?? null,
      },
      update: {
        googleAccountEmail: userInfo.email ?? null,
        encryptedRefreshToken,
        grantedScopes: tokens.scope ?? null,
        selectedSiteUrl: selectedSite?.siteUrl ?? null,
        permissionLevel: selectedSite?.permissionLevel ?? null,
        connectedAt: new Date(),
      },
    });

    return { connected: true };
  }

  async getStatus(organizationId: string) {
    const connection =
      await this.prisma.googleSearchConsoleConnection.findUnique({
        where: { organizationId },
        select: {
          googleAccountEmail: true,
          selectedSiteUrl: true,
          permissionLevel: true,
          connectedAt: true,
          lastSyncedAt: true,
          lastAnalyticsSyncedAt: true,
          selectedAnalyticsPropertyId: true,
          selectedAnalyticsPropertyName: true,
          grantedScopes: true,
        },
      });

    return connection
      ? {
          connected: true,
          googleAccountEmail: connection.googleAccountEmail,
          selectedSiteUrl: connection.selectedSiteUrl,
          permissionLevel: connection.permissionLevel,
          connectedAt: connection.connectedAt,
          lastSyncedAt: connection.lastSyncedAt,
          selectedAnalyticsPropertyId: connection.selectedAnalyticsPropertyId,
          selectedAnalyticsPropertyName:
            connection.selectedAnalyticsPropertyName,
          lastAnalyticsSyncedAt: connection.lastAnalyticsSyncedAt,
          analyticsAuthorized: this.hasScope(
            connection.grantedScopes,
            ANALYTICS_SCOPE,
          ),
        }
      : {
          connected: false,
          googleAccountEmail: null,
          selectedSiteUrl: null,
          permissionLevel: null,
          connectedAt: null,
          lastSyncedAt: null,
          selectedAnalyticsPropertyId: null,
          selectedAnalyticsPropertyName: null,
          lastAnalyticsSyncedAt: null,
          analyticsAuthorized: false,
        };
  }

  async listAnalyticsProperties(organizationId: string) {
    const { connection, accessToken } =
      await this.authorizedConnection(organizationId);
    this.requireAnalyticsScope(connection.grantedScopes);
    const properties = await this.fetchAnalyticsProperties(accessToken);
    return properties.map((property) => ({
      ...property,
      selected: property.propertyId === connection.selectedAnalyticsPropertyId,
    }));
  }

  async selectAnalyticsProperty(organizationId: string, propertyId: string) {
    const normalizedId = propertyId.trim();
    const { connection, accessToken } =
      await this.authorizedConnection(organizationId);
    this.requireAnalyticsScope(connection.grantedScopes);
    const property = (await this.fetchAnalyticsProperties(accessToken)).find(
      (candidate) => candidate.propertyId === normalizedId,
    );
    if (!property) {
      throw new BadRequestException(
        "Cette propriété Google Analytics n'est pas accessible avec ce compte.",
      );
    }
    await this.prisma.googleSearchConsoleConnection.update({
      where: { organizationId },
      data: {
        selectedAnalyticsPropertyId: property.propertyId,
        selectedAnalyticsPropertyName: property.displayName,
      },
    });
    return property;
  }

  async getAnalyticsPerformance(organizationId: string) {
    const { connection, accessToken } =
      await this.authorizedConnection(organizationId);
    this.requireAnalyticsScope(connection.grantedScopes);
    if (!connection.selectedAnalyticsPropertyId) {
      throw new BadRequestException(
        "Sélectionnez d'abord une propriété Google Analytics.",
      );
    }

    const endDate = new Date();
    endDate.setUTCHours(0, 0, 0, 0);
    endDate.setUTCDate(endDate.getUTCDate() - 1);
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - 27);
    const period = {
      startDate: this.formatDate(startDate),
      endDate: this.formatDate(endDate),
    };
    const dateRanges = [
      { startDate: period.startDate, endDate: period.endDate },
    ];
    const propertyId = connection.selectedAnalyticsPropertyId;
    const [summaryResponse, dailyResponse, pagesResponse] = await Promise.all([
      this.runAnalyticsReport(accessToken, propertyId, {
        dateRanges,
        metrics: [
          { name: 'activeUsers' },
          { name: 'totalUsers' },
          { name: 'sessions' },
          { name: 'screenPageViews' },
          { name: 'engagementRate' },
        ],
      }),
      this.runAnalyticsReport(accessToken, propertyId, {
        dateRanges,
        dimensions: [{ name: 'date' }],
        metrics: [
          { name: 'activeUsers' },
          { name: 'sessions' },
          { name: 'screenPageViews' },
        ],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
        limit: '100',
      }),
      this.runAnalyticsReport(accessToken, propertyId, {
        dateRanges,
        dimensions: [{ name: 'pagePathPlusQueryString' }],
        metrics: [
          { name: 'screenPageViews' },
          { name: 'activeUsers' },
          { name: 'sessions' },
        ],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: '10',
      }),
    ]);
    const summaryValues = summaryResponse.rows?.[0]?.metricValues ?? [];
    const numberAt = (values: AnalyticsValue[], index: number) =>
      Number(values[index]?.value ?? 0);
    const daily = (dailyResponse.rows ?? []).map((row) => ({
      date: this.analyticsDate(row.dimensionValues?.[0]?.value ?? ''),
      activeUsers: numberAt(row.metricValues ?? [], 0),
      sessions: numberAt(row.metricValues ?? [], 1),
      views: numberAt(row.metricValues ?? [], 2),
    }));
    const topPages = (pagesResponse.rows ?? []).map((row) => ({
      path: row.dimensionValues?.[0]?.value ?? '',
      views: numberAt(row.metricValues ?? [], 0),
      activeUsers: numberAt(row.metricValues ?? [], 1),
      sessions: numberAt(row.metricValues ?? [], 2),
    }));
    const syncedAt = new Date();
    await this.prisma.googleSearchConsoleConnection.update({
      where: { id: connection.id },
      data: { lastAnalyticsSyncedAt: syncedAt },
    });
    return {
      propertyId,
      propertyName: connection.selectedAnalyticsPropertyName,
      ...period,
      summary: {
        activeUsers: numberAt(summaryValues, 0),
        totalUsers: numberAt(summaryValues, 1),
        sessions: numberAt(summaryValues, 2),
        views: numberAt(summaryValues, 3),
        engagementRate: numberAt(summaryValues, 4),
      },
      daily,
      topPages,
      lastSyncedAt: syncedAt,
    };
  }

  async listSites(organizationId: string) {
    const { connection, accessToken } =
      await this.authorizedConnection(organizationId);
    const sites = this.selectableSites(await this.fetchSites(accessToken));
    return sites.map((site) => ({
      ...site,
      selected: site.siteUrl === connection.selectedSiteUrl,
    }));
  }

  async selectSite(organizationId: string, siteUrl: string) {
    const normalizedSiteUrl = siteUrl.trim();
    const { accessToken } = await this.authorizedConnection(organizationId);
    const site = this.selectableSites(await this.fetchSites(accessToken)).find(
      (candidate) => candidate.siteUrl === normalizedSiteUrl,
    );
    if (!site) {
      throw new BadRequestException(
        "Cette propriété Search Console n'est pas accessible avec ce compte.",
      );
    }

    await this.prisma.googleSearchConsoleConnection.update({
      where: { organizationId },
      data: {
        selectedSiteUrl: site.siteUrl,
        permissionLevel: site.permissionLevel,
      },
    });
    return {
      selectedSiteUrl: site.siteUrl,
      permissionLevel: site.permissionLevel,
    };
  }

  async getPerformance(organizationId: string) {
    const { connection, accessToken } =
      await this.authorizedConnection(organizationId);
    if (!connection.selectedSiteUrl) {
      throw new BadRequestException(
        "Sélectionnez d'abord une propriété Search Console.",
      );
    }

    const endDate = new Date();
    endDate.setUTCHours(0, 0, 0, 0);
    endDate.setUTCDate(endDate.getUTCDate() - 1);
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - 27);
    const period = {
      startDate: this.formatDate(startDate),
      endDate: this.formatDate(endDate),
    };

    const [dailyResponse, queryResponse, pageResponse] = await Promise.all([
      this.queryAnalytics(accessToken, connection.selectedSiteUrl, {
        ...period,
        dimensions: ['date'],
        rowLimit: 100,
      }),
      this.queryAnalytics(accessToken, connection.selectedSiteUrl, {
        ...period,
        dimensions: ['query'],
        rowLimit: 10,
      }),
      this.queryAnalytics(accessToken, connection.selectedSiteUrl, {
        ...period,
        dimensions: ['page'],
        rowLimit: 10,
      }),
    ]);

    const daily = this.metricRows(dailyResponse.rows).filter((row) =>
      /^\d{4}-\d{2}-\d{2}$/.test(row.key),
    );
    const syncedAt = new Date();
    await this.prisma.$transaction([
      ...daily.map((row) =>
        this.prisma.googleSearchConsoleDailyMetric.upsert({
          where: {
            connectionId_date: {
              connectionId: connection.id,
              date: new Date(`${row.key}T00:00:00.000Z`),
            },
          },
          create: {
            connectionId: connection.id,
            date: new Date(`${row.key}T00:00:00.000Z`),
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          },
          update: {
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          },
        }),
      ),
      this.prisma.googleSearchConsoleConnection.update({
        where: { id: connection.id },
        data: { lastSyncedAt: syncedAt },
      }),
    ]);

    return {
      siteUrl: connection.selectedSiteUrl,
      ...period,
      summary: this.summarize(daily),
      daily,
      topQueries: this.metricRows(queryResponse.rows),
      topPages: this.metricRows(pageResponse.rows),
      lastSyncedAt: syncedAt,
    };
  }

  /**
   * Read-only Search Console signals for attaching to an audit result
   * (RC-13). Unlike getPerformance(), this never calls the Google API —
   * it only reads whatever was already persisted the last time the
   * dashboard synced (googleSearchConsoleDailyMetric, populated by
   * getPerformance()). That's a deliberate choice: the audit pipeline
   * runs synchronously today (see audits.service.ts), and bolting a live
   * Google Search Analytics call onto it would add latency and quota
   * risk to every audit run, for an organization that may not even be
   * looking at the audit-in-progress. A stale-but-real snapshot is more
   * useful here than a live call that could stall or fail the audit.
   * Never throws — mirrors the PageSpeedInsightsResult contract from
   * RC-10 (status/unavailableReason, additive, audit-blocking-free).
   */
  async getSearchConsoleSignalsForAudit(
    organizationId: string,
  ): Promise<SearchConsoleAuditSignals> {
    const connection =
      await this.prisma.googleSearchConsoleConnection.findUnique({
        where: { organizationId },
        select: { id: true, selectedSiteUrl: true, lastSyncedAt: true },
      });

    const unavailable = (
      reason: SearchConsoleUnavailableReason,
    ): SearchConsoleAuditSignals => ({
      status: 'unavailable',
      source: 'search_console',
      siteUrl: connection?.selectedSiteUrl ?? null,
      period: null,
      summary: null,
      lastSyncedAt: connection?.lastSyncedAt ?? null,
      unavailableReason: reason,
    });

    if (!connection) {
      return unavailable('not_connected');
    }
    if (!connection.selectedSiteUrl) {
      return unavailable('no_property_selected');
    }

    const endDate = new Date();
    endDate.setUTCHours(0, 0, 0, 0);
    endDate.setUTCDate(endDate.getUTCDate() - 1);
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - 27);

    const dailyMetrics =
      await this.prisma.googleSearchConsoleDailyMetric.findMany({
        where: {
          connectionId: connection.id,
          date: { gte: startDate, lte: endDate },
        },
      });

    // Covers both "never synced" and "last sync fell outside the last 28
    // days" — either way there is nothing recent enough to attach.
    if (dailyMetrics.length === 0) {
      return unavailable('not_synced_recently');
    }

    const rows = dailyMetrics.map((metric) => ({
      key: this.formatDate(metric.date),
      clicks: metric.clicks,
      impressions: metric.impressions,
      ctr: metric.ctr,
      position: metric.position,
    }));

    return {
      status: 'ok',
      source: 'search_console',
      siteUrl: connection.selectedSiteUrl,
      period: {
        startDate: this.formatDate(startDate),
        endDate: this.formatDate(endDate),
      },
      summary: this.summarize(rows),
      lastSyncedAt: connection.lastSyncedAt,
      unavailableReason: null,
    };
  }

  async disconnect(organizationId: string) {
    await this.prisma.googleSearchConsoleConnection.deleteMany({
      where: { organizationId },
    });
    return { disconnected: true };
  }

  getDashboardRedirect(status: 'connected' | 'denied' | 'error') {
    const url = new URL('/google-data', this.dashboardUrl());
    url.searchParams.set('google', status);
    return url.toString();
  }

  private async authorizedConnection(organizationId: string) {
    const connection =
      await this.prisma.googleSearchConsoleConnection.findUnique({
        where: { organizationId },
      });
    if (!connection) {
      throw new NotFoundException("Search Console n'est pas connecté.");
    }
    const accessToken = await this.refreshAccessToken(
      this.decrypt(connection.encryptedRefreshToken),
    );
    return { connection, accessToken };
  }

  private async exchangeAuthorizationCode(code: string) {
    return this.tokenRequest({
      code,
      client_id: this.clientId(),
      client_secret: this.clientSecret(),
      redirect_uri: this.redirectUri(),
      grant_type: 'authorization_code',
    });
  }

  private async refreshAccessToken(refreshToken: string) {
    const tokens = await this.tokenRequest({
      refresh_token: refreshToken,
      client_id: this.clientId(),
      client_secret: this.clientSecret(),
      grant_type: 'refresh_token',
    });
    if (!tokens.access_token) {
      throw new UnauthorizedException(
        'La connexion Google a expiré. Reconnectez Search Console.',
      );
    }
    return tokens.access_token;
  }

  private async tokenRequest(values: Record<string, string>) {
    const response = await this.googleRequest(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values),
      },
      'échange OAuth',
    );
    return (await response.json()) as GoogleTokenResponse;
  }

  private async fetchGoogleUserInfo(accessToken: string) {
    const response = await this.googleRequest(
      'https://openidconnect.googleapis.com/v1/userinfo',
      { headers: { Authorization: `Bearer ${accessToken}` } },
      'identité du compte',
    );
    return (await response.json()) as GoogleUserInfo;
  }

  private async fetchSites(accessToken: string) {
    const response = await this.googleRequest(
      'https://www.googleapis.com/webmasters/v3/sites',
      { headers: { Authorization: `Bearer ${accessToken}` } },
      'liste des propriétés',
    );
    return (await response.json()) as SearchConsoleSitesResponse;
  }

  private async queryAnalytics(
    accessToken: string,
    siteUrl: string,
    body: Record<string, unknown>,
  ) {
    const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const response = await this.googleRequest(
      endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      'données de performance',
    );
    return (await response.json()) as SearchAnalyticsResponse;
  }

  private async fetchAnalyticsProperties(accessToken: string) {
    const properties: Array<{
      propertyId: string;
      displayName: string;
      accountName: string;
      propertyType: string;
    }> = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(
        'https://analyticsadmin.googleapis.com/v1beta/accountSummaries',
      );
      url.searchParams.set('pageSize', '200');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response = await this.googleRequest(
        url.toString(),
        { headers: { Authorization: `Bearer ${accessToken}` } },
        'liste des propriétés Analytics',
      );
      const body = (await response.json()) as AnalyticsAccountSummariesResponse;
      for (const account of body.accountSummaries ?? []) {
        for (const property of account.propertySummaries ?? []) {
          const propertyId = property.property?.replace(/^properties\//, '');
          if (!propertyId || !/^\d+$/.test(propertyId)) continue;
          properties.push({
            propertyId,
            displayName: property.displayName || `Propriété ${propertyId}`,
            accountName: account.displayName || account.account || '',
            propertyType: property.propertyType || '',
          });
        }
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    return properties;
  }

  private async runAnalyticsReport(
    accessToken: string,
    propertyId: string,
    body: Record<string, unknown>,
  ) {
    const response = await this.googleRequest(
      `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      'données Analytics',
    );
    return (await response.json()) as AnalyticsReportResponse;
  }

  private async googleRequest(
    url: string,
    init: RequestInit,
    operation: string,
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        this.logger.warn(
          `Google ${operation} refusé : HTTP ${response.status}`,
        );
        if (response.status === 401 || response.status === 403) {
          throw new UnauthorizedException(
            'Google a refusé cette autorisation. Reconnectez votre compte Google.',
          );
        }
        throw new BadGatewayException(
          `Le service Google est temporairement indisponible (${response.status}).`,
        );
      }
      return response;
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof BadGatewayException
      ) {
        throw error;
      }
      this.logger.warn(`Google ${operation} inaccessible`);
      throw new BadGatewayException(
        'Le service Google est temporairement inaccessible.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private selectableSites(response: SearchConsoleSitesResponse) {
    return (response.siteEntry ?? []).filter(
      (site) =>
        typeof site.siteUrl === 'string' &&
        typeof site.permissionLevel === 'string' &&
        site.permissionLevel !== 'siteUnverifiedUser',
    );
  }

  private hasScope(scopes: string | null | undefined, scope: string) {
    return scopes?.split(' ').includes(scope) ?? false;
  }

  private requireAnalyticsScope(scopes: string | null | undefined) {
    if (!this.hasScope(scopes, ANALYTICS_SCOPE)) {
      throw new UnauthorizedException(
        'Reconnectez Google pour autoriser Analytics en lecture seule.',
      );
    }
  }

  private metricRows(rows: SearchAnalyticsRow[] | undefined) {
    return (rows ?? []).map((row) => ({
      key: row.keys?.[0] ?? '',
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      ctr: Number(row.ctr ?? 0),
      position: Number(row.position ?? 0),
    }));
  }

  private summarize(
    rows: ReturnType<GoogleSearchConsoleService['metricRows']>,
  ) {
    const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
    const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
    const weightedPosition = rows.reduce(
      (sum, row) => sum + row.position * row.impressions,
      0,
    );
    return {
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position: impressions > 0 ? weightedPosition / impressions : 0,
    };
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
    let received: Buffer;
    try {
      received = Buffer.from(signature, 'base64url');
    } catch {
      throw new UnauthorizedException('État OAuth invalide.');
    }
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
    if (!value) {
      throw new ServiceUnavailableException(
        `Intégration Google non configurée (${name}).`,
      );
    }
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
    return this.required('GOOGLE_OAUTH_REDIRECT_URI');
  }

  private dashboardUrl() {
    return (
      this.config.get<string>('DASHBOARD_URL')?.trim() ||
      'https://app.robiacopilot.site'
    );
  }

  private encryptionKey() {
    return this.requiredHex('GOOGLE_TOKEN_ENCRYPTION_KEY');
  }

  private stateSecret() {
    return this.requiredHex('GOOGLE_OAUTH_STATE_SECRET');
  }

  private timeoutMs() {
    const value = Number(
      this.config.get<string>('GOOGLE_SEARCH_CONSOLE_TIMEOUT_MS', '10000'),
    );
    return Number.isFinite(value) && value >= 1000 && value <= 30000
      ? value
      : 10000;
  }

  private formatDate(value: Date) {
    return value.toISOString().slice(0, 10);
  }

  private analyticsDate(value: string) {
    return /^\d{8}$/.test(value)
      ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
      : value;
  }
}
