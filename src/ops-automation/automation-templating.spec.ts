import { resolveStepInput } from './automation-templating';

describe('resolveStepInput', () => {
  it('returns the input unchanged when there is no placeholder', () => {
    expect(resolveStepInput({ title: 'Fixe' }, { auditId: 'a1' })).toEqual({
      title: 'Fixe',
    });
  });

  it('substitutes a matching {{event.<key>}} placeholder from the event payload', () => {
    expect(
      resolveStepInput({ auditId: '{{event.auditId}}' }, { auditId: 'a1' }),
    ).toEqual({ auditId: 'a1' });
  });

  it('resolves to null when there is no event payload (manual/scheduled run)', () => {
    expect(resolveStepInput({ auditId: '{{event.auditId}}' }, null)).toEqual({
      auditId: null,
    });
    expect(
      resolveStepInput({ auditId: '{{event.auditId}}' }, undefined),
    ).toEqual({ auditId: null });
  });

  it('resolves to null when the key is absent from the payload', () => {
    expect(
      resolveStepInput({ auditId: '{{event.auditId}}' }, { other: 'x' }),
    ).toEqual({ auditId: null });
  });

  it('leaves a string that is not an exact placeholder untouched', () => {
    expect(
      resolveStepInput(
        { title: 'Audit {{event.auditId}} terminé' },
        { auditId: 'a1' },
      ),
    ).toEqual({ title: 'Audit {{event.auditId}} terminé' });
  });

  it('passes through non-string values untouched', () => {
    expect(
      resolveStepInput({ count: 5, flag: true }, { auditId: 'a1' }),
    ).toEqual({ count: 5, flag: true });
  });

  it('returns undefined input as-is', () => {
    expect(resolveStepInput(undefined, { auditId: 'a1' })).toBeUndefined();
  });
});
