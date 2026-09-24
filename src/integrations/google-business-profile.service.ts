import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
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
// RC-40.1 — Google's Business Profile APIs terms: stored content "must be
// stored temporarily" and must not be kept "for more than 30 calendar
// days". This applies to the location fiche too, not just reviews (RC-40).
//
// Two numbers, two different jobs — never conflate them:
//   - LOCATIONS_STALE_AFTER_MS is a freshness TARGET: the cadence the
//     scheduled refresh below aims for. Missing it (a revoked token, Google
//     down) does not by itself violate anything.
//   - LOCATIONS_ABSOLUTE_EXPIRY_MS is the actual compliance CEILING: once a
//     fiche's last successful sync is older than this, it is purged and
//     never served again, unconditionally — whether or not the refresh
//     token is still valid, whether or not Google is reachable at all. The
//     refresh cadence is what keeps data usable in the common case; the
//     absolute expiry + purge below is what actually guarantees the 30-day
//     limit is never exceeded, even under a permanent failure.
// See docs/RC38_GOOGLE_BUSINESS_PROFILE_READONLY.md.
const LOCATIONS_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const LOCATIONS_ABSOLUTE_EXPIRY_MS = 29 * 24 * 60 * 60 * 1000;
// Scheduled refresh dispatcher: deterministic, bounded batch (oldest-first)
// so a growing customer base can never turn one cron tick into an
// unbounded fan-out of Google calls. Processed sequentially, not with
// bounded concurrency: each entry already does its own full Google
// pagination internally, and capping at LOCATIONS_REFRESH_BATCH_SIZE per
// hourly tick already bounds the total Google call volume — adding a
// concurrency pool would only reduce wall-clock time, not call volume, at
// the cost of bursting several organizations' Google calls at once.
const LOCATIONS_REFRESH_BATCH_SIZE = 50;
// A connection whose last attempt failed OR was partial is not retried
// every hour indefinitely (a revoked token would otherwise be hammered
// 24x/day for nothing) — it waits out this backoff, derived from
// lastSyncStatus/lastSyncAttemptAt (no new column), before the scheduler
// considers it again. Comfortably retried many times over before
// LOCATIONS_ABSOLUTE_EXPIRY_MS is reached, so a transient outage still
// recovers well before data would be purged.
const LOCATIONS_FAILURE_BACKOFF_MS = 6 * 60 * 60 * 1000;
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
// Reviews remain under the legacy `mybusiness.googleapis.com/v4` surface —
// Google has not split review read/reply into one of the newer dedicated
// Business Profile APIs the way it did for accounts/locations/performance.
// Only listed here for documentation; the URL is built directly per call
// since v4's path shape (`{account}/{location}/reviews`) doesn't fit a
// readMask constant. See docs/RC40_GOOGLE_BUSINESS_PROFILE_REVIEWS_
// PERFORMANCE.md — replying to a review is explicitly out of scope.
const REVIEWS_PAGE_SIZE = 50;
// RC-40 fix — Google's GBP API terms cap third-party storage of API content
// at 30 days. This mirror targets 24h freshness, far under that ceiling:
// every stored review (and the cached aggregate rating/count alongside it)
// expires 24h after the sync that produced it, enforced at every read path
// (never served past expiry, even before the purge cron runs) and by the
// hourly purge cron itself. See docs/RC40_GOOGLE_BUSINESS_PROFILE_REVIEWS_
// PERFORMANCE.md for the full retention policy.
const REVIEWS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REVIEWS_SYNC_CLAIM_LEASE_MS = 5 * 60 * 1000;
const REVIEWS_SYNC_COOLDOWN_MS = 60 * 1000;
// RC-40 fix — server-side quota protection for the Performance API read
// path, independent of the frontend's disabled button. No performance data
// is cached: the claim only guards concurrency/quota, and is released as
// soon as the read completes (success or failure).
const PERFORMANCE_CLAIM_LEASE_MS = 5 * 60 * 1000;
const PERFORMANCE_COOLDOWN_MS = 60 * 1000;
const STAR_RATING_VALUES: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};
// The Performance API's own metric identifiers. Deliberately excludes
// booking/food-order/menu-click metrics (BUSINESS_BOOKINGS,
// BUSINESS_FOOD_ORDERS, BUSINESS_FOOD_MENU_CLICKS) — meaningful only for a
// handful of business types and not worth the extra request weight here.
const PERFORMANCE_METRICS = [
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
  'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'BUSINESS_CONVERSATIONS',
  'BUSINESS_DIRECTION_REQUESTS',
  'CALL_CLICKS',
  'WEBSITE_CLICKS',
] as const;
const PERFORMANCE_WINDOW_DAYS = 30;

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

interface GoogleReviewReply {
  comment?: string;
  updateTime?: string;
}

