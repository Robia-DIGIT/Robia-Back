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
 * Heuristic, not business truth: 30 days / 1 post is a documented default,
 * not a measured engagement benchmark. Configurable via
 * META_LOW_ACTIVITY_WINDOW_DAYS / META_LOW_ACTIVITY_MIN_POSTS (see
 * MetaService.insightsThresholds()).
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

function countPostsWithinWindow(
  items: Array<{ timestamp: string | null }>,
  windowDays: number,
  now: Date,
): number {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  return items.filter((item) => {
    if (!item.timestamp) return false;
    const parsed = Date.parse(item.timestamp);
    return Number.isFinite(parsed) && parsed >= cutoff;
  }).length;
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
      impactScore: 40,
      effortScore: 10,
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
      impactScore: 30,
      effortScore: 20,
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
        impactScore: 50,
        effortScore: 40,
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
      const recentCount = countPostsWithinWindow(
        signals.recentMedia.items,
        thresholds.lowActivityWindowDays,
        now,
      );
      if (recentCount < thresholds.lowActivityMinPosts) {
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
          impactScore: 35,
          effortScore: 40,
          scoreInfluence: false,
          evidence: [
            {
              observed: `${recentCount} publication(s) Instagram sur les ${thresholds.lowActivityWindowDays} derniers jours`,
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
      title: 'Données de profil Facebook incomplètes',
      description:
        "La Page Facebook a été lue avec succès, mais Meta n'a renvoyé aucun nombre de fans ni d'abonnés pour cette Page.",
      category: 'social',
      severity: 'info',
      confidence: 'observed',
      confidenceScore: 0.7,
      impactScore: 20,
      effortScore: 15,
      scoreInfluence: false,
      evidence: [
        {
          observed: 'fanCount et followersCount absents de la réponse Meta',
          expected: 'Au moins un des deux compteurs de profil renseigné',
        },
      ],
      recommendation:
        'Vérifiez la visibilité publique du profil de la Page dans les paramètres Facebook.',
    });
  }

  return findings;
}
