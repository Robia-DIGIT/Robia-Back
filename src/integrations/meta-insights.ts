import { MetaAuditSignals } from './meta.service';

/**
 * Deterministic Meta → opportunity rules (RC-19). Pure functions: no I/O,
 * no network, no Prisma. Takes the already-collected, never-throwing
 * `MetaAuditSignals` (see MetaService.getInsightSignals) and returns zero or
 * more explainable findings. Never invents a metric: a signal field that is
 * `null` stays out of every evidence string — "absent" is never treated as
 * "zero".
 *
 * Closed product boundary (RC-19): every finding below carries
 * `scoreInfluence: false` and is never read by
 * python-service/app/agents/scoring.py's `compute_seo_score_v2`. Meta
 * findings are attached to `Opportunity` rows (see
 * OpportunitiesService.generateMetaOpportunities), a separate table from
 * the SEO `detailed_findings` pipeline — there is no code path from this
 * module into the SEO score.
 */

export interface MetaInsightsThresholds {
  /** Rolling window, in days, used to measure recent Instagram posting activity. */
  lowActivityWindowDays: number;
  /** Minimum number of posts inside that window before META_LOW_RECENT_ACTIVITY fires. */
  lowActivityMinPosts: number;
}

/**
 * getInsightSignals() only ever reads the 10 most recent Instagram media
 * items (see meta.service.ts's graphGet(`${id}/media`, ..., { limit: '10' })).
 * A configured lowActivityMinPosts above this ceiling could never be
 * satisfied and would always fire — MetaService.getInsightsThresholds()
 * clamps against this constant rather than trust raw env input.
 */
export const RECENT_MEDIA_FETCH_LIMIT = 10;

/**
 * Heuristic, not business truth: 30 days / 1 post is a documented default,
 * not a measured engagement benchmark. Configurable via
 * META_LOW_ACTIVITY_WINDOW_DAYS / META_LOW_ACTIVITY_MIN_POSTS — see
 * MetaService.getInsightsThresholds(), which validates and clamps these
 * before they ever reach evaluateMetaFindings().
 */
export const DEFAULT_META_INSIGHTS_THRESHOLDS: MetaInsightsThresholds = {
  lowActivityWindowDays: 30,
  lowActivityMinPosts: 1,
};

export interface MetaFindingEvidence {
  observed: string;
  expected: string;
}

export type MetaFindingConfidence = 'observed' | 'heuristic';

export interface MetaFinding {
  source: 'meta';
  ruleCode:
    | 'META_PAGE_NOT_SELECTED'
    | 'META_INSTAGRAM_NOT_LINKED'
    | 'META_NO_RECENT_MEDIA'
    | 'META_LOW_RECENT_ACTIVITY'
    | 'META_PROFILE_DATA_INCOMPLETE';
  title: string;
  description: string;
  /** Outside CATEGORY_WEIGHTS (python-service/app/agents/scoring.py) — informative only. */
  category: 'social';
  severity: 'info' | 'low' | 'medium';
  /** 'observed' = a directly-read fact (a field is null, a list is empty). 'heuristic' = a documented threshold, not a business truth. */
  confidence: MetaFindingConfidence;
  confidenceScore: number;
  impactScore: number;
  effortScore: number;
  scoreInfluence: false;
  evidence: MetaFindingEvidence[];
  recommendation: string;
}

interface WindowPostCounts {
  /** Items whose timestamp is present, parseable, and inside the window. */
  knownRecentCount: number;
  /** Items whose timestamp is missing or unparseable — genuinely unknown, not "old". */
  unknownTimestampCount: number;
}

