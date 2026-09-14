import {
  AutomationConditionContext,
  InvalidConditionError,
  evaluateConditions,
  validateConditionTree,
} from './condition-engine';

function baseContext(
  overrides: Partial<AutomationConditionContext> = {},
): AutomationConditionContext {
  return {
    audit: { ageDays: 3, status: 'completed', globalScore: 70 },
    integration: {
      googleSearchConsole: { status: 'connected' },
      meta: { status: 'connected' },
    },
    opportunity: { count: 2, highPriorityCount: 0 },
    website: { count: 1 },
    ...overrides,
  };
}

describe('condition-engine — validation', () => {
  it('accepts a single allowlisted leaf', () => {
    expect(() =>
      validateConditionTree({
        field: 'audit.ageDays',
        operator: 'gt',
        value: 7,
      }),
    ).not.toThrow();
  });

  it('rejects an unregistered field', () => {
    expect(() =>
      validateConditionTree({
        field: 'audit.__proto__',
        operator: 'eq',
        value: 'x',
      }),
    ).toThrow(InvalidConditionError);
  });

  it('rejects an operator not supported by the field type', () => {
    expect(() =>
      validateConditionTree({
        field: 'audit.status',
        operator: 'gt',
        value: 'completed',
      }),
    ).toThrow(InvalidConditionError);
  });

  it('rejects a value of the wrong type for the field', () => {
    expect(() =>
      validateConditionTree({
        field: 'audit.ageDays',
        operator: 'gt',
        value: 'not-a-number' as unknown as number,
      }),
    ).toThrow(InvalidConditionError);
  });

  it('rejects "in" without an array value', () => {
    expect(() =>
      validateConditionTree({
        field: 'audit.status',
        operator: 'in',
        value: 'completed',
      }),
    ).toThrow(InvalidConditionError);
  });

  it('rejects a group with more than one of all/any/not', () => {
    expect(() =>
      validateConditionTree({
        all: [{ field: 'audit.ageDays', operator: 'gt', value: 1 }],
        any: [{ field: 'audit.ageDays', operator: 'gt', value: 1 }],
      }),
    ).toThrow(InvalidConditionError);
  });

  it('rejects an empty group', () => {
    expect(() => validateConditionTree({ all: [] })).toThrow(
      InvalidConditionError,
    );
  });

  it('rejects a tree nested deeper than the configured maximum', () => {
    let node: import('./condition-engine').ConditionNode = {
      field: 'audit.ageDays',
      operator: 'gt',
      value: 1,
    };
    for (let i = 0; i < 10; i += 1) {
      node = { all: [node] };
    }
    expect(() => validateConditionTree(node)).toThrow(InvalidConditionError);
  });

  it('accepts a valid nested all/any/not tree', () => {
    expect(() =>
      validateConditionTree({
        all: [
          { field: 'audit.ageDays', operator: 'gt', value: 7 },
          {
            any: [
              {
                field: 'integration.googleSearchConsole.status',
                operator: 'eq',
                value: 'disconnected',
              },
              { field: 'opportunity.count', operator: 'gt', value: 0 },
            ],
          },
          { not: { field: 'audit.status', operator: 'eq', value: 'failed' } },
        ],
      }),
    ).not.toThrow();
  });
});

