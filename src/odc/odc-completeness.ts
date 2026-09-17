// RC-29 — pure, deterministic completeness and scoring rules. Nothing here
// calls the AI, nothing here decides a candidature's fate: this module only
// answers "is this application complete?" and "what does the weighted total
// currently add up to?", both purely from already-persisted rows. See
// docs/RC29_ODC_CANDIDATURES.md ("Complétude", "Score").

export interface CompletenessField {
  key: string;
  required: boolean;
}

export interface CompletenessDocumentType {
  id: string;
  key: string;
  required: boolean;
}

export interface CompletenessDocument {
  documentTypeId: string;
  status: string;
}

export interface CompletenessResult {
  complete: boolean;
  // "field:<key>" / "document:<key>" — stable, machine-checkable identifiers
  // (never a human sentence) so a caller (API response, test) can assert on
  // exactly what's missing without parsing prose.
  missing: string[];
}

// A field/document type counts as satisfied only by what's actually
// persisted right now — never a placeholder, never "probably fine". A field
// value must be a non-empty string once trimmed (or any non-null/undefined
// non-string value, e.g. a number or a date), and a required document type
// needs at least one of its own documents at status 'received' (never
// 'pending_upload' or 'rejected').
export function checkCompleteness(
  fields: CompletenessField[],
  documentTypes: CompletenessDocumentType[],
  answers: Record<string, unknown>,
  documents: CompletenessDocument[],
): CompletenessResult {
  const missing: string[] = [];

  for (const field of fields) {
    if (!field.required) continue;
    const value = answers[field.key];
    const isEmpty =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim().length === 0);
    if (isEmpty) {
      missing.push(`field:${field.key}`);
    }
  }

  for (const docType of documentTypes) {
    if (!docType.required) continue;
    const hasReceived = documents.some(
      (doc) => doc.documentTypeId === docType.id && doc.status === 'received',
    );
    if (!hasReceived) {
      missing.push(`document:${docType.key}`);
    }
  }

  return { complete: missing.length === 0, missing };
}

export interface ScoreCriterion {
  id: string;
  weight: number;
  required: boolean;
}

export interface ScoreLinePoints {
  criterionId: string;
  points: number | null;
}

// Weighted sum of points across every criterion, gated on completeness of
// the *required* subset: if any required criterion has no points recorded
// yet, the total is null — never 0, never a partial sum silently presented
// as final. An optional criterion missing its points simply contributes 0,
// rather than blocking the total the way a missing required one does.
export function computeWeightedTotal(
  criteria: ScoreCriterion[],
  lines: ScoreLinePoints[],
): number | null {
  for (const criterion of criteria) {
    if (!criterion.required) continue;
    const line = lines.find((l) => l.criterionId === criterion.id);
    if (line === undefined || line.points === null) {
      return null;
    }
  }

  let total = 0;
  for (const criterion of criteria) {
    const line = lines.find((l) => l.criterionId === criterion.id);
    const points = line?.points ?? 0;
    total += points * criterion.weight;
  }
  return total;
}
