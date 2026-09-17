import { OdcEventListener } from './odc-event.listener';
import { AutomationsService } from './automations.service';
import {
  ODC_APPLICATION_DECIDED_EVENT,
  ODC_APPLICATION_INCOMPLETE_EVENT,
  ODC_APPLICATION_READY_FOR_REVIEW_EVENT,
  ODC_APPLICATION_SUBMITTED_EVENT,
  ODC_DOCUMENT_RECEIVED_EVENT,
} from '../odc/odc-events';

describe('OdcEventListener', () => {
  let automations: { emitEvent: jest.Mock };
  let listener: OdcEventListener;

  beforeEach(() => {
    automations = {
      emitEvent: jest.fn().mockResolvedValue({ event: {}, runs: [] }),
    };
    listener = new OdcEventListener(
      automations as unknown as AutomationsService,
    );
  });

  it('turns odc.application.submitted into emitEvent(), keyed by applicationId', async () => {
    await listener.handleApplicationSubmitted({
      organizationId: 'org-1',
      applicationId: 'app-1',
      programId: 'program-1',
    });
    expect(automations.emitEvent).toHaveBeenCalledWith(
      'org-1',
      ODC_APPLICATION_SUBMITTED_EVENT,
      'app-1',
      { applicationId: 'app-1', programId: 'program-1' },
    );
  });

  it('turns odc.application.incomplete into emitEvent(), carrying the missing list', async () => {
    await listener.handleApplicationIncomplete({
      organizationId: 'org-1',
      applicationId: 'app-1',
      missing: ['field:motivation'],
    });
    expect(automations.emitEvent).toHaveBeenCalledWith(
      'org-1',
      ODC_APPLICATION_INCOMPLETE_EVENT,
      'app-1',
      { applicationId: 'app-1', missing: ['field:motivation'] },
    );
  });

  it('turns odc.application.ready_for_review into emitEvent()', async () => {
    await listener.handleApplicationReadyForReview({
      organizationId: 'org-1',
      applicationId: 'app-1',
    });
    expect(automations.emitEvent).toHaveBeenCalledWith(
      'org-1',
      ODC_APPLICATION_READY_FOR_REVIEW_EVENT,
      'app-1',
      { applicationId: 'app-1' },
    );
  });

  it('turns odc.document.received into emitEvent(), keyed by documentId (not applicationId)', async () => {
    await listener.handleDocumentReceived({
      organizationId: 'org-1',
      applicationId: 'app-1',
      documentId: 'doc-1',
      documentTypeId: 'dt-1',
    });
    expect(automations.emitEvent).toHaveBeenCalledWith(
      'org-1',
      ODC_DOCUMENT_RECEIVED_EVENT,
      'doc-1',
      { applicationId: 'app-1', documentId: 'doc-1', documentTypeId: 'dt-1' },
    );
  });

  it('turns odc.application.decided into emitEvent(), carrying the decision and decider', async () => {
    await listener.handleApplicationDecided({
      organizationId: 'org-1',
      applicationId: 'app-1',
      decision: 'accepted',
      decidedById: 'user-1',
    });
    expect(automations.emitEvent).toHaveBeenCalledWith(
      'org-1',
      ODC_APPLICATION_DECIDED_EVENT,
      'app-1',
      { applicationId: 'app-1', decision: 'accepted', decidedById: 'user-1' },
    );
  });

  it("never throws when Ops Automation ingestion fails — an ODC request's own success never depends on this listener", async () => {
    automations.emitEvent.mockRejectedValue(new Error('ops automation down'));
    await expect(
      listener.handleApplicationSubmitted({
        organizationId: 'org-1',
        applicationId: 'app-1',
        programId: 'program-1',
      }),
    ).resolves.toBeUndefined();
  });
});
