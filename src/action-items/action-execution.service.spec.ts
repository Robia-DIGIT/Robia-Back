import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ActionExecutionService } from './action-execution.service';

describe('ActionExecutionService', () => {
  const organizationId = 'org-1';
  const userId = 'user-1';
  const actionId = 'action-1';
  let prisma: any;
  let service: ActionExecutionService;

  beforeEach(() => {
    prisma = {
      actionItem: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      actionExecutionEvent: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      audit: { findFirst: jest.fn() },
      $transaction: jest.fn((operations) => Promise.all(operations)),
    };
    service = new ActionExecutionService(prisma);
  });

  it('submits a draft action for human approval and writes history', async () => {
    prisma.actionItem.findFirst.mockResolvedValue({
      id: actionId,
      organizationId,
      approvalStatus: 'draft',
      executionStatus: 'not_started',
    });
    prisma.actionItem.update.mockResolvedValue({
      id: actionId,
      approvalStatus: 'pending',
    });
    prisma.actionExecutionEvent.create.mockResolvedValue({
      id: 'event-submit',
      eventType: 'submitted',
    });

    const result = await service.submit(organizationId, userId, actionId);

    expect(prisma.actionItem.update).toHaveBeenCalledWith({
      where: { id: actionId },
      data: {
        approvalStatus: 'pending',
        approvalReason: null,
        executionStatus: 'not_started',
      },
    });
    expect(result).toEqual(
      expect.objectContaining({ changed: true, event: { id: 'event-submit', eventType: 'submitted' } }),
    );
  });

  it('approves only an action that is pending', async () => {
    prisma.actionItem.findFirst.mockResolvedValue({
      id: actionId,
      organizationId,
      approvalStatus: 'draft',
    });

    await expect(service.approve(organizationId, userId, actionId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a pending action with a reason and an audit event', async () => {
    prisma.actionItem.findFirst.mockResolvedValue({
      id: actionId,
      organizationId,
      approvalStatus: 'pending',
    });
    prisma.actionItem.update.mockResolvedValue({
      id: actionId,
      approvalStatus: 'rejected',
      approvalReason: 'Needs review',
    });
    prisma.actionExecutionEvent.create.mockResolvedValue({
      id: 'event-reject',
      eventType: 'rejected',
    });

    await service.reject(organizationId, userId, actionId, { reason: ' Needs review ' });

    expect(prisma.actionExecutionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId,
        actionItemId: actionId,
        userId,
        eventType: 'rejected',
        payload: { reason: 'Needs review' },
      }),
    });
  });

  it('refuses to record execution before approval', async () => {
    prisma.actionItem.findFirst.mockResolvedValue({
      id: actionId,
      organizationId,
      approvalStatus: 'pending',
      executionStatus: 'not_started',
    });

    await expect(
      service.recordExecution(organizationId, userId, actionId, {
        idempotencyKey: 'attempt-001',
        outcome: 'succeeded',
        evidence: { url: 'https://example.com/proof' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records a successful approved execution with proof and verification audit', async () => {
    prisma.actionItem.findFirst.mockResolvedValue({
      id: actionId,
      organizationId,
      approvalStatus: 'approved',
      executionStatus: 'ready',
    });
    prisma.actionExecutionEvent.findFirst.mockResolvedValue(null);
    prisma.audit.findFirst.mockResolvedValue({ id: 'audit-2' });
    prisma.actionItem.update.mockResolvedValue({
      id: actionId,
      status: 'done',
      executionStatus: 'succeeded',
      attemptCount: 1,
    });
    prisma.actionExecutionEvent.create.mockResolvedValue({
      id: 'event-exec',
      eventType: 'execution_succeeded',
    });

    const result = await service.recordExecution(organizationId, userId, actionId, {
      idempotencyKey: 'attempt-001',
      outcome: 'succeeded',
      evidence: { url: 'https://example.com/proof' },
      verificationAuditId: 'audit-2',
    });

    expect(prisma.audit.findFirst).toHaveBeenCalledWith({
      where: { id: 'audit-2', organizationId },
      select: { id: true },
    });
    expect(prisma.actionItem.update).toHaveBeenCalledWith({
      where: { id: actionId },
      data: expect.objectContaining({
        status: 'done',
        executionStatus: 'succeeded',
        verificationAuditId: 'audit-2',
        attemptCount: { increment: 1 },
      }),
    });
    expect(result.idempotent).toBe(false);
  });

  it('returns the existing execution event for the same idempotency key', async () => {
    const action = {
      id: actionId,
      organizationId,
      approvalStatus: 'approved',
      executionStatus: 'ready',
    };
    const event = { id: 'event-existing', eventType: 'execution_succeeded' };
    prisma.actionItem.findFirst.mockResolvedValue(action);
    prisma.actionExecutionEvent.findFirst.mockResolvedValue(event);

    const result = await service.recordExecution(organizationId, userId, actionId, {
      idempotencyKey: 'attempt-001',
      outcome: 'succeeded',
      evidence: { url: 'https://example.com/proof' },
    });

    expect(result).toEqual({ action, event, idempotent: true });
    expect(prisma.actionItem.update).not.toHaveBeenCalled();
    expect(prisma.actionExecutionEvent.create).not.toHaveBeenCalled();
  });

  it('does not expose history for an action from another organization', async () => {
    prisma.actionItem.findFirst.mockResolvedValue(null);

    await expect(service.history(organizationId, 'foreign-action')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.actionExecutionEvent.findMany).not.toHaveBeenCalled();
  });
});
