/**
 * RC-20 — deterministic condition engine.
 *
 * No `eval()`, no `new Function()`, no dynamically interpreted JavaScript of
 * any kind. A condition tree only ever references a field from the
 * allowlisted `FIELD_REGISTRY` below, compared with a plain, typed operator
 * function. A tree that names an unregistered field, or pairs a field with
 * an operator its type does not support, is rejected by
 * `validateConditionTree()` at automation-creation time — it never reaches
 * evaluation.
 *
 * Null handling mirrors RC-19's rule: an absent value is never coerced into
 * a comparable one ("absence != 0"). Every comparison operator except
 * `exists`/`notExists` evaluates to `false` when the resolved value is
 * `null`/`undefined`, rather than throwing or guessing.
 */

export type ConditionValueType = 'number' | 'string' | 'boolean';

export type ComparisonOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'notIn'
  | 'exists'
  | 'notExists';

export type ConditionLeafValue =
  string | number | boolean | Array<string | number>;

export interface ConditionLeaf {
  field: string;
  operator: ComparisonOperator;
  value?: ConditionLeafValue;
}

export interface ConditionGroup {
  all?: ConditionNode[];
  any?: ConditionNode[];
  not?: ConditionNode;
}

export type ConditionNode = ConditionLeaf | ConditionGroup;

// RC-20: the only data a condition can ever see. Every field below is
// read-only, per-organization, and free of secrets — never a raw token,
// connection row, or anything from a third-party payload.
export interface AutomationConditionContext {
  audit: {
    ageDays: number | null;
    status: string | null;
    globalScore: number | null;
  };
  integration: {
    googleSearchConsole: { status: 'connected' | 'disconnected' };
    meta: { status: 'connected' | 'disconnected' };
  };
  opportunity: {
    count: number;
    highPriorityCount: number;
  };
  website: {
    count: number;
  };
}

export interface FieldDescriptor {
  type: ConditionValueType;
  resolve: (context: AutomationConditionContext) => unknown;
}

// The allowlist. Adding a field means adding an entry here — there is no
// other path from a condition tree to application data.
export const FIELD_REGISTRY: Record<string, FieldDescriptor> = {
  'audit.ageDays': {
    type: 'number',
    resolve: (ctx) => ctx.audit.ageDays,
  },
  'audit.status': {
    type: 'string',
    resolve: (ctx) => ctx.audit.status,
  },
  'audit.globalScore': {
    type: 'number',
    resolve: (ctx) => ctx.audit.globalScore,
  },
  'integration.googleSearchConsole.status': {
    type: 'string',
    resolve: (ctx) => ctx.integration.googleSearchConsole.status,
  },
  'integration.meta.status': {
    type: 'string',
    resolve: (ctx) => ctx.integration.meta.status,
  },
  'opportunity.count': {
    type: 'number',
    resolve: (ctx) => ctx.opportunity.count,
  },
  'opportunity.highPriorityCount': {
    type: 'number',
    resolve: (ctx) => ctx.opportunity.highPriorityCount,
  },
  'website.count': {
    type: 'number',
    resolve: (ctx) => ctx.website.count,
  },
};

const OPERATORS_BY_TYPE: Record<ConditionValueType, ComparisonOperator[]> = {
  number: [
    'eq',
    'ne',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'notIn',
    'exists',
    'notExists',
  ],
  string: ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'],
  boolean: ['eq', 'ne', 'exists', 'notExists'],
};

const MAX_CONDITION_DEPTH = 6;

export class InvalidConditionError extends Error {}

function isLeaf(node: ConditionNode): node is ConditionLeaf {
  return typeof (node as ConditionLeaf).field === 'string';
}

function groupChildren(node: ConditionGroup): ConditionNode[] {
  if (node.all) return node.all;
  if (node.any) return node.any;
  if (node.not) return [node.not];
  return [];
}

/**
 * Throws InvalidConditionError on anything not covered by the allowlist.
 * Call this whenever an Automation's conditions are created or updated —
 * never persist an unvalidated tree.
 */
