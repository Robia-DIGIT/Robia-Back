import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AutomationsService } from './automations.service';
import {
  ODC_APPLICATION_DECIDED_EVENT,
  ODC_APPLICATION_INCOMPLETE_EVENT,
  ODC_APPLICATION_READY_FOR_REVIEW_EVENT,
  ODC_APPLICATION_SUBMITTED_EVENT,
  ODC_DOCUMENT_RECEIVED_EVENT,
  type OdcApplicationDecidedEvent,
  type OdcApplicationIncompleteEvent,
  type OdcApplicationReadyForReviewEvent,
  type OdcApplicationSubmittedEvent,
  type OdcDocumentReceivedEvent,
} from '../odc/odc-events';

/**
 * RC-29 — the same bridge AuditCompletedEventListener (RC-23) already
 * provides for `audit.completed`, one listener method per ODC domain event.
 * OdcApplicationsService only ever emits plain in-process events (see
 * odc-events.ts); turning each into a real RC-20 `AutomationEvent` row (so
 * an org's own `scheduled`/`event`-triggered automations can react to it)
 * is entirely this listener's job. Every handler is wrapped in try/catch and
 * never awaited by the emitter — an ingestion failure here can never fail
 * the ODC request that triggered it.
 *
 * eventKey is always the id already documented as stable/idempotent in
 * docs/RC29_ODC_CANDIDATURES.md's events table: applicationId for every
 * application-level event, documentId for odc.document.received — so a
 * duplicate emit (a retried request, at-least-once delivery of whatever
 * emits it) can never create two AutomationEvent rows or two runs, exactly
 * like AuditCompletedEventListener's own eventKey=auditId.
 */
@Injectable()
export class OdcEventListener {
  private readonly logger = new Logger(OdcEventListener.name);

  constructor(private readonly automations: AutomationsService) {}

  @OnEvent(ODC_APPLICATION_SUBMITTED_EVENT)
  async handleApplicationSubmitted(
    event: OdcApplicationSubmittedEvent,
  ): Promise<void> {
    await this.emit(
      event.organizationId,
      ODC_APPLICATION_SUBMITTED_EVENT,
      event.applicationId,
      { applicationId: event.applicationId, programId: event.programId },
    );
  }

  @OnEvent(ODC_APPLICATION_INCOMPLETE_EVENT)
  async handleApplicationIncomplete(
    event: OdcApplicationIncompleteEvent,
  ): Promise<void> {
    await this.emit(
      event.organizationId,
      ODC_APPLICATION_INCOMPLETE_EVENT,
      event.applicationId,
      { applicationId: event.applicationId, missing: event.missing },
    );
  }

  @OnEvent(ODC_APPLICATION_READY_FOR_REVIEW_EVENT)
  async handleApplicationReadyForReview(
    event: OdcApplicationReadyForReviewEvent,
  ): Promise<void> {
    await this.emit(
      event.organizationId,
      ODC_APPLICATION_READY_FOR_REVIEW_EVENT,
      event.applicationId,
      { applicationId: event.applicationId },
    );
  }

  @OnEvent(ODC_DOCUMENT_RECEIVED_EVENT)
  async handleDocumentReceived(event: OdcDocumentReceivedEvent): Promise<void> {
    await this.emit(
      event.organizationId,
      ODC_DOCUMENT_RECEIVED_EVENT,
      event.documentId,
      {
        applicationId: event.applicationId,
        documentId: event.documentId,
        documentTypeId: event.documentTypeId,
      },
    );
  }

  @OnEvent(ODC_APPLICATION_DECIDED_EVENT)
  async handleApplicationDecided(
    event: OdcApplicationDecidedEvent,
  ): Promise<void> {
    await this.emit(
      event.organizationId,
      ODC_APPLICATION_DECIDED_EVENT,
      event.applicationId,
      {
        applicationId: event.applicationId,
        decision: event.decision,
        decidedById: event.decidedById,
      },
    );
  }

  private async emit(
    organizationId: string,
    eventType: string,
    eventKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.automations.emitEvent(
        organizationId,
        eventType,
        eventKey,
        payload,
      );
    } catch (error) {
      this.logger.warn(
        `Ops Automation : échec de l'ingestion de l'événement ${eventType} pour organization=${organizationId} eventKey=${eventKey} : ${
          error instanceof Error ? error.message : 'erreur inconnue'
        }`,
      );
    }
  }
}