interface GoogleReview {
  name: string;
  reviewer?: { displayName?: string; profilePhotoUrl?: string };
  starRating?: string;
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: GoogleReviewReply;
}

interface GoogleReviewsResponse {
  reviews?: GoogleReview[];
  averageRating?: number;
  totalReviewCount?: number;
  nextPageToken?: string;
}

interface GoogleDatedValue {
  date?: { year?: number; month?: number; day?: number };
  value?: string;
}

interface GoogleDailyMetricTimeSeries {
  dailyMetric?: string;
  timeSeries?: { datedValues?: GoogleDatedValue[] };
}

interface GooglePerformanceResponse {
  multiDailyMetricTimeSeries?: Array<{
    dailyMetricTimeSeries?: GoogleDailyMetricTimeSeries[];
  }>;
}

@Injectable()
export class GoogleBusinessProfileService implements OnModuleInit {
  private readonly logger = new Logger(GoogleBusinessProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // RC-40.1 fix — the hourly purge cron leaves a window (up to ~1h, or far
  // longer under a prolonged scheduler outage) where an already-expired
  // fiche sits in the database unpurged; every read path independently
  // filters it out (defense in depth), but running the purge once at boot
  // closes that window immediately after a deploy/restart instead of
  // waiting for the next tick. Safe to call any time: purgeExpiredLocations
  // is a plain, idempotent DELETE keyed only on lastSyncedAt age, so calling
  // it twice in quick succession (e.g. a fast restart loop) just no-ops the
  // second time. Never allowed to block or fail startup.
  async onModuleInit() {
    await this.purgeExpiredLocations().catch((error) => {
      this.logger.warn(
        `GBP : purge au démarrage impossible : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
      );
    });
  }

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
        },
      });
    if (!connection) {
      return {
        connected: false,
        googleAccountEmail: null,
        connectedAt: null,
        lastSyncedAt: null,
        lastSyncAttemptAt: null,
        lastSyncStatus: 'never',
        locationCount: 0,
        stale: false,
        expired: false,
      };
    }
    // RC-40.1 fix — two distinct, honest signals instead of one:
    //   - `stale` is the freshness target (24h) — missing it just means the
    //     scheduled refresh may be struggling; nothing has been discarded.
    //   - `expired` is the absolute compliance ceiling (29 days, safely
    //     under Google's 30-day cap) — once true, the fiche has actually
    //     been purged (see purgeExpiredLocations()) and locationCount below
    //     already reflects that, independent of whether the refresh token
    //     is still valid or Google is reachable at all.
    //
    // `stale` is measured from lastSyncedAt when present, but falls back to
    // connectedAt for a connection that has never completed a sync yet — a
    // freshly-connected organization has had no chance to sync at all, so
    // treating it as immediately "stale" (measuring from a null timestamp)
    // would show a false "automatic refresh seems to be failing" warning
    // seconds after connecting. It only becomes stale once 24h have passed
    // without a first success. `expired`, by contrast, is deliberately
    // measured from lastSyncedAt alone, never connectedAt: it reflects how
    // long actual Google-sourced content has been sitting in storage, which
    // is undefined (and irrelevant — there is nothing to expire) before a
    // first successful sync.
    const staleReferenceAt = connection.lastSyncedAt ?? connection.connectedAt;
    const staleAgeMs = Date.now() - staleReferenceAt.getTime();
    const stale = staleAgeMs > LOCATIONS_STALE_AFTER_MS;
    const expiryAgeMs = connection.lastSyncedAt
      ? Date.now() - connection.lastSyncedAt.getTime()
      : null;
    const expired =
      expiryAgeMs !== null && expiryAgeMs > LOCATIONS_ABSOLUTE_EXPIRY_MS;
    const locationCount = await this.prisma.googleBusinessProfileLocation.count(
      {
        where: {
          organizationId,
          lastSyncedAt: {
            gt: new Date(Date.now() - LOCATIONS_ABSOLUTE_EXPIRY_MS),
          },
        },
      },
    );
    return {
      connected: true,
      googleAccountEmail: connection.googleAccountEmail,
      connectedAt: connection.connectedAt,
      lastSyncedAt: connection.lastSyncedAt,
      lastSyncAttemptAt: connection.lastSyncAttemptAt,
      lastSyncStatus: connection.lastSyncStatus,
      locationCount,
      stale,
      expired,
    };
  }

  async listLocations(organizationId: string) {
    // RC-40.1 fix — the absolute compliance ceiling: a fiche whose last
    // successful sync is older than Google's 30-day storage cap (with
    // margin) is never returned, regardless of why it never got refreshed
    // (revoked token, Google outage, or simply not purged yet — this filter
    // is what guarantees it, not the purge cron's schedule).
    return this.prisma.googleBusinessProfileLocation.findMany({
      where: {
        organizationId,
        lastSyncedAt: {
          gt: new Date(Date.now() - LOCATIONS_ABSOLUTE_EXPIRY_MS),
        },
      },
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
        select: { id: true },
      });
    if (!connection) {
      throw new NotFoundException(
        "Google Business Profile n'est pas connecté.",
      );
    }
    return this.runLocationsSync(connection.id, organizationId);
  }

  // RC-40.1 fix — takes only connectionId/organizationId, never a
  // connection object. The claim is acquired first, purely from those two
  // identifiers; only AFTER it succeeds does this method read the
  // connection's refresh token / Google account subject / lastSyncedAt —
  // and only that post-claim read is ever used. This closes a race where
  // OAuth reconnects to a different Google account (completeAuthorization's
  // upsert overwrites the same row, same id) between a caller's lookup and
  // the claim: a pre-claim snapshot could otherwise carry account A's
  // already-superseded token into a sync that only /looks/ like it belongs
  // to the connection. If a reconnection instead lands mid-flight (after
  // this read, before the final transaction), the transaction's own
  // ownership re-proof (unchanged below) still catches it — that path was
  // already correct.
  private async runLocationsSync(connectionId: string, organizationId: string) {
    const now = new Date();
    const claimToken = randomUUID();
    const claim = await this.prisma.googleBusinessProfileConnection.updateMany({
      where: {
        id: connectionId,
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
          where: { id: connectionId },
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
      // Fresh read, strictly after the claim succeeded — never a value
      // carried over from before it.
      const connection =
        await this.prisma.googleBusinessProfileConnection.findUnique({
          where: { id: connectionId },
        });
      if (!connection) {
        throw new NotFoundException(
          "Google Business Profile n'est pas connecté.",
        );
      }
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
        await this.releaseSyncClaim(connectionId, claimToken, 'failed').catch(
          () =>
            this.logger.warn(
              `GBP : impossible de libérer le bail de synchronisation (organization=${organizationId})`,
            ),
        );
      }
    }
  }

  // RC-40.1 — automatic scheduled refresh of the location fiche, so an
  // organization that never re-clicks "Synchroniser" never keeps a
  // Google-sourced copy in storage indefinitely. Runs hourly; deterministic
  // and bounded (capped batch, no refresh token ever loaded for the scan) so
  // a growing customer base can't turn one tick into an unbounded fan-out of
  // Google calls. A connection whose last attempt failed or was partial
  // backs off instead of being retried every hour — see
  // LOCATIONS_FAILURE_BACKOFF_MS. It drives runLocationsSync() through the
  // exact same claim/lease as a manual sync, so the two can never race, and
  // that method's own fresh post-claim read is what actually gets used —
  // this scan intentionally carries no account-specific data at all. One
  // organization's failure (revoked token, transient Google error, or
  // simply a concurrent manual sync already holding the claim) is logged
  // and skipped — it must never stop the batch for every other connection.
  // Sequential by design, not bounded concurrency: see
  // LOCATIONS_REFRESH_BATCH_SIZE above for why.
  //
  // Ordering fix — a batch this small (50) next to a growing customer base
  // must never let a block of permanently-failing connections starve out
  // everyone else: ordering primarily by `lastSyncedAt` (as an earlier
  // version of this dispatcher did) is exactly that trap, because a
  // connection stuck in a failure loop never advances its `lastSyncedAt` at
  // all, so it keeps sorting first forever, crowding out connections that
  // have never even had a first attempt. Ordering primarily by
  // `lastSyncAttemptAt` instead fixes this structurally: every attempt
  // (success, failure, or partial) advances it to "now", so a
  // repeatedly-failing connection's turn moves to the back of the queue
  // after each try, and a connection that has NEVER been attempted
  // (`lastSyncAttemptAt: null`) always sorts first via `nulls: 'first'` —
  // it can never be starved out by any number of already-tried connections,
  // however many are failing. `lastSyncedAt` remains the tiebreaker among
  // connections with the same attempt recency, and `id` the final one for
  // full determinism.
  @Cron(CronExpression.EVERY_HOUR)
  async refreshStaleLocations() {
    const staleBefore = new Date(Date.now() - LOCATIONS_STALE_AFTER_MS);
    const failureBackoffBefore = new Date(
      Date.now() - LOCATIONS_FAILURE_BACKOFF_MS,
    );
    const claimLeaseBefore = new Date(Date.now() - SYNC_CLAIM_LEASE_MS);
    const connections =
      await this.prisma.googleBusinessProfileConnection.findMany({
        where: {
          OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: staleBefore } }],
          AND: [
            {
              OR: [
                { lastSyncStatus: { notIn: ['failed', 'partial'] } },
                { lastSyncAttemptAt: { lt: failureBackoffBefore } },
              ],
            },
            // A connection whose claim lease is still active (a manual
            // sync, or another worker, already holds it) is excluded from
            // the scan itself rather than merely failing its claim attempt
            // once selected — so it never consumes one of the batch's 50
            // slots at another connection's expense. runLocationsSync()'s
            // own claim/lease check remains the authority against a race
            // (a claim acquired between this scan and the claim attempt
            // below is still handled correctly, just less commonly hit).
            {
              OR: [
                { syncClaimedAt: null },
                { syncClaimedAt: { lt: claimLeaseBefore } },
              ],
            },
          ],
        },
        select: { id: true, organizationId: true },
        orderBy: [
          { lastSyncAttemptAt: { sort: 'asc', nulls: 'first' } },
          { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
          { id: 'asc' },
        ],
        take: LOCATIONS_REFRESH_BATCH_SIZE,
      });
    for (const connection of connections) {
      try {
        await this.runLocationsSync(connection.id, connection.organizationId);
      } catch (error) {
        this.logger.warn(
          `GBP : resynchronisation planifiée de la fiche ignorée (organization=${connection.organizationId}) : ${
            error instanceof Error ? error.message : 'erreur inconnue'
          }`,
        );
      }
    }
  }

  // RC-40.1 — the absolute compliance ceiling in force: unlike the refresh
  // above, this purge needs nothing from Google and cannot itself fail due
  // to a revoked token or a Google outage — it only ever reads/writes
  // ROBIA's own database, so it is what actually guarantees the fiche is
  // never kept past Google's 30-day storage cap even under a permanent
  // connection failure. listLocations()/getStatus() already filter out
  // anything past this ceiling on every read, independent of whether this
  // cron has run yet; this is hygiene, not the enforcement mechanism.
  //
  // Residual risk this doesn't cover: if this cron itself stops running for
  // a prolonged period (a stuck event loop, a scheduler registration bug,
  // an extended outage) with the process never restarting, already-expired
  // rows are never served (every read path filters independently) but do
  // keep sitting at rest in the database past the 30-day window until the
  // next boot's onModuleInit() purge or the next successful tick — a
  // storage-hygiene/compliance-posture gap, not a data-leak one. The
  // gbp_location_max_age_hours metric below is the signal to alert on for
  // this; because it is only emitted from within this same cron, a
  // scheduler outage also silences the metric that would reveal it, so
  // monitoring must alert on the metric's absence (no log line in the
  // expected window), not only on its value.
  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpiredLocations() {
    const expiredBefore = new Date(Date.now() - LOCATIONS_ABSOLUTE_EXPIRY_MS);
    const result = await this.prisma.googleBusinessProfileLocation.deleteMany({
      where: { lastSyncedAt: { lte: expiredBefore } },
    });
    if (result.count > 0) {
      this.logger.log(
        `GBP : purge de ${result.count} fiche(s) établissement expirée(s).`,
      );
    }
    await this.logLocationsRetentionMetric();
  }

  // RC-40.1 — operational visibility on the oldest still-present GBP
  // location row, emitted right after a purge pass (so it reflects the
  // ceiling actually in force, not a stale pre-purge value). No dedicated
  // metrics backend is wired up yet (same approach as
  // NotificationDispatcherService's/N8nWebhookService's structured `metric`
  // log lines) — this is a plain, structured log line an external alert can
  // match on. Under normal operation this should stay small (well under
  // ceilingHours); a value climbing towards the ceiling means the scheduled
  // refresh has itself been failing for a long time, undetected because
  // nothing here has actually violated the ceiling yet.
  private async logLocationsRetentionMetric() {
    const oldest = await this.prisma.googleBusinessProfileLocation.findFirst({
      orderBy: { lastSyncedAt: 'asc' },
      select: { lastSyncedAt: true },
    });
    if (!oldest) return;
    this.logger.log({
      metric: 'gbp_location_max_age_hours',
      ageHours: Math.round(
        (Date.now() - oldest.lastSyncedAt.getTime()) / (60 * 60 * 1000),
      ),
      ceilingHours: Math.round(LOCATIONS_ABSOLUTE_EXPIRY_MS / (60 * 60 * 1000)),
    });
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

  // RC-40.1 fix — routed through findOwnedLocation() (rather than a
  // standalone findFirst) so an expired fiche is exactly as unreachable
  // here as it is for reviews/performance: `.catch(() => null)` preserves
  // the original behavior of resolving both lookups in parallel and
  // collapsing either miss into the same NotFoundException.
  async linkLocation(
    organizationId: string,
    googleLocationId: string,
    robiaLocationId: string,
  ) {
    const [googleLocation, robiaLocation] = await Promise.all([
      this.findOwnedLocation(organizationId, googleLocationId).catch(
        () => null,
      ),
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
    const location = await this.findOwnedLocation(
      organizationId,
      googleLocationId,
    );
    return this.prisma.googleBusinessProfileLocation.update({
      where: { id: location.id },
      data: { robiaLocationId: null },
    });
  }

  // RC-40 — reviews and performance metrics for a single, organization-owned
  // location. Both read-only: neither ever writes back to Google (replying
  // to a review, in particular, is an explicit non-goal — see
  // docs/RC40_GOOGLE_BUSINESS_PROFILE_REVIEWS_PERFORMANCE.md).

  async listReviews(organizationId: string, locationId: string) {
    const location = await this.findOwnedLocation(organizationId, locationId);
    const now = new Date();
    const reviews = await this.prisma.googleBusinessProfileReview.findMany({
      where: { locationId: location.id, expiresAt: { gt: now } },
      orderBy: [{ createTime: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        // googleReviewName is Google's internal resource name — kept only
        // for the DB's own upsert idempotency key, never returned to the
        // API (no client use for it, and no reason to expose Google's raw
        // resource identifiers).
        reviewerDisplayName: true,
        starRating: true,
        comment: true,
        createTime: true,
        updateTime: true,
        replyComment: true,
        replyUpdateTime: true,
        lastSyncedAt: true,
        expiresAt: true,
      },
    });
    // Google's own averageRating/totalReviewCount are cached alongside the
    // reviews they summarize and expire on the exact same schedule — never
    // recomputed from the rows above. An expired or never-synced cache is
    // reported honestly as null rather than serving a stale aggregate.
    const cacheValid =
      Boolean(location.reviewsCacheExpiresAt) &&
      location.reviewsCacheExpiresAt! > now;
    return {
      reviews,
      averageRating: cacheValid ? location.reviewsAverageRating : null,
      totalReviewCount: cacheValid ? location.reviewsTotalReviewCount : null,
      lastSyncedAt: cacheValid ? location.reviewsLastSyncedAt : null,
      expiresAt: cacheValid ? location.reviewsCacheExpiresAt : null,
    };
  }

  async syncReviews(organizationId: string, locationId: string) {
    // Claim before any Google request, exactly like syncLocations: the
    // connection's access token is only refreshed once this worker holds
    // the claim, so a concurrent/cooldown rejection never costs a call.
    const { location, connection } = await this.findOwnedLocationWithConnection(
      organizationId,
      locationId,
    );
    const now = new Date();
    const claimToken = randomUUID();
    const claim = await this.prisma.googleBusinessProfileLocation.updateMany({
      where: {
        id: location.id,
        OR: [
          { reviewsSyncClaimedAt: null },
          {
            reviewsSyncClaimedAt: {
              lt: new Date(now.getTime() - REVIEWS_SYNC_CLAIM_LEASE_MS),
            },
          },
        ],
        AND: [
          {
            OR: [
              { reviewsLastSyncAttemptAt: null },
              {
                reviewsLastSyncAttemptAt: {
                  lte: new Date(now.getTime() - REVIEWS_SYNC_COOLDOWN_MS),
                },
              },
            ],
          },
        ],
      },
      data: {
        reviewsSyncClaimedAt: now,
        reviewsSyncClaimToken: claimToken,
        reviewsLastSyncAttemptAt: now,
        reviewsSyncStatus: 'running',
      },
    });
    if (claim.count !== 1) {
      const fresh = await this.prisma.googleBusinessProfileLocation.findUnique({
        where: { id: location.id },
        select: {
          reviewsSyncClaimedAt: true,
          reviewsLastSyncAttemptAt: true,
        },
      });
      if (
        fresh?.reviewsSyncClaimedAt &&
        fresh.reviewsSyncClaimedAt.getTime() >
          now.getTime() - REVIEWS_SYNC_CLAIM_LEASE_MS
      ) {
        throw new ConflictException(
          'Une synchronisation des avis est déjà en cours pour cet établissement.',
        );
      }
      throw new HttpException(
        'Une synchronisation des avis vient déjà d’être demandée. Réessayez dans une minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let finalized = false;
    try {
      const accessToken = await this.refreshAccessToken(
        this.decrypt(connection.encryptedRefreshToken),
      );
      const parent = `${location.googleAccountName}/${location.googleLocationName}`;
      const reviews: GoogleReview[] = [];
      let averageRating: number | null = null;
      let totalReviewCount: number | null = null;
      let pageToken: string | undefined;
      do {
        const url = new URL(
          `https://mybusiness.googleapis.com/v4/${parent}/reviews`,
        );
        url.searchParams.set('pageSize', String(REVIEWS_PAGE_SIZE));
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const response = await this.googleGet<GoogleReviewsResponse>(
          url.toString(),
          accessToken,
        );
        reviews.push(...(response.reviews ?? []).filter((item) => item.name));
        if (typeof response.averageRating === 'number') {
          averageRating = response.averageRating;
        }
        if (typeof response.totalReviewCount === 'number') {
          totalReviewCount = response.totalReviewCount;
        }
        pageToken = response.nextPageToken;
      } while (pageToken);

      // Every page is read before any write, exactly like syncLocations: a
      // failure halfway through pagination must never modify existing data.
      const syncedAt = new Date();
      const expiresAt = new Date(syncedAt.getTime() + REVIEWS_CACHE_TTL_MS);
      const observedNames = [...new Set(reviews.map((review) => review.name))];
      const committed = await this.prisma.$transaction(async (tx) => {
        // Proves claim ownership BEFORE any upsert/delete. If a newer
        // claimant has since taken over (this worker's token no longer
        // matches), no row is touched below.
        const owned = await tx.googleBusinessProfileLocation.updateMany({
          where: { id: location.id, reviewsSyncClaimToken: claimToken },
          data: { reviewsSyncClaimedAt: syncedAt },
        });
        if (owned.count !== 1) return false;
        for (const review of reviews) {
          await tx.googleBusinessProfileReview.upsert({
            where: {
              locationId_googleReviewName: {
                locationId: location.id,
                googleReviewName: review.name,
              },
            },
            create: {
              organizationId,
              locationId: location.id,
              ...this.reviewValues(review, syncedAt, expiresAt),
            },
            update: this.reviewValues(review, syncedAt, expiresAt),
          });
        }
        await tx.googleBusinessProfileReview.deleteMany({
          where: {
            locationId: location.id,
            ...(observedNames.length
              ? { googleReviewName: { notIn: observedNames } }
              : {}),
          },
        });
        const released = await tx.googleBusinessProfileLocation.updateMany({
          where: { id: location.id, reviewsSyncClaimToken: claimToken },
          data: {
            reviewsLastSyncedAt: syncedAt,
            reviewsSyncStatus: 'success',
            reviewsAverageRating: averageRating,
            reviewsTotalReviewCount: totalReviewCount,
            reviewsCacheExpiresAt: expiresAt,
            reviewsSyncClaimedAt: null,
            reviewsSyncClaimToken: null,
          },
        });
        return released.count === 1;
      });
      if (!committed) {
        throw new ConflictException(
          'La synchronisation des avis a perdu son bail et son résultat a été ignoré.',
        );
      }
      finalized = true;
      return {
        synced: true as const,
        reviewCount: observedNames.length,
        averageRating,
        totalReviewCount,
        syncedAt,
        expiresAt,
      };
    } finally {
      if (!finalized) {
        await this.releaseReviewsSyncClaim(
          location.id,
          claimToken,
          'failed',
        ).catch(() =>
          this.logger.warn(
            `GBP : impossible de libérer le bail de synchronisation des avis (location=${location.id})`,
          ),
        );
      }
    }
  }

  private async releaseReviewsSyncClaim(
    locationId: string,
    claimToken: string,
    status: 'partial' | 'failed',
  ) {
    await this.prisma.googleBusinessProfileLocation.updateMany({
      where: { id: locationId, reviewsSyncClaimToken: claimToken },
      data: {
        reviewsSyncClaimedAt: null,
        reviewsSyncClaimToken: null,
        reviewsSyncStatus: status,
      },
    });
  }

  // RC-40 fix — hourly purge of expired reviews. Every read path already
  // filters expired rows out (see listReviews), so this cron is a hygiene
  // sweep, not the enforcement mechanism: nothing expired is ever served
  // even in the (up to ~1h) window before this runs.
  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpiredReviews() {
    const result = await this.prisma.googleBusinessProfileReview.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    if (result.count > 0) {
      this.logger.log(`GBP : purge de ${result.count} avis expirés.`);
    }
  }

  async getPerformanceMetrics(organizationId: string, locationId: string) {
    // Claim before any Google request, same rationale as syncReviews: the
    // access token is only refreshed once the claim is held.
    const { location, connection } = await this.findOwnedLocationWithConnection(
      organizationId,
      locationId,
    );
    const now = new Date();
    const claimToken = randomUUID();
    const claim = await this.prisma.googleBusinessProfileLocation.updateMany({
      where: {
        id: location.id,
        OR: [
          { performanceClaimedAt: null },
          {
            performanceClaimedAt: {
              lt: new Date(now.getTime() - PERFORMANCE_CLAIM_LEASE_MS),
            },
          },
        ],
        AND: [
          {
            OR: [
              { performanceLastAttemptAt: null },
              {
                performanceLastAttemptAt: {
                  lte: new Date(now.getTime() - PERFORMANCE_COOLDOWN_MS),
                },
              },
            ],
          },
        ],
      },
      data: {
        performanceClaimedAt: now,
        performanceClaimToken: claimToken,
        performanceLastAttemptAt: now,
      },
    });
    if (claim.count !== 1) {
      const fresh = await this.prisma.googleBusinessProfileLocation.findUnique({
        where: { id: location.id },
        select: {
          performanceClaimedAt: true,
          performanceLastAttemptAt: true,
        },
      });
      if (
        fresh?.performanceClaimedAt &&
        fresh.performanceClaimedAt.getTime() >
          now.getTime() - PERFORMANCE_CLAIM_LEASE_MS
      ) {
        throw new ConflictException(
          'Une lecture des performances Google est déjà en cours pour cet établissement.',
        );
      }
      throw new HttpException(
        'Trop de lectures des performances Google pour cet établissement. Réessayez dans une minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let finalized = false;
    try {
      const accessToken = await this.refreshAccessToken(
        this.decrypt(connection.encryptedRefreshToken),
      );
      const endDate = new Date();
      endDate.setUTCHours(0, 0, 0, 0);
      endDate.setUTCDate(endDate.getUTCDate() - 1);
      const startDate = new Date(endDate);
      startDate.setUTCDate(
        startDate.getUTCDate() - (PERFORMANCE_WINDOW_DAYS - 1),
      );

      const url = new URL(
        `https://businessprofileperformance.googleapis.com/v1/${location.googleLocationName}:fetchMultiDailyMetricsTimeSeries`,
      );
      for (const metric of PERFORMANCE_METRICS) {
        url.searchParams.append('dailyMetrics', metric);
      }
      this.setDatePart(url, 'dailyRange.start_date', startDate);
      this.setDatePart(url, 'dailyRange.end_date', endDate);

      const response = await this.googleGet<GooglePerformanceResponse>(
        url.toString(),
        accessToken,
      );
      // Fix — Google can return several DailyMetricTimeSeries for the same
      // dailyMetric (e.g. split by dailySubEntityType). Each date within a
      // metric must be summed across every series that reports it, never
      // replaced by whichever series happens to be read last.
      const byMetric = new Map<string, Map<string, number>>();
      for (const group of response.multiDailyMetricTimeSeries ?? []) {
        for (const series of group.dailyMetricTimeSeries ?? []) {
          if (!series.dailyMetric) continue;
          const byDate =
            byMetric.get(series.dailyMetric) ?? new Map<string, number>();
          for (const dated of series.timeSeries?.datedValues ?? []) {
            const date = this.datePartsToIso(dated.date);
            if (!date) continue;
            const parsed = Number(dated.value ?? 0);
            const value = Number.isFinite(parsed) ? parsed : 0;
            byDate.set(date, (byDate.get(date) ?? 0) + value);
          }
          byMetric.set(series.dailyMetric, byDate);
        }
      }

      const dates: string[] = [];
      for (
        let cursor = new Date(startDate);
        cursor.getTime() <= endDate.getTime();
        cursor.setUTCDate(cursor.getUTCDate() + 1)
      ) {
        dates.push(this.formatDate(cursor));
      }
      const valueFor = (metric: string, date: string) =>
        byMetric.get(metric)?.get(date) ?? 0;
      const daily = dates.map((date) => ({
        date,
        impressions:
          valueFor('BUSINESS_IMPRESSIONS_DESKTOP_MAPS', date) +
          valueFor('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', date) +
          valueFor('BUSINESS_IMPRESSIONS_MOBILE_MAPS', date) +
          valueFor('BUSINESS_IMPRESSIONS_MOBILE_SEARCH', date),
        calls: valueFor('CALL_CLICKS', date),
        websiteClicks: valueFor('WEBSITE_CLICKS', date),
        directionRequests: valueFor('BUSINESS_DIRECTION_REQUESTS', date),
        conversations: valueFor('BUSINESS_CONVERSATIONS', date),
      }));
      const summary = daily.reduce(
        (total, day) => ({
          impressions: total.impressions + day.impressions,
          calls: total.calls + day.calls,
          websiteClicks: total.websiteClicks + day.websiteClicks,
          directionRequests: total.directionRequests + day.directionRequests,
          conversations: total.conversations + day.conversations,
        }),
        {
          impressions: 0,
          calls: 0,
          websiteClicks: 0,
          directionRequests: 0,
          conversations: 0,
        },
      );

      const result = {
        locationId: location.id,
        startDate: this.formatDate(startDate),
        endDate: this.formatDate(endDate),
        summary,
        daily,
        syncedAt: new Date(),
      };
      // Fix — the release must prove this worker still held the claim
      // before the result can be trusted. If another worker already
      // reclaimed this location (bail expired, new claim token), the
      // release matches no row and the result is discarded: a stale
      // worker must never hand back a "successful" read.
      const released = await this.releasePerformanceClaim(
        location.id,
        claimToken,
      );
      if (!released) {
        throw new ConflictException(
          'La lecture des performances a perdu son bail et son résultat a été ignoré.',
        );
      }
      finalized = true;
      return result;
    } finally {
      if (!finalized) {
        await this.releasePerformanceClaim(location.id, claimToken).catch(() =>
          this.logger.warn(
            `GBP : impossible de libérer le bail de lecture des performances (location=${location.id})`,
          ),
        );
      }
    }
  }

  private async releasePerformanceClaim(
    locationId: string,
    claimToken: string,
  ) {
    const released = await this.prisma.googleBusinessProfileLocation.updateMany(
      {
        where: { id: locationId, performanceClaimToken: claimToken },
        data: { performanceClaimedAt: null, performanceClaimToken: null },
      },
    );
    return released.count === 1;
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
    // RC-40.1 fix — expired and stale must never resolve to a silent 'ok':
    // `expired` means the fiche has actually been purged server-side
    // (locationCount already reflects that — never presented as healthy
    // just because a sync happened to succeed before it went stale), and
    // `stale` means the scheduled refresh may itself be failing even though
    // the last attempt that did complete was a success. Either one — like a
    // non-'success' lastSyncStatus — degrades this to 'partial', explicit
    // in `data` for Command Center to distinguish the reason.
    const data = {
      locationCount: status.locationCount,
      expired: status.expired,
      stale: status.stale,
    };
    if (status.expired || status.stale || status.lastSyncStatus !== 'success') {
      return {
        status: 'partial' as const,
        observedAt: status.lastSyncedAt,
        data,
      };
    }
    return { status: 'ok' as const, observedAt: status.lastSyncedAt, data };
  }

  // RC-40.1 fix — the single source of truth for the absolute expiry
  // ceiling on every identifier-based route (link/unlink, reviews,
  // performance): an expired fiche is treated as not found at all, exactly
  // like listLocations()/getStatus() already treat it on the listing paths.
  // This runs before any Google call on every caller (findOwnedLocationWithConnection,
  // syncReviews, getPerformanceMetrics all call this first), so an expired
  // fiche can never trigger a Google request either.
  private async findOwnedLocation(organizationId: string, locationId: string) {
    const location = await this.prisma.googleBusinessProfileLocation.findFirst({
      where: {
        id: locationId,
        organizationId,
        lastSyncedAt: {
          gt: new Date(Date.now() - LOCATIONS_ABSOLUTE_EXPIRY_MS),
        },
      },
    });
    if (!location) throw new NotFoundException('Établissement introuvable.');
    return location;
  }

  private async authorizedLocation(organizationId: string, locationId: string) {
    const { location, connection } = await this.findOwnedLocationWithConnection(
      organizationId,
      locationId,
    );
    const accessToken = await this.refreshAccessToken(
      this.decrypt(connection.encryptedRefreshToken),
    );
    return { location, connection, accessToken };
  }

  // RC-40 fix — split out from authorizedLocation() so a claim/lease check
  // (syncReviews, getPerformanceMetrics) can run BEFORE refreshing the
  // Google access token: the claim must be the very first thing that can
  // reject a concurrent call, with no Google request made ahead of it.
  private async findOwnedLocationWithConnection(
    organizationId: string,
    locationId: string,
  ) {
    const location = await this.findOwnedLocation(organizationId, locationId);
    const connection =
      await this.prisma.googleBusinessProfileConnection.findUnique({
        where: { id: location.connectionId },
      });
    if (!connection) {
      throw new NotFoundException(
        "Google Business Profile n'est pas connecté.",
      );
    }
    return { location, connection };
  }

  private reviewValues(review: GoogleReview, syncedAt: Date, expiresAt: Date) {
    return {
      googleReviewName: review.name,
      reviewerDisplayName: review.reviewer?.displayName ?? null,
      starRating: review.starRating
        ? (STAR_RATING_VALUES[review.starRating] ?? null)
        : null,
      comment: review.comment ?? null,
      createTime: review.createTime ? new Date(review.createTime) : null,
      updateTime: review.updateTime ? new Date(review.updateTime) : null,
      replyComment: review.reviewReply?.comment ?? null,
      replyUpdateTime: review.reviewReply?.updateTime
        ? new Date(review.reviewReply.updateTime)
        : null,
      lastSyncedAt: syncedAt,
      expiresAt,
    };
  }

  private setDatePart(url: URL, prefix: string, date: Date) {
    url.searchParams.set(`${prefix}.year`, String(date.getUTCFullYear()));
    url.searchParams.set(`${prefix}.month`, String(date.getUTCMonth() + 1));
    url.searchParams.set(`${prefix}.day`, String(date.getUTCDate()));
  }

  private datePartsToIso(date?: {
    year?: number;
    month?: number;
    day?: number;
  }) {
    if (!date?.year || !date.month || !date.day) return null;
    return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
  }

  private formatDate(value: Date) {
    return value.toISOString().slice(0, 10);
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
