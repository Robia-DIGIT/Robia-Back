/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { publicationOperationKey } from '../content-studio/publication-policy';
import {
  WordPressNetworkError,
  type WordPressHttpRequest,
} from './wordpress-safe-http.service';
import { WordPressService } from './wordpress.service';

const KEY = 'ab'.repeat(32);
const organizationId = 'org-1';
const websiteId = 'website-1';
const userId = 'user-1';

function fixture() {
  const document = {
    id: 'document-1',
    organizationId,
    websiteId,
    revision: 3,
    title: 'Guide local',
    content: 'Contenu utile.',
  };
  const action = {
    id: 'action-1',
    organizationId,
    documentId: document.id,
    approvalStatus: 'approved',
    executionStatus: 'ready',
  };
  const connection = {
    id: 'connection-1',
    organizationId,
    websiteId,
    siteUrl: 'https://example.com',
    apiBaseUrl: 'https://example.com/wp-json/wp/v2',
    username: 'editor',
    encryptedApplicationPassword: '',
    status: 'ready',
    connectionVersion: 2,
    canCreatePosts: true,
    canCreatePages: true,
  };
  return { document, action, connection };
}

function harness() {
  const prisma = {
    website: { findFirst: jest.fn() },
    wordPressConnection: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    document: { findFirst: jest.fn() },
    actionItem: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    actionExecutionEvent: { create: jest.fn() },
    wordPressDraftApproval: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    wordPressDraftAttempt: {
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (callback: (value: typeof prisma) => unknown) => callback(prisma),
  );
  const http = { request: jest.fn() };
  const config = {
    get: jest.fn((name: string) => (name.includes('KEY') ? KEY : undefined)),
  };
  const service = new WordPressService(
    prisma as never,
    config as never,
    http as never,
  );
  return { prisma, http, service };
}

function approvalFor(service: WordPressService, stale = false) {
  const { document, action, connection } = fixture();
  const payload = (
    service as never as {
      canonicalPayload: (
        document: typeof document,
        connection: typeof connection,
        postType: 'post',
      ) => Record<string, unknown>;
    }
  ).canonicalPayload(document, connection, 'post');
  const contentDigest = (
    service as never as {
      sha256: (value: string) => string;
    }
  ).sha256(JSON.stringify(payload));
  const binding = {
    organizationId,
    documentId: document.id,
    revision: stale ? document.revision - 1 : document.revision,
    contentDigest,
    destination: 'wordpress_post' as const,
    targetId: `${connection.id}:post`,
    connectionVersion: connection.connectionVersion,
  };
  const approval = {
    id: 'approval-1',
    ...binding,
    documentRevision: binding.revision,
    postType: 'post',
    operationKey: publicationOperationKey(binding),
    canonicalPayload: payload,
    approvedById: userId,
    revokedAt: null,
    organizationId,
    connectionId: connection.id,
    actionItemId: action.id,
  };
  return { approval, document, action, connection };
}

describe('WordPressService', () => {
  it('verifies credentials before storing only an encrypted application password', async () => {
    const { prisma, http, service } = harness();
    prisma.website.findFirst.mockResolvedValue({
      id: websiteId,
      url: 'https://example.com',
    });
    http.request.mockResolvedValue({
      status: 200,
      body: {
        id: 7,
        name: 'Editor',
        capabilities: { edit_posts: true, edit_pages: true },
      },
    });
    prisma.wordPressConnection.findFirst.mockResolvedValue(null);
    prisma.wordPressConnection.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 'connection-1',
        websiteId,
        status: 'ready',
        encrypted: data.encryptedApplicationPassword,
      }),
    );

    const result = await service.connect(organizationId, {
      websiteId,
      username: 'editor',
      applicationPassword: 'abcd efgh ijkl mnop',
    });

    expect(http.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'https://example.com/wp-json/wp/v2/users/me?context=edit',
      }),
    );
    const stored = prisma.wordPressConnection.create.mock.calls[0][0].data;
    expect(stored.encryptedApplicationPassword).toMatch(/^v1\./);
    expect(stored.encryptedApplicationPassword).not.toContain(
      'abcdefghijklmnop',
    );
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnop');
  });

  it('keeps the previous connection intact when remote verification fails', async () => {
    const { prisma, http, service } = harness();
    prisma.website.findFirst.mockResolvedValue({
      id: websiteId,
      url: 'https://example.com',
    });
    http.request.mockResolvedValue({ status: 401, body: {} });

    await expect(
      service.connect(organizationId, {
        websiteId,
        username: 'editor',
        applicationPassword: 'bad-password',
      }),
    ).rejects.toThrow('WordPress a refusé');
    expect(prisma.wordPressConnection.create).not.toHaveBeenCalled();
    expect(prisma.wordPressConnection.update).not.toHaveBeenCalled();
  });

  it('refuses credential rotation while a remote draft attempt is active', async () => {
    const { prisma, http, service } = harness();
    prisma.website.findFirst.mockResolvedValue({
      id: websiteId,
      url: 'https://example.com',
    });
    http.request.mockResolvedValue({
      status: 200,
      body: {
        id: 7,
        capabilities: { edit_posts: true, edit_pages: true },
      },
    });
    prisma.wordPressConnection.findFirst.mockResolvedValue({
      id: 'connection-1',
    });
    prisma.wordPressDraftAttempt.count.mockResolvedValue(1);

    await expect(
      service.connect(organizationId, {
        websiteId,
        username: 'editor',
        applicationPassword: 'new-application-password',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.wordPressConnection.update).not.toHaveBeenCalled();
  });

  it('refuses credential rotation while a draft attempt still awaits reconciliation (status unknown)', async () => {
    const { prisma, http, service } = harness();
    prisma.website.findFirst.mockResolvedValue({
      id: websiteId,
      url: 'https://example.com',
    });
    http.request.mockResolvedValue({
      status: 200,
      body: { id: 7, capabilities: { edit_posts: true, edit_pages: true } },
    });
    prisma.wordPressConnection.findFirst.mockResolvedValue({
      id: 'connection-1',
    });
    // A prior attempt's remote result was never confirmed (network drop,
    // ambiguous 5xx, ...) — rotating the credentials it depends on for
    // reconciliation would strand it, same as an in-flight attempt.
    prisma.wordPressDraftAttempt.count.mockResolvedValue(1);

    await expect(
      service.connect(organizationId, {
        websiteId,
        username: 'editor',
        applicationPassword: 'new-application-password',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.wordPressDraftAttempt.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['in_flight', 'unknown'] },
        }),
      }),
    );
    expect(prisma.wordPressConnection.update).not.toHaveBeenCalled();
  });

  it('refuses disconnect while a draft attempt is in flight or awaits reconciliation', async () => {
    const { prisma, service } = harness();
    prisma.website.findFirst.mockResolvedValue({ id: websiteId });
    prisma.wordPressConnection.findFirst.mockResolvedValue({
      id: 'connection-1',
      status: 'ready',
    });
    prisma.wordPressDraftAttempt.count.mockResolvedValue(1);

    await expect(
      service.disconnect(organizationId, websiteId),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.wordPressDraftAttempt.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['in_flight', 'unknown'] },
        }),
      }),
    );
    expect(prisma.wordPressConnection.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an approval from another tenant even if a repository returned it', async () => {
    const { prisma, service } = harness();
    const context = approvalFor(service);
    prisma.wordPressDraftApproval.findFirst.mockResolvedValue({
      ...context.approval,
      organizationId: 'org-other',
      connection: { ...context.connection, organizationId: 'org-other' },
      document: { ...context.document, organizationId: 'org-other' },
      actionItem: { ...context.action, organizationId: 'org-other' },
    });

    await expect(
      service.createDraft(organizationId, userId, {
        approvalId: context.approval.id,
        idempotencyKey: 'request-123',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a stale approval after the document revision changes', async () => {
    const { prisma, http, service } = harness();
    const context = approvalFor(service, true);
    prisma.wordPressDraftApproval.findFirst.mockResolvedValue({
      ...context.approval,
      connection: context.connection,
      document: context.document,
      actionItem: context.action,
    });
    prisma.wordPressDraftAttempt.findFirst.mockResolvedValue(null);

    await expect(
      service.createDraft(organizationId, userId, {
        approvalId: context.approval.id,
        idempotencyKey: 'request-123',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(http.request).not.toHaveBeenCalled();
  });

  it('allows only one active attempt for the same approved binding', async () => {
    const { prisma, http, service } = harness();
    const context = approvalFor(service);
    prisma.wordPressDraftApproval.findFirst.mockResolvedValue({
      ...context.approval,
      connection: context.connection,
      document: context.document,
      actionItem: context.action,
    });
    prisma.wordPressDraftAttempt.findFirst.mockResolvedValue({
      id: 'attempt-1',
      approvalId: context.approval.id,
      status: 'in_flight',
    });

    await expect(
      service.createDraft(organizationId, userId, {
        approvalId: context.approval.id,
        idempotencyKey: 'request-123',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(http.request).not.toHaveBeenCalled();
  });

  it('rechecks the binding after the durable claim and sends nothing if it changed', async () => {
    const { prisma, http, service } = harness();
    const context = approvalFor(service);
    context.connection.encryptedApplicationPassword = 'configured';
    const initial = {
      ...context.approval,
      connection: context.connection,
      document: context.document,
      actionItem: context.action,
    };
    const changed = {
      ...initial,
      connection: {
        ...context.connection,
        connectionVersion: context.connection.connectionVersion + 1,
      },
    };
    prisma.wordPressDraftApproval.findFirst
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed);
    prisma.wordPressDraftAttempt.findFirst.mockResolvedValue(null);
    prisma.wordPressDraftAttempt.create.mockResolvedValue({ id: 'attempt-1' });
    prisma.wordPressDraftAttempt.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.createDraft(organizationId, userId, {
        approvalId: context.approval.id,
        idempotencyKey: 'request-123',
      }),
    ).rejects.toThrow('Le document ou la connexion a changé avant l’envoi.');
    expect(http.request).not.toHaveBeenCalled();
    expect(prisma.wordPressDraftAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          errorCode: 'publication_denied_before_dispatch_approval_stale',
        }),
      }),
    );
  });

  it('sends nothing to WordPress when the approval is revoked between the pre-claim read and the claimed read', async () => {
    const { prisma, http, service } = harness();
    const context = approvalFor(service);
    context.connection.encryptedApplicationPassword = 'configured';
    const initial = {
      ...context.approval,
      connection: context.connection,
      document: context.document,
      actionItem: context.action,
    };
    // Simulates revokeApproval() committing in the window between the
    // pre-claim publicationContext() read and the post-claim re-read.
    const revokedAfterClaim = { ...initial, revokedAt: new Date() };
    prisma.wordPressDraftApproval.findFirst
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(revokedAfterClaim);
    prisma.wordPressDraftAttempt.findFirst.mockResolvedValue(null);
    prisma.wordPressDraftAttempt.create.mockResolvedValue({ id: 'attempt-1' });
    prisma.wordPressDraftAttempt.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.createDraft(organizationId, userId, {
        approvalId: context.approval.id,
        idempotencyKey: 'request-123',
      }),
    ).rejects.toThrow(
      'L’approbation n’est plus valide (elle a été révoquée avant l’envoi).',
    );
    expect(http.request).not.toHaveBeenCalled();
    expect(prisma.wordPressDraftAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          errorCode: 'publication_denied_before_dispatch_approval_required',
        }),
      }),
    );
  });

  it('marks a lost POST response unknown and never retries it blindly', async () => {
    const { prisma, http, service } = harness();
    const context = approvalFor(service);
    context.connection.encryptedApplicationPassword = (
      service as never as {
        encrypt: (
          value: string,
          organizationId: string,
          websiteId: string,
        ) => string;
      }
    ).encrypt('application-password', organizationId, websiteId);
    prisma.wordPressDraftApproval.findFirst.mockResolvedValue({
      ...context.approval,
      connection: context.connection,
      document: context.document,
      actionItem: context.action,
    });
    prisma.wordPressDraftAttempt.findFirst.mockResolvedValue(null);
    prisma.wordPressDraftAttempt.create.mockResolvedValue({ id: 'attempt-1' });
    prisma.wordPressDraftAttempt.updateMany.mockResolvedValue({ count: 1 });
    http.request.mockRejectedValue(new WordPressNetworkError('socket reset'));

    await expect(
      service.createDraft(organizationId, userId, {
        approvalId: context.approval.id,
        idempotencyKey: 'request-123',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.wordPressDraftAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'unknown' }),
      }),
    );
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it('creates only a draft, persists safe evidence and never returns credentials', async () => {
    const { prisma, http, service } = harness();
    const context = approvalFor(service);
    context.connection.encryptedApplicationPassword = (
      service as never as {
        encrypt: (
          value: string,
          organizationId: string,
          websiteId: string,
        ) => string;
      }
    ).encrypt('application-password', organizationId, websiteId);
    prisma.wordPressDraftApproval.findFirst.mockResolvedValue({
      ...context.approval,
      connection: context.connection,
      document: context.document,
      actionItem: context.action,
    });
    prisma.wordPressDraftAttempt.findFirst.mockResolvedValue(null);
    prisma.wordPressDraftAttempt.create.mockResolvedValue({ id: 'attempt-1' });
    const tx = {
      wordPressDraftAttempt: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      actionItem: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ organizationId }),
      },
      actionExecutionEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation(
      (callback: (value: typeof tx) => unknown) => callback(tx),
    );
    http.request.mockResolvedValue({
      status: 201,
      body: {
        id: 42,
        status: 'draft',
        slug: 'remote-slug',
        link: 'https://example.com/?p=42',
      },
    });

    const result = await service.createDraft(organizationId, userId, {
      approvalId: context.approval.id,
      idempotencyKey: 'request-123',
    });

    const outbound = http.request.mock.calls[0][0] as WordPressHttpRequest;
    expect(outbound.body).toEqual(
      expect.objectContaining({
        status: 'draft',
        slug: expect.stringMatching(/^robia-/),
      }),
    );
    expect(JSON.stringify(outbound.body)).toContain('robia-draft:');
    expect(result.attempt).toEqual(
      expect.objectContaining({ status: 'confirmed', remotePostId: '42' }),
    );
    expect(JSON.stringify(result)).not.toContain('application-password');
    expect(tx.actionExecutionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'execution_succeeded' }),
      }),
    );
  });

  it('does not finalize a remote success after losing the attempt claim', async () => {
    const { prisma, http, service } = harness();
    const context = approvalFor(service);
    context.connection.encryptedApplicationPassword = (
      service as never as {
        encrypt: (
          value: string,
          organizationId: string,
          websiteId: string,
        ) => string;
      }
    ).encrypt('application-password', organizationId, websiteId);
    prisma.wordPressDraftApproval.findFirst.mockResolvedValue({
      ...context.approval,
      connection: context.connection,
      document: context.document,
      actionItem: context.action,
    });
    prisma.wordPressDraftAttempt.findFirst.mockResolvedValue(null);
    prisma.wordPressDraftAttempt.create.mockResolvedValue({ id: 'attempt-1' });
    prisma.wordPressDraftAttempt.updateMany.mockResolvedValue({ count: 0 });
    http.request.mockResolvedValue({
      status: 201,
      body: { id: 42, status: 'draft', link: 'https://example.com/?p=42' },
    });

    await expect(
      service.createDraft(organizationId, userId, {
        approvalId: context.approval.id,
        idempotencyKey: 'request-123',
      }),
    ).rejects.toThrow('perdu son bail');
    expect(prisma.actionItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.actionExecutionEvent.create).not.toHaveBeenCalled();
  });

  it('exposes the document revision each attempt was created for, from its approval', async () => {
    const { prisma, service } = harness();
    prisma.website.findFirst.mockResolvedValue({ id: websiteId });
    prisma.wordPressDraftAttempt.findMany.mockResolvedValue([
      {
        id: 'attempt-1',
        approvalId: 'approval-1',
        documentId: 'document-1',
        actionItemId: 'action-1',
        status: 'confirmed',
        remotePostId: '42',
        remoteUrl: 'https://example.com/?p=42',
        remoteEditorUrl: 'https://example.com/wp-admin/post.php?post=42',
        errorCode: null,
        createdAt: new Date('2026-09-24T08:00:00Z'),
        updatedAt: new Date('2026-09-24T08:00:00Z'),
        confirmedAt: new Date('2026-09-24T08:00:00Z'),
        approval: { documentRevision: 3 },
      },
    ]);

    const attempts = await service.listAttempts(organizationId, websiteId);

    expect(attempts).toEqual([
      expect.objectContaining({ id: 'attempt-1', documentRevision: 3 }),
    ]);
    // The join detail never leaks into the response shape callers consume.
    expect(attempts[0]).not.toHaveProperty('approval');
  });
});