export function validateConditionTree(node: ConditionNode, depth = 0): void {
  if (depth > MAX_CONDITION_DEPTH) {
    throw new InvalidConditionError(
      `Condition tree exceeds the maximum nesting depth of ${MAX_CONDITION_DEPTH}.`,
    );
  }

  if (isLeaf(node)) {
    const descriptor = FIELD_REGISTRY[node.field];
    if (!descriptor) {
      throw new InvalidConditionError(
        `Unknown condition field: "${node.field}".`,
      );
    }
    if (!OPERATORS_BY_TYPE[descriptor.type].includes(node.operator)) {
      throw new InvalidConditionError(
        `Operator "${node.operator}" is not allowed for field "${node.field}" (type ${descriptor.type}).`,
      );
    }
    if (node.operator === 'in' || node.operator === 'notIn') {
      if (!Array.isArray(node.value) || node.value.length === 0) {
        throw new InvalidConditionError(
          `Operator "${node.operator}" requires a non-empty array value.`,
        );
      }
    } else if (node.operator !== 'exists' && node.operator !== 'notExists') {
      if (
        node.value === undefined ||
        Array.isArray(node.value) ||
        typeof node.value !== descriptor.type
      ) {
        throw new InvalidConditionError(
          `Operator "${node.operator}" on field "${node.field}" requires a ${descriptor.type} value.`,
        );
      }
    }
    return;
  }

  const groupKeys = ['all', 'any', 'not'] as const;
  const presentKeys = groupKeys.filter((key) => node[key] !== undefined);
  if (presentKeys.length !== 1) {
    throw new InvalidConditionError(
      'A condition group must set exactly one of "all", "any", or "not".',
    );
  }
  const children = groupChildren(node);
  if (children.length === 0) {
    throw new InvalidConditionError('A condition group cannot be empty.');
  }
  for (const child of children) {
    validateConditionTree(child, depth + 1);
  }
}

function compareLeaf(
  operator: ComparisonOperator,
  actual: unknown,
  expected: ConditionLeafValue | undefined,
): boolean {
  if (operator === 'exists') {
    return actual !== null && actual !== undefined;
  }
  if (operator === 'notExists') {
    return actual === null || actual === undefined;
  }

  // Absence is never coerced into a comparable value (never "== 0",
  // never "== false") — an unresolved field simply fails every other
  // comparison deterministically.
  if (actual === null || actual === undefined) {
    return false;
  }

  switch (operator) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'gt':
      return typeof actual === 'number' && actual > (expected as number);
    case 'gte':
      return typeof actual === 'number' && actual >= (expected as number);
    case 'lt':
      return typeof actual === 'number' && actual < (expected as number);
    case 'lte':
      return typeof actual === 'number' && actual <= (expected as number);
    case 'in':
      return (
        Array.isArray(expected) && (expected as Array<unknown>).includes(actual)
      );
    case 'notIn':
      return (
        Array.isArray(expected) &&
        !(expected as Array<unknown>).includes(actual)
      );
    default:
      return false;
  }
}

function evaluateNode(
  node: ConditionNode,
  context: AutomationConditionContext,
): boolean {
  if (isLeaf(node)) {
    const descriptor = FIELD_REGISTRY[node.field];
    if (!descriptor) {
      // Only reachable if a tree was persisted without validation — fail
      // closed rather than throwing mid-evaluation of a run.
      return false;
    }
    return compareLeaf(node.operator, descriptor.resolve(context), node.value);
  }
  if (node.all) {
    return node.all.every((child) => evaluateNode(child, context));
  }
  if (node.any) {
    return node.any.some((child) => evaluateNode(child, context));
  }
  if (node.not) {
    return !evaluateNode(node.not, context);
  }
  return false;
}

/**
 * No conditions configured means "always eligible" — an Automation with an
 * empty condition tree runs unconditionally on its trigger, which is a
 * deliberate, documented default, not an evaluation bug.
 */
export function evaluateConditions(
  node: ConditionNode | null | undefined,
  context: AutomationConditionContext,
): boolean {
  if (!node) {
    return true;
  }
  return evaluateNode(node, context);
}
