/**
 * RC-23 — first real business event wired into RC-20's automation engine
 * (`AutomationsService.emitEvent()`, built in RC-20 but never called from
 * anywhere). This is an in-process Node event (via `@nestjs/event-emitter`),
 * not the RC-20 `AutomationEvent` row itself — `AuditCompletedEventListener`
 * (ops-automation) is what turns this into that row.
 *
 * Decoupling AuditsService from AutomationsService this way (rather than a
 * direct call) avoids a circular module dependency: OpsAutomationModule
 * already imports AuditsModule for its own actions
 * (robia.audit.run_diagnostic / regenerate), so AuditsModule calling back
 * into OpsAutomationModule directly would create AuditsModule ↔
 * OpsAutomationModule. Every future business event emitter (Meta,
 * candidatures, opportunities…) can reuse the same in-process event pattern
 * without ever creating that circular import.
 */
export const AUDIT_COMPLETED_EVENT = 'audit.completed';

export interface AuditCompletedEvent {
  organizationId: string;
  auditId: string;
  websiteId: string;
  /** Never fabricated — `null` when this audit path doesn't compute one (see runSite()). */
  globalScore: number | null;
}
