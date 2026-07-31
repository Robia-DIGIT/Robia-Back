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
}

@Injectable()
export class AuditRunnerService {
  private readonly aiEngineUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.aiEngineUrl = this.configService.get<string>('AI_ENGINE_URL') ??
    'http://localhost:8000';
  }

  async runAudit({ websiteUrl, sector, city }: RunAuditParams): Promise<AuditResult> {
    const response = await fetch(`${this.aiEngineUrl}/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: websiteUrl, sector, city }),
    });

    if (!response.ok) {
      throw new Error(
        `AI engine /audit failed with status ${response.status}`,
      );
    }

    return response.json();
  }
}