# Signalements et dossiers de modération (lot FIN3-C2)

Un acheteur ou un vendeur peut **signaler** une annonce ou une commande. L'équipe noma traite le signalement dans **`/admin/dossiers`** et le clôt par une décision motivée. Migration **0030** (`reports`). Contrat `reports/v1`.

## Écrire un signalement

- **Où** : « Signaler cette annonce » au bas de la fiche d'une annonce (`/besoins/[id]/offres/[offerId]`), « Signaler cette commande » au bas d'une commande, puis le formulaire `/signaler?besoin=…&annonce=…` ou `/signaler?commande=…`. « Mes signalements » (menu du compte) est `/signaler` sans paramètre.
- **Accès à la cible** (sinon **404 indiscernable**) :
  - une annonce : celle qui est parmi les correspondances confirmées du besoin de l'auteur (même prédicat que la fiche, la messagerie et les favoris : `readOfferAccess`) ; une annonce retirée ou vendue depuis reste signalable (l'acheteur la connaissait) ;
  - une commande : seulement ses deux parties. Le compte signalé est **l'autre partie** ; pour une annonce, c'est son vendeur. Il est figé à l'écriture.
- **Un seul dossier ouvert par auteur et par cible** (409 `already_reported`) ; un nouveau est possible une fois le précédent clos. **10 signalements par jour UTC** au plus (429 `reports_daily_limit`), exacts sous concurrence (verrou consultatif par auteur).
- **Motifs** : arnaque ou fraude, annonce ou article indisponible, informations fausses ou trompeuses, comportement abusif, autre. Texte facultatif de 500 caractères : **aucun numéro de téléphone** (400 `phone_number_in_report`, même règle que les missions), aucun caractère de contrôle ou invisible. Le contrôle est identique côté écran et côté serveur (`lib/reports-rules.ts`).
- **L'auteur ne voit que « En cours d'examen » ou « Traité »** : jamais la décision, jamais le motif de l'administrateur. La personne signalée n'est pas informée.

## Traiter un dossier (administrateur)

- `/admin/dossiers` : onglets « À traiter » (du plus ancien) et « Clos » (du plus récent). Numéros **masqués** (premier signe, points, deux derniers chiffres), jamais d'identifiant. Un compte visé par plusieurs dossiers ouverts est signalé en tête de ligne.
- `/admin/dossiers/[id]` : les **faits** tels que la base les donne (statut et prix de l'annonce ou de la commande, statut du compte signalé, nombre de dossiers le visant), le texte de l'auteur, puis la décision.
- **La « synthèse IA » de la maquette n'existe pas** : l'écran le dit (« Synthèse automatique : non disponible »). Rien n'est simulé.
- **Deux décisions**, avec un **motif obligatoire** (500 caractères, sans numéro), confirmées à l'écran :
  - **classé sans suite** : le dossier est clos, rien ne change pour le compte ;
  - **compte suspendu** : le chemin existant de la suspension (`applyUserStatusInTransaction` : verrou du compte, refus d'un compte administrateur ou archivé, `updateUser`, journal `admin_actions` « qui, quoi, quand ») est exécuté **dans la même transaction** que la clôture. Si la suspension est refusée (409 `target_protected` ou `target_archived`), **tout est annulé** et le dossier reste ouvert : on peut alors le classer sans suite.
- Un dossier clos ne se rouvre pas (409 `report_closed`).
- Les routes sont `/api/admin/reports`, `/api/admin/reports/[id]`, `/api/admin/reports/[id]/decision` : même garde que le reste de l'administration (origine vérifiée avant la session, 404 identique pour un visiteur, un compte ordinaire ou un administrateur suspendu).

## Garanties en base

La table refuse : de se signaler soi-même, une cible incohérente (annonce sans besoin, commande avec annonce…), une clôture sans décision, motif et auteur, la modification des éléments d'un signalement (auteur, cible, motif, texte, date), la modification d'un dossier clos, la suppression (déclencheur `reports_guard`).

## Ce qui n'existe pas (volontairement)

Pas de notification à l'auteur à la clôture ; pas de signalement d'un compte ou d'une conversation (seulement une annonce ou une commande) ; pas de pièce jointe ; pas de synthèse automatique.

## Code

`database/migrations/0030_reports_moderation.sql` · `lib/reports-rules.ts` (règles partagées) · `lib/server/reports/{reports,http}.ts` · `lib/server/admin/http.ts` (routes d'administration) · `lib/client/reports-{api,view}.ts` · pages `app/(buyer)/signaler`, `app/(admin)/admin/dossiers` · tests `tests/postgres/reports.integration.test.ts` (`npm run test:reports`) et `tests/client/reports.test.ts`.
