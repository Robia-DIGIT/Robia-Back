import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AutomationsService } from './automations.service';
import {
  AUDIT_COMPLETED_EVENT,
  type AuditCompletedEvent,
} from '../audits/audit-completed.event';

/**
 * RC-23 — turns the in-process `audit.completed` event (emitted by
 * AuditsService, see audit-completed.event.ts) into a real RC-20
 * `AutomationEvent` row via `AutomationsService.emitEvent()` — the exact
 * method RC-20 built and documented as "nothing calls this yet".
 *
 * Deliberately never lets a failure here surface anywhere else: the whole
 * body is wrapped in try/catch, and `EventEmitter2.emit()` in AuditsService
 * doesn't await this listener either way — an audit's own success is never
 * conditioned on Ops Automation being reachable.
 */
@Injectable()
export class AuditCompletedEventListener {
  private readonly logger = new Logger(AuditCompletedEventListener.name);

  constructor(private readonly automations: AutomationsService) {}

  @OnEvent(AUDIT_COMPLETED_EVENT)
  async handleAuditCompleted(event: AuditCompletedEvent): Promise<void> {
    try {
      // eventKey = auditId: stable and idempotent — two completions of the
      // same audit (e.g. a retry) can never create two AutomationEvent rows
      // or two runs (see AutomationsService.getOrCreateEvent()'s dedup on
      // (organizationId, eventType, eventKey)).
      await this.automations.emitEvent(
        event.organizationId,
        AUDIT_COMPLETED_EVENT,
        event.auditId,
        {
          auditId: event.auditId,
          websiteId: event.websiteId,
          globalScore: event.globalScore,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Ops Automation : échec de l'ingestion de l'événement audit.completed pour organization=${event.organizationId} audit=${event.auditId}: ${
          error instanceof Error ? error.message : 'erreur inconnue'
        }`,
      );
    }
  }
}
