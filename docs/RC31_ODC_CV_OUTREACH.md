# RC31 — Tri CV, sélection, emails un par un

Le programme ODC trie les dossiers (score figé d’abord, incomplets en bas), le staff **coche** ceux qu’il retient, puis envoie **un email à la fois** (humain obligatoire). Le statut de candidature (`accepted` / `rejected`) ne change pas.

## Règles
- Destinataire = `OdcApplicant.email` résolu serveur. Jamais `to` dans le body HTTP.
- Email masqué en API (`a***@domain`).
- Template allowlisté `odc_candidate_invite` uniquement.
- Envoi strictement séquentiel : on ne peut envoyer que le prochain `queued`/`failed`.
- `skip` passe au suivant sans envoyer.
- SMTP down → `failed`, pas de décision auto.

## API
| Méthode | Route | Effet |
|---------|--------|--------|
| GET | `/odc/programs/:id/applications` | Liste **classée par score** |
| GET | `/odc/programs/:id/outreach` | File d’envoi |
| POST | `/odc/programs/:id/outreach` | `{ applicationIds }` dans l’ordre |
| POST | `/odc/outreach/:id/send` | Envoie le prochain |
| POST | `/odc/outreach/:id/skip` | Ignore le prochain |

Éligibles à la file : `in_review`, `waitlisted`, email présent.
