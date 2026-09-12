/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface AuditResult {
  global_score: number;
  subscores: {
    local: number;
    technical: number;
    content: number;
    performance: number;
    ai_readiness: number;
  };
  missing_data: string[];
  summary: string;
}

interface RunAuditParams {
  websiteUrl: string;
  sector?: string | null;
  city?: string | null;
  country?: string | null;
}

export interface SitePageDetail {
  url: string;
  accessible: boolean;
  status_code: number | null;
  title: string | null;
  meta_description: string | null;
  h1: string[];
  h2: string[];
  h3: string[];
  canonical: string | null;
  meta_robots: string | null;
  word_count: number;
  images_count: number;
  images_without_alt: number;
  internal_links_count: number;
  external_links_count: number;
  structured_data_types: string[];
  og_tags_present: string[];
  top_keywords: string[];
  business_address: string | null;
  business_latitude: number | null;
  business_longitude: number | null;
  social_links: Record<string, string>;
  js_rendering_used: boolean;
  js_rendering_suspected: boolean;
  main_content: string | null;
  error: string | null;
}


export interface DetailedAuditFinding {
  rule_code: string;
  title: string;
  category: string;
  status: 'passed' | 'warning' | 'failed' | 'not_tested';
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  impact_score: number;
  effort_score: number;
  confidence_score: number;
  priority_score: number;
  affected_urls: string[];
  evidence: Array<{
    url: string;
    observed: string;
    expected: string;
  }>;
  source_data: string;
  why_it_matters: string;
  recommended_steps: string[];
}

export interface PageSpeedMetrics {
  lcpMs: number | null;
  cls: number | null;
  /** Lab proxy for interactivity (Total Blocking Time) — not a Core Web Vital. */
  tbtMs: number | null;
  fcpMs: number | null;
}

/**
 * Structured PageSpeed Insights contract (RC-10/RC-11). Never
 * influences the audit's overall SEO score — it is an additional,
 * independent finding source.
 */
export interface PageSpeedInsightsResult {
  status: 'ok' | 'unavailable';
  strategy: 'mobile';
  performanceScore: number | null;
  metrics: PageSpeedMetrics;
  fetchedAt: string;
  analyzedUrl: string;
  finalUrl: string | null;
  source: string;
  unavailableReason: string | null;
}

export interface SiteAuditResult {
  base_url: string;
  discovery_method: string;
  pages_discovered: number;
  pages_analyzed: number;
  pages_failed: number;
  pages_excluded: number;
  pages_count: number;
  pages_with_h1: number;
  pages_without_h1: number;
  pages_with_meta_description: number;
  pages_without_meta_description: number;
  pages_with_schema: number;
  pages_without_schema: number;
  pages_with_og: number;
  pages_without_og: number;
  avg_word_count: number;
  business_address: string | null;
  business_latitude: number | null;
  business_longitude: number | null;
  location_precision: string;
  social_links: Record<string, string>;
  top_keywords: string[];
  findings: string[];
  detailed_findings: DetailedAuditFinding[];
  pagespeed_insights: PageSpeedInsightsResult | null;
  pages: SitePageDetail[];
  failed_urls: string[];
}

interface RunSiteAuditParams {
  websiteUrl: string;
  maxPages?: number;
  maxDepth?: number;
  city?: string | null;
  country?: string | null;
}

@Injectable()
export class AuditRunnerService {
  private readonly aiEngineUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.aiEngineUrl = this.configService.get<string>('AI_ENGINE_URL') ??
    'http://localhost:8000';
  }

  async runAudit({ websiteUrl, sector, city, country }: RunAuditParams): Promise<AuditResult> {
    const response = await fetch(`${this.aiEngineUrl}/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: websiteUrl, sector, city, country }),
    });

    if (!response.ok) {
      throw new Error(
        `AI engine /audit failed with status ${response.status}`,
      );
    }

    return (await response.json()) as AuditResult;
  }

  async runSiteAudit({ websiteUrl, maxPages = 20, maxDepth = 2, city, country }: RunSiteAuditParams): Promise<SiteAuditResult> {
    const response = await fetch(`${this.aiEngineUrl}/audit/site`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: websiteUrl, max_pages: maxPages, max_depth: maxDepth, city, country }),
    });

    if (!response.ok) {
      throw new Error(
        `AI engine /audit/site failed with status ${response.status}`,
      );
    }

    return (await response.json()) as SiteAuditResult;
  }
}