function countPostsWithinWindow(
  items: Array<{ timestamp: string | null }>,
  windowDays: number,
  now: Date,
): WindowPostCounts {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  let knownRecentCount = 0;
  let unknownTimestampCount = 0;
  for (const item of items) {
    const parsed = item.timestamp ? Date.parse(item.timestamp) : NaN;
    if (!Number.isFinite(parsed)) {
      // Absence of a usable timestamp is not proof the post is old — it is
      // simply unknown, and RC-19 never treats "unknown" as "0"/"absent".
      unknownTimestampCount += 1;
    } else if (parsed >= cutoff) {
      knownRecentCount += 1;
    }
  }
  return { knownRecentCount, unknownTimestampCount };
}

export function evaluateMetaFindings(
  signals: MetaAuditSignals,
  thresholds: MetaInsightsThresholds = DEFAULT_META_INSIGHTS_THRESHOLDS,
  now: Date = new Date(),
): MetaFinding[] {
  // Nothing is observable — and nothing to recommend — before Meta is even
  // connected. This mirrors GoogleSearchConsoleService's precedent: no
  // opportunity is generated for a plain 'not_connected' state.
  if (!signals.connected) {
    return [];
  }

  const findings: MetaFinding[] = [];

  if (!signals.pageSelected) {
    findings.push({
      source: 'meta',
      ruleCode: 'META_PAGE_NOT_SELECTED',
      title: 'Aucune Page Facebook active sélectionnée',
      description:
        "Un compte Meta est connecté à ROBIA, mais aucune Page Facebook n'a été choisie comme Page active. Tant qu'aucune Page n'est sélectionnée, ROBIA ne peut lire aucun signal social (Facebook ou Instagram).",
      category: 'social',
      severity: 'medium',
      confidence: 'observed',
      confidenceScore: 0.95,
      // Impact/effort share the same 0-10 scale as SEO findings
      // (python-service/app/agents/audit_rules.py) — never a different
      // scale, since oppPriorityScore()'s frontend fallback and
      // findAllForAudit()'s top-5 ranking both assume 0-10 uniformly
      // across every opportunity source.
      impactScore: 4,
      effortScore: 1,
      scoreInfluence: false,
      evidence: [
        {
          observed: 'Connexion Meta active, aucune Page sélectionnée',
          expected: 'Une Page Facebook active sélectionnée',
        },
      ],
      recommendation:
        "Ouvrez l'écran Meta et sélectionnez la Page Facebook active de l'organisation.",
    });
    // Every other signal below depends on a selected Page — nothing else
    // is genuinely observable yet, so evaluating further would either
    // duplicate this same root cause or fabricate an absence.
    return findings;
  }

  if (!signals.instagramLinked) {
    findings.push({
      source: 'meta',
      ruleCode: 'META_INSTAGRAM_NOT_LINKED',
      title: 'Aucun compte Instagram professionnel lié',
      description:
        "La Page Facebook active est sélectionnée, mais aucun compte Instagram professionnel n'y est lié. ROBIA ne peut lire aucun signal Instagram (abonnés, publications récentes) pour cette organisation.",
      category: 'social',
      severity: 'low',
      confidence: 'observed',
      confidenceScore: 0.9,
      impactScore: 3,
      effortScore: 2,
      scoreInfluence: false,
      evidence: [
        {
          observed:
            'Page Facebook sélectionnée sans compte Instagram business lié',
          expected: 'Un compte Instagram professionnel lié à la Page',
        },
      ],
      recommendation:
        'Liez un compte Instagram professionnel à la Page Facebook depuis les paramètres Meta, puis reconnectez ROBIA.',
    });
  }

  if (signals.instagramLinked && signals.recentMedia) {
    if (
      signals.recentMedia.observed &&
      signals.recentMedia.items.length === 0
    ) {
      findings.push({
        source: 'meta',
        ruleCode: 'META_NO_RECENT_MEDIA',
        title: 'Aucun média Instagram récent disponible',
        description:
          "Le compte Instagram est lié et accessible, mais ROBIA n'y trouve aucune publication récente.",
        category: 'social',
        severity: 'medium',
        confidence: 'observed',
        confidenceScore: 0.85,
        impactScore: 5,
        effortScore: 4,
        scoreInfluence: false,
        evidence: [
          {
            observed:
              'Aucune publication renvoyée par Instagram (compte accessible)',
            expected: 'Au moins une publication récente',
          },
        ],
        recommendation:
          'Publiez du contenu sur Instagram pour donner à ROBIA des signaux de présence sociale récents.',
      });
    } else if (
      signals.recentMedia.observed &&
      signals.recentMedia.items.length > 0
    ) {
      const { knownRecentCount, unknownTimestampCount } =
        countPostsWithinWindow(
          signals.recentMedia.items,
          thresholds.lowActivityWindowDays,
          now,
        );
      // Conservative by construction (Codex review): an unknown timestamp is
      // not proof a post is old, so it must count in the *best case* for
      // "recent" — only claim low activity when even that best case (every
      // unknown-timestamp post counted as recent) still falls short of the
      // threshold. Otherwise the unknown posts could themselves satisfy it,
      // and firing would assert an absence that was never actually observed.
      const maxPossibleRecentCount = knownRecentCount + unknownTimestampCount;
      if (maxPossibleRecentCount < thresholds.lowActivityMinPosts) {
        findings.push({
          source: 'meta',
          ruleCode: 'META_LOW_RECENT_ACTIVITY',
          title: 'Activité de publication Instagram faible',
          description:
            "Le compte Instagram a des publications, mais très peu sur la période récente observée. Il s'agit d'un seuil heuristique documenté, pas d'une mesure d'engagement ou de portée.",
          category: 'social',
          severity: 'low',
          confidence: 'heuristic',
          confidenceScore: 0.5,
          impactScore: 4,
          effortScore: 4,
          scoreInfluence: false,
          evidence: [
            {
              observed:
                unknownTimestampCount > 0
                  ? `${knownRecentCount} publication(s) Instagram confirmée(s) sur les ${thresholds.lowActivityWindowDays} derniers jours (+ ${unknownTimestampCount} publication(s) à horodatage inexploitable, exclue(s) du calcul)`
                  : `${knownRecentCount} publication(s) Instagram sur les ${thresholds.lowActivityWindowDays} derniers jours`,
              expected: `Au moins ${thresholds.lowActivityMinPosts} publication(s) sur ${thresholds.lowActivityWindowDays} jours (seuil heuristique configurable, pas une vérité métier)`,
            },
          ],
          recommendation:
            'Publiez plus régulièrement sur Instagram si ce rythme ne correspond pas à la stratégie de contenu prévue.',
        });
      }
    }
    // recentMedia.observed === false: the media read itself failed
    // (permissions/API) — that is not the same fact as "no recent media",
    // so nothing is reported here rather than inventing an absence.
  }

  if (
    signals.facebook &&
    signals.facebook.fanCount === null &&
    signals.facebook.followersCount === null
  ) {
    findings.push({
      source: 'meta',
      ruleCode: 'META_PROFILE_DATA_INCOMPLETE',
      title: 'Métriques de profil Facebook non retournées',
      description:
        "La Page Facebook a été lue avec succès, mais l'API Meta n'a renvoyé ni nombre de fans ni nombre d'abonnés pour cette Page à cette lecture. Cette absence peut venir des permissions accordées, d'une limitation temporaire de l'API Meta, ou du type de Page — elle ne prouve pas à elle seule un problème de configuration du profil.",
      category: 'social',
      severity: 'info',
      confidence: 'observed',
      confidenceScore: 0.7,
      impactScore: 2,
      effortScore: 2,
      scoreInfluence: false,
      evidence: [
        {
          observed:
            "fanCount et followersCount non retournés par l'API Meta pour cette lecture",
          expected: 'Au moins un des deux compteurs retourné par Meta',
        },
      ],
      recommendation:
        "Vérifiez les permissions Meta accordées à ROBIA et réessayez plus tard ; si l'absence persiste, contactez le support Meta pour confirmer la disponibilité de ces métriques pour ce type de Page.",
    });
  }

  return findings;
}
