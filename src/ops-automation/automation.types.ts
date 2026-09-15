import { Prisma } from '@prisma/client';

export interface StoredAutomationStep {
  actionType: string;
  input?: Record<string, unknown>;
}

export type AutomationWithTrigger = Prisma.AutomationGetPayload<{
  include: { trigger: true };
}>;

export type AutomationRunWithSteps = Prisma.AutomationRunGetPayload<{
  include: { steps: true };
}>;

export function readStoredSteps(
  value: Prisma.JsonValue | null | undefined,
): StoredAutomationStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const steps: StoredAutomationStep[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.actionType !== 'string') {
      continue;
    }
    steps.push({
      actionType: record.actionType,
      input:
        record.input && typeof record.input === 'object'
          ? (record.input as Record<string, unknown>)
          : undefined,
    });
  }
  return steps;
}
