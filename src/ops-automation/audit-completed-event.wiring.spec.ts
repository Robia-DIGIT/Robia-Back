import { Test } from '@nestjs/testing';
import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
import { AuditCompletedEventListener } from './audit-completed-event.listener';
import { AutomationsService } from './automations.service';
import { AUDIT_COMPLETED_EVENT } from '../audits/audit-completed.event';

/**
 * RC-23 — proves the actual NestJS wiring, not just the listener's own
 * logic in isolation: a real `EventEmitter2.emit()` (not a mocked one)
 * reaches `AuditCompletedEventListener.handleAuditCompleted()` through the
 * `@OnEvent` decorator, exactly as AuditsService will trigger it in
 * production. `audit-completed-event.listener.spec.ts` covers the
 * listener's own behavior with a manually-constructed instance; this file
 * is the one that would catch a wiring mistake (e.g. forgetting
 * `EventEmitterModule.forRoot()` in AppModule) that a manual construction
 * can't.
 */
describe('audit.completed event wiring (RC-23)', () => {
  it('a real EventEmitter2.emit() reaches AuditCompletedEventListener via @OnEvent', async () => {
    const emitEvent = jest.fn().mockResolvedValue({ event: {}, runs: [] });

    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        AuditCompletedEventListener,
        { provide: AutomationsService, useValue: { emitEvent } },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      const eventEmitter = app.get(EventEmitter2);
      eventEmitter.emit(AUDIT_COMPLETED_EVENT, {
        organizationId: 'org-1',
        auditId: 'audit-1',
        websiteId: 'website-1',
        globalScore: 62,
      });

      // @OnEvent listeners registered as async methods are invoked
      // synchronously by EventEmitter2, but their body only runs to
      // completion across microtasks — flush a couple before asserting.
      await Promise.resolve();
      await Promise.resolve();

      expect(emitEvent).toHaveBeenCalledWith(
        'org-1',
        AUDIT_COMPLETED_EVENT,
        'audit-1',
        { auditId: 'audit-1', websiteId: 'website-1', globalScore: 62 },
      );
    } finally {
      await app.close();
    }
  });
});
