/**
 * RC-29 — the same in-process event pattern RC-23 introduced for
 * `audit.completed` (see `src/audits/audit-completed.event.ts`), reused here
 * exactly as that file's own doc comment anticipated ("Every future business
 * event emitter (Meta, candidatures, opportunities…) can reuse the same
 * in-process event pattern without ever creating [a] circular import").
 *
 * `OdcModule` never imports `OpsAutomationModule`: it only emits these plain
 * `@nestjs/event-emitter` events. `OdcEventListener` (ops-automation) is the
 * one thing that imports this file (a type-only/constant import, not a
 * module dependency) and turns each event into a real RC-20
 * `AutomationEvent` row via `AutomationsService.emitEvent()`. The opposite
 * direction — `OpsActionsRegistryService` needing to call into ODC logic for
 * its 3 new actions — goes through a direct import of `OdcModule` instead
 * (see `OpsAutomationModule`), since that direction alone would not be
 * circular. This is what lets `OpsAutomationModule` depend on `OdcModule`
 * without `OdcModule` ever depending back on it.
 */

export const ODC_APPLICATION_SUBMITTED_EVENT = 'odc.application.submitted';
export const ODC_APPLICATION_INCOMPLETE_EVENT = 'odc.application.incomplete';
export const ODC_APPLICATION_READY_FOR_REVIEW_EVENT =
  'odc.application.ready_for_review';
export const ODC_DOCUMENT_RECEIVED_EVENT = 'odc.document.received';
export const ODC_APPLICATION_DECIDED_EVENT = 'odc.application.decided';

export interface OdcApplicationSubmittedEvent {
  organizationId: string;
  applicationId: string;
  programId: string;
}

export interface OdcApplicationIncompleteEvent {
  organizationId: string;
  applicationId: string;
  missing: string[];
}

export interface OdcApplicationReadyForReviewEvent {
  organizationId: string;
  applicationId: string;
}

export interface OdcDocumentReceivedEvent {
  organizationId: string;
  applicationId: string;
  documentId: string;
  documentTypeId: string;
}

export interface OdcApplicationDecidedEvent {
  organizationId: string;
  applicationId: string;
  decision: 'accepted' | 'rejected' | 'waitlisted';
  decidedById: string;
}
