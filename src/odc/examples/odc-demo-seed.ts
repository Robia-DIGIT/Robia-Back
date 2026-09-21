import { randomUUID } from 'node:crypto';
import type { OdcProgramsService } from '../odc-programs.service';
import type {
  OdcApplicationsService,
  OdcApplicationWithRelations,
} from '../odc-applications.service';

/**
 * RC-32 — demo seed for the ODC candidature workflow. Populates one program
 * plus a handful of ready-to-review candidatures so the sort/outreach screen
 * (RC-31b) and the kanban (RC-29b) are never demoed against an empty state.
 *
 * Like RC-20's EXAMPLE_AUTOMATIONS, this is never imported by app bootstrap,
 * a module, or a migration — it only runs when an operator explicitly calls
 * `seedOdcDemo()` (see scripts/seed-odc-demo.ts). It is not idempotent: a
 * second call for the same organization throws (duplicate program slug),
 * the same as calling OdcProgramsService.create() twice with the same slug
 * would from any other caller.
 *
 * Every candidate's email is under example.com — an IANA-reserved domain
 * (RFC 2606) that can never resolve to a real inbox. That is deliberate:
 * OdcOutreachService.send() always resolves its recipient from
 * OdcApplicant.email server-side (non-negotiable rule — see
 * docs/RC29_ODC_CANDIDATURES.md and docs/RC31_ODC_CV_OUTREACH.md), so an
 * operator who forgets this is demo data and queues/sends an outreach email
 * against it can never actually deliver anything.
 */

export const ODC_DEMO_PROGRAM_SLUG = 'demo-odc-2026';

// RC-33 hardening — no storageKey here: it can only be computed once the
// real organizationId/applicationId/documentId triplet exists (see the seed
// loop below, which builds a canonical key and calls
// OdcApplicationsService.addUploadedDocument() directly — the same
// server-side-only path a real upload uses, never the public
// addDocument()/CreateOdcDocumentDto contract, which can no longer accept a
// storageKey at all).
interface OdcDemoDocumentSeed {
  documentTypeKey: 'cv' | 'pitch_deck';
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

interface OdcDemoApplicantSeed {
  displayName: string;
  email: string;
  answers: { motivation: string; linkedin?: string };
  documents: OdcDemoDocumentSeed[];
}

function cvAndPitchDeck(slug: string): OdcDemoDocumentSeed[] {
  return [
    {
      documentTypeKey: 'cv',
      originalName: `cv-${slug}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 214_000,
    },
    {
      documentTypeKey: 'pitch_deck',
      originalName: `pitch-deck-${slug}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 1_450_000,
    },
  ];
}

export const ODC_DEMO_APPLICANTS: OdcDemoApplicantSeed[] = [
  {
    displayName: 'Fitia Razanadrakoto',
    email: 'fitia.razanadrakoto@example.com',
    answers: {
      motivation:
        "Je veux structurer une plateforme de suivi des cultures pour les coopératives agricoles d'Analamanga.",
      linkedin: 'https://www.linkedin.com/in/fitia-razanadrakoto',
    },
    documents: cvAndPitchDeck('fitia-razanadrakoto'),
  },
  {
    displayName: 'Njaka Andriamahefa',
    email: 'njaka.andriamahefa@example.com',
    answers: {
      motivation:
        'Mon projet connecte les artisans de Toamasina à des acheteurs internationaux via une place de marché mobile.',
    },
    documents: cvAndPitchDeck('njaka-andriamahefa'),
  },
  {
    displayName: 'Voahangy Rasoanantenaina',
    email: 'voahangy.rasoanantenaina@example.com',
    answers: {
      motivation:
        'Je développe un service de paiement de proximité pour les petits commerces sans compte bancaire.',
      linkedin: 'https://www.linkedin.com/in/voahangy-rasoanantenaina',
    },
    documents: cvAndPitchDeck('voahangy-rasoanantenaina'),
  },
];

export interface OdcDemoSeedResult {
  programId: string;
  applications: OdcApplicationWithRelations[];
}

export async function seedOdcDemo(
  services: {
    programs: OdcProgramsService;
    applications: OdcApplicationsService;
  },
  organizationId: string,
  userId: string,
): Promise<OdcDemoSeedResult> {
  const program = await services.programs.create(organizationId, userId, {
    slug: ODC_DEMO_PROGRAM_SLUG,
    name: 'Programme démo — Orange Digital Center (seed RC-32)',
    description:
      "Programme de démonstration : candidatures pré-remplies pour tester le tri, la revue et l'envoi d'emails (RC-29b/RC-31/RC-31b) sans dépendre d'un vrai appel à candidatures.",
    fields: [
      {
        key: 'motivation',
        label: 'Lettre de motivation',
        required: true,
        fieldType: 'longtext',
      },
      {
        key: 'linkedin',
        label: 'Profil LinkedIn (optionnel)',
        required: false,
        fieldType: 'text',
      },
    ],
    criteria: [
      {
        key: 'motivation_clarity',
        label: 'Clarté du projet',
        weight: 2,
        maxPoints: 5,
        required: true,
      },
      {
        key: 'technical_fit',
        label: 'Adéquation technique',
        weight: 1,
        maxPoints: 5,
        required: false,
      },
    ],
    docTypes: [
      {
        key: 'cv',
        label: 'CV',
        required: true,
        mimeAllow: ['application/pdf'],
      },
      {
        key: 'pitch_deck',
        label: 'Pitch deck',
        required: true,
        mimeAllow: ['application/pdf'],
      },
    ],
  });

  const opened = await services.programs.open(organizationId, program.id);
  const docTypeIdByKey = new Map(
    opened.docTypes.map((docType) => [docType.key, docType.id]),
  );

  const applications: OdcApplicationWithRelations[] = [];
  for (const seed of ODC_DEMO_APPLICANTS) {
    const applicant = await services.applications.createApplicant(
      organizationId,
      { displayName: seed.displayName, email: seed.email },
    );
    const created = await services.applications.createApplication(
      organizationId,
      opened.id,
      { applicantId: applicant.id },
    );
    await services.applications.updateAnswers(organizationId, created.id, {
      answers: seed.answers,
    });
    for (const document of seed.documents) {
      const documentTypeId = docTypeIdByKey.get(document.documentTypeKey);
      if (!documentTypeId) {
        throw new Error(
          `Demo seed's own program definition is missing docType "${document.documentTypeKey}".`,
        );
      }
      // RC-33 hardening — metadata written directly through the same
      // server-side-only path a real upload uses (never the public,
      // client-facing addDocument() contract), with a canonical
      // {organizationId}/{applicationId}/{documentId}/... key so
      // storageKeyBelongsTo()'s download-time check accepts it exactly
      // like a real upload's key — even though, like before, no actual
      // file backs it in any OdcStorage implementation: a demo download
      // 404s cleanly (see OdcDocumentsService.getFile()) rather than
      // serving fabricated bytes.
      const documentId = randomUUID();
      const storageKey = `${organizationId}/${created.id}/${documentId}/${document.originalName}`;
      await services.applications.addUploadedDocument(
        organizationId,
        created.id,
        {
          id: documentId,
          documentTypeId,
          originalName: document.originalName,
          mimeType: document.mimeType,
          sizeBytes: document.sizeBytes,
          storageKey,
        },
      );
    }
    const submitted = await services.applications.submit(
      organizationId,
      userId,
      created.id,
    );
    applications.push(submitted);
  }

  return { programId: opened.id, applications };
}