describe('condition-engine — evaluation', () => {
  it('treats no conditions as always eligible', () => {
    expect(evaluateConditions(null, baseContext())).toBe(true);
    expect(evaluateConditions(undefined, baseContext())).toBe(true);
  });

  it('evaluates a simple numeric comparison to true', () => {
    const ctx = baseContext({
      audit: { ageDays: 10, status: 'completed', globalScore: 70 },
    });
    expect(
      evaluateConditions(
        { field: 'audit.ageDays', operator: 'gt', value: 7 },
        ctx,
      ),
    ).toBe(true);
  });

  it('evaluates a simple numeric comparison to false', () => {
    const ctx = baseContext({
      audit: { ageDays: 3, status: 'completed', globalScore: 70 },
    });
    expect(
      evaluateConditions(
        { field: 'audit.ageDays', operator: 'gt', value: 7 },
        ctx,
      ),
    ).toBe(false);
  });

  it('evaluates a string equality condition (integration disconnected)', () => {
    const disconnected = baseContext({
      integration: {
        googleSearchConsole: { status: 'disconnected' },
        meta: { status: 'connected' },
      },
    });
    expect(
      evaluateConditions(
        {
          field: 'integration.googleSearchConsole.status',
          operator: 'eq',
          value: 'disconnected',
        },
        disconnected,
      ),
    ).toBe(true);

    const connected = baseContext();
    expect(
      evaluateConditions(
        {
          field: 'integration.googleSearchConsole.status',
          operator: 'eq',
          value: 'disconnected',
        },
        connected,
      ),
    ).toBe(false);
  });

  it('evaluates opportunity.count > 0', () => {
    expect(
      evaluateConditions(
        { field: 'opportunity.count', operator: 'gt', value: 0 },
        baseContext({ opportunity: { count: 1, highPriorityCount: 0 } }),
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        { field: 'opportunity.count', operator: 'gt', value: 0 },
        baseContext({ opportunity: { count: 0, highPriorityCount: 0 } }),
      ),
    ).toBe(false);
  });

  it('never coerces a null/absent value into a comparable one', () => {
    const ctx = baseContext({
      audit: { ageDays: null, status: null, globalScore: null },
    });
    expect(
      evaluateConditions(
        { field: 'audit.ageDays', operator: 'gt', value: 0 },
        ctx,
      ),
    ).toBe(false);
    expect(
      evaluateConditions(
        { field: 'audit.ageDays', operator: 'eq', value: 0 },
        ctx,
      ),
    ).toBe(false);
    expect(
      evaluateConditions(
        { field: 'audit.ageDays', operator: 'notExists' },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateConditions({ field: 'audit.ageDays', operator: 'exists' }, ctx),
    ).toBe(false);
  });

  it('evaluates "all" (AND) correctly', () => {
    const tree = {
      all: [
        { field: 'audit.ageDays' as const, operator: 'gt' as const, value: 7 },
        {
          field: 'opportunity.count' as const,
          operator: 'gt' as const,
          value: 0,
        },
      ],
    };
    expect(
      evaluateConditions(
        tree,
        baseContext({
          audit: { ageDays: 10, status: 'completed', globalScore: 70 },
          opportunity: { count: 1, highPriorityCount: 0 },
        }),
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        tree,
        baseContext({
          audit: { ageDays: 10, status: 'completed', globalScore: 70 },
          opportunity: { count: 0, highPriorityCount: 0 },
        }),
      ),
    ).toBe(false);
  });

  it('evaluates "any" (OR) correctly', () => {
    const tree = {
      any: [
        {
          field: 'integration.googleSearchConsole.status' as const,
          operator: 'eq' as const,
          value: 'disconnected',
        },
        {
          field: 'integration.meta.status' as const,
          operator: 'eq' as const,
          value: 'disconnected',
        },
      ],
    };
    expect(
      evaluateConditions(
        tree,
        baseContext({
          integration: {
            googleSearchConsole: { status: 'connected' },
            meta: { status: 'disconnected' },
          },
        }),
      ),
    ).toBe(true);
    expect(evaluateConditions(tree, baseContext())).toBe(false);
  });

  it('evaluates "not" correctly', () => {
    const tree = {
      not: {
        field: 'audit.status' as const,
        operator: 'eq' as const,
        value: 'failed',
      },
    };
    expect(
      evaluateConditions(
        tree,
        baseContext({
          audit: { ageDays: 1, status: 'failed', globalScore: null },
        }),
      ),
    ).toBe(false);
    expect(evaluateConditions(tree, baseContext())).toBe(true);
  });

  it('evaluates "in" / "notIn" correctly', () => {
    const ctx = baseContext({
      audit: { ageDays: 1, status: 'failed', globalScore: null },
    });
    expect(
      evaluateConditions(
        { field: 'audit.status', operator: 'in', value: ['failed', 'pending'] },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        {
          field: 'audit.status',
          operator: 'notIn',
          value: ['failed', 'pending'],
        },
        ctx,
      ),
    ).toBe(false);
  });

  it('is deterministic: repeated evaluation of the same tree and context always agrees', () => {
    const tree = {
      all: [
        { field: 'audit.ageDays' as const, operator: 'gt' as const, value: 7 },
        {
          field: 'integration.meta.status' as const,
          operator: 'eq' as const,
          value: 'disconnected',
        },
      ],
    };
    const ctx = baseContext({
      audit: { ageDays: 30, status: 'completed', globalScore: 80 },
      integration: {
        googleSearchConsole: { status: 'connected' },
        meta: { status: 'disconnected' },
      },
    });
    const first = evaluateConditions(tree, ctx);
    const second = evaluateConditions(tree, ctx);
    expect(first).toBe(true);
    expect(second).toBe(true);
  });
});
