import { checkCompleteness, computeWeightedTotal } from './odc-completeness';

describe('checkCompleteness', () => {
  const fields = [
    { key: 'motivation', required: true },
    { key: 'phone', required: false },
  ];
  const documentTypes = [
    { id: 'dt-1', key: 'id_card', required: true },
    { id: 'dt-2', key: 'cv', required: false },
  ];

  it('is complete when every required field is filled and every required document type has a received document', () => {
    const result = checkCompleteness(
      fields,
      documentTypes,
      { motivation: 'I really want this' },
      [{ documentTypeId: 'dt-1', status: 'received' }],
    );
    expect(result).toEqual({ complete: true, missing: [] });
  });

  it('flags a missing required field, prefixed "field:"', () => {
    const result = checkCompleteness(fields, documentTypes, {}, [
      { documentTypeId: 'dt-1', status: 'received' },
    ]);
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('field:motivation');
  });

  it('treats a whitespace-only string field value as missing, not filled', () => {
    const result = checkCompleteness(
      fields,
      documentTypes,
      { motivation: '   ' },
      [{ documentTypeId: 'dt-1', status: 'received' }],
    );
    expect(result.missing).toContain('field:motivation');
  });

  it('never flags an optional field as missing', () => {
    const result = checkCompleteness(
      fields,
      documentTypes,
      { motivation: 'yes' },
      [{ documentTypeId: 'dt-1', status: 'received' }],
    );
    expect(result.missing).not.toContain('field:phone');
  });

  it('flags a missing required document type, prefixed "document:"', () => {
    const result = checkCompleteness(
      fields,
      documentTypes,
      { motivation: 'yes' },
      [],
    );
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('document:id_card');
  });

  it('never counts a pending_upload or rejected document as satisfying a required document type', () => {
    for (const status of ['pending_upload', 'rejected']) {
      const result = checkCompleteness(
        fields,
        documentTypes,
        { motivation: 'yes' },
        [{ documentTypeId: 'dt-1', status }],
      );
      expect(result.missing).toContain('document:id_card');
    }
  });

  it('never flags an optional document type as missing', () => {
    const result = checkCompleteness(
      fields,
      documentTypes,
      { motivation: 'yes' },
      [{ documentTypeId: 'dt-1', status: 'received' }],
    );
    expect(result.missing).not.toContain('document:cv');
  });

  it('accepts a non-string, non-empty field value (e.g. a number) as filled', () => {
    const numericFields = [{ key: 'age', required: true }];
    const result = checkCompleteness(numericFields, [], { age: 0 }, []);
    expect(result.complete).toBe(true);
  });
});

describe('computeWeightedTotal', () => {
  const criteria = [
    { id: 'c1', weight: 2, required: true },
    { id: 'c2', weight: 1, required: true },
    { id: 'c3', weight: 5, required: false },
  ];

  it('returns null while any required criterion has no points recorded', () => {
    const total = computeWeightedTotal(criteria, [
      { criterionId: 'c1', points: 3 },
    ]);
    expect(total).toBeNull();
  });

  it('never returns 0 for an incomplete set of required criteria — null, not a fabricated total', () => {
    const total = computeWeightedTotal(criteria, [
      { criterionId: 'c1', points: 0 },
    ]);
    expect(total).toBeNull();
  });

  it('computes the weighted sum once every required criterion has points', () => {
    const total = computeWeightedTotal(criteria, [
      { criterionId: 'c1', points: 3 },
      { criterionId: 'c2', points: 4 },
    ]);
    // 3*2 + 4*1 = 10 (c3 is optional and unset, contributes 0)
    expect(total).toBe(10);
  });

  it("adds an optional criterion's points when present, without requiring it", () => {
    const total = computeWeightedTotal(criteria, [
      { criterionId: 'c1', points: 3 },
      { criterionId: 'c2', points: 4 },
      { criterionId: 'c3', points: 2 },
    ]);
    // 3*2 + 4*1 + 2*5 = 20
    expect(total).toBe(20);
  });

  it('returns 0 (not null) when there are no required criteria and no lines at all', () => {
    const total = computeWeightedTotal(
      [{ id: 'c1', weight: 3, required: false }],
      [],
    );
    expect(total).toBe(0);
  });
});
