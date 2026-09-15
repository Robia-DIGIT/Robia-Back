import { AuditCompletedEventListener } from './audit-completed-event.listener';
import { AutomationsService } from './automations.service';
import {
  AUDIT_COMPLETED_EVENT,
  type AuditCompletedEvent,
} from '../audits/audit-completed.event';

describe('AuditCompletedEventListener', () => {
  const event: AuditCompletedEvent = {
    organizationId: 'org-1',
    auditId: 'audit-1',
    websiteId: 'website-1',
    globalScore: 62,
  };

  let automations: { emitEvent: jest.Mock };
  let listener: AuditCompletedEventListener;

  beforeEach(() => {
    automations = {
      emitEvent: jest.fn().mockResolvedValue({ event: {}, runs: [] }),
    };
    listener = new AuditCompletedEventListener(
      automations as unknown as AutomationsService,
    );
  });

  it("turns the in-process event into a real AutomationEvent via AutomationsService.emitEvent(), keyed by the audit's own id", async () => {
    await listener.handleAuditCompleted(event);

    expect(automations.emitEvent).toHaveBeenCalledWith(
      'org-1',
      AUDIT_COMPLETED_EVENT,
      'audit-1',
      { auditId: 'audit-1', websiteId: 'website-1', globalScore: 62 },
    );
  });

  it('never fabricates a score: a null globalScore (runSite()) is forwarded as null, not 0', async () => {
    await listener.handleAuditCompleted({ ...event, globalScore: null });

    expect(automations.emitEvent).toHaveBeenCalledWith(
      'org-1',
      AUDIT_COMPLETED_EVENT,
      'audit-1',
      { auditId: 'audit-1', websiteId: 'website-1', globalScore: null },
    );
  });

  it("never throws when Ops Automation ingestion fails — an audit's own success never depends on this listener", async () => {
    automations.emitEvent.mockRejectedValue(new Error('ops automation down'));

    await expect(listener.handleAuditCompleted(event)).resolves.toBeUndefined();
  });
});
