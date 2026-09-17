import { Test } from '@nestjs/testing';
import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
import { OdcEventListener } from './odc-event.listener';
import { AutomationsService } from './automations.service';
import { ODC_APPLICATION_SUBMITTED_EVENT } from '../odc/odc-events';

/**
 * RC-29 — proves the actual NestJS wiring for one representative ODC
 * event, the same way audit-completed-event.wiring.spec.ts proves it for
 * `audit.completed`: a real `EventEmitter2.emit()` reaching
 * `OdcEventListener` via `@OnEvent`, exactly as
 * `OdcApplicationsService.submit()` will trigger it in production.
 */
describe('odc.application.submitted event wiring (RC-29)', () => {
  it('a real EventEmitter2.emit() reaches OdcEventListener via @OnEvent', async () => {
    const emitEvent = jest.fn().mockResolvedValue({ event: {}, runs: [] });

    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        OdcEventListener,
        { provide: AutomationsService, useValue: { emitEvent } },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      const eventEmitter = app.get(EventEmitter2);
      eventEmitter.emit(ODC_APPLICATION_SUBMITTED_EVENT, {
        organizationId: 'org-1',
        applicationId: 'app-1',
        programId: 'program-1',
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(emitEvent).toHaveBeenCalledWith(
        'org-1',
        ODC_APPLICATION_SUBMITTED_EVENT,
        'app-1',
        { applicationId: 'app-1', programId: 'program-1' },
      );
    } finally {
      await app.close();
    }
  });
});
