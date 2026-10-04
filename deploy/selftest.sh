#!/bin/zsh
# Tests NÉGATIFS et nominaux des scripts de déploiement — HORS LIGNE.
# À rejouer après toute modification de deploy/ ET sur le serveur avant
# l'installation. Aucune base réelle n'est touchée : tout se passe dans un
# répertoire temporaire. Échec du script = code de sortie non nul.
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
ok()    { echo "  ✔ $1"; PASS=$(( PASS + 1 )); return 0; }
ko()    { echo "  ✖ $1"; FAIL=$(( FAIL + 1 )); return 0; }
section() { echo "▶ $1"; }

TMP=$(mktemp -d /tmp/noma-selftest-XXXXXX)
trap 'rm -rf "$TMP"' EXIT

# helper SQLite (fichier séparé : aucun conflit de guillemets zsh/JS)
cat > "$TMP/setup.cjs" <<'EOF'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2]);
if (process.argv[3] === "drop") {
  for (const t of ["reservations", "ledger", "attempts", "active_searches"]) {
    db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
} else {
  db.exec(`CREATE TABLE reservations (search_id TEXT, amount_micros INTEGER, day TEXT, created_at TEXT, resolved_at TEXT, spent_micros INTEGER);
CREATE TABLE ledger (search_id TEXT, kind TEXT, amount_micros INTEGER, day TEXT, ts TEXT);
CREATE TABLE attempts (scope TEXT, window_key TEXT, count INTEGER);
CREATE TABLE active_searches (session_id TEXT, search_id TEXT, ip_hash TEXT, started_at INTEGER);
INSERT INTO reservations (search_id, amount_micros, day, created_at) VALUES ('s-selftest', 50000, '2026-10-02', datetime('now'));`);
}
db.close();
EOF

# base nominale minimale (4 tables de protection) ; mode « drop » = base valide sans tables
makeNominalDb() {
  node "$TMP/setup.cjs" "$1" create 2>/dev/null
}
makeEmptySchemaDb() {
  node "$TMP/setup.cjs" "$1" create >/dev/null 2>&1
  node "$TMP/setup.cjs" "$1" drop >/dev/null 2>&1
}

# ─── 1. noma.service — jamais de port public ─────────────────────────────────
section "noma.service (statique)"
if grep -q '^ExecStart=.*-- --hostname 127\.0\.0\.1' deploy/noma.service; then
  ok "ExecStart force l'écoute sur 127.0.0.1"
else
  ko "ExecStart sans --hostname 127.0.0.1"
fi
if grep -q '^ExecStart=.*npm run start$' deploy/noma.service; then
  ko "un ExecStart lance encore « npm run start » sans hostname"
else
  ok "aucun ExecStart sans --hostname"
fi
if grep -q '^EnvironmentFile=/opt/noma/shared/.env.production' deploy/noma.service; then
  ok "EnvironmentFile = fichier unique installé par gen-secrets.sh"
else
  ko "EnvironmentFile incohérent avec gen-secrets.sh"
fi

# ─── 2. backup.sh — jamais de sauvegarde vide déclarée valide ────────────────
section "backup.sh (négatifs + nominal)"
NOMA_DB_PATH="$TMP/absente.sqlite" ./deploy/backup.sh "$TMP/b1" >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "source inexistante → exit 1" || ko "source inexistante : mauvais code de sortie"
[[ -z "$(ls "$TMP/b1" 2>/dev/null)" ]] && ok "source inexistante → aucun fichier créé" || ko "des fichiers de sortie ont été créés"

printf 'ceci n est pas une base sqlite' > "$TMP/fausse.sqlite"
NOMA_DB_PATH="$TMP/fausse.sqlite" ./deploy/backup.sh "$TMP/b2" >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "source non-SQLite → exit 1" || ko "source non-SQLite : mauvais code de sortie"

makeEmptySchemaDb "$TMP/sans-tables.sqlite"
NOMA_DB_PATH="$TMP/sans-tables.sqlite" ./deploy/backup.sh "$TMP/b3" >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "SQLite valide sans tables attendues → exit 1" || ko "SQLite sans tables : mauvais code de sortie"
[[ -z "$(ls "$TMP/b3" 2>/dev/null)" ]] && ok "sortie invalidée supprimée" || ko "la sortie invalide n'a pas été supprimée"

makeNominalDb "$TMP/nominale.sqlite"
NOMA_DB_PATH="$TMP/nominale.sqlite" ./deploy/backup.sh "$TMP/b4" >/dev/null 2>&1
[[ $? -eq 0 ]] && ok "cas nominal → exit 0" || ko "cas nominal en échec"
BACKUP=$(ls "$TMP/b4"/*.sqlite 2>/dev/null | head -1)
[[ -n "$BACKUP" ]] && ok "fichier de sauvegarde produit" || ko "aucun fichier de sauvegarde"

# ─── 3. restore-check.sh — jamais une sauvegarde incomplète acceptée ────────
section "restore-check.sh (négatifs + nominal)"
./deploy/restore-check.sh "$TMP/inexistante.sqlite" >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "fichier inexistant → exit 1" || ko "fichier inexistant : mauvais code de sortie"
./deploy/restore-check.sh "$TMP/fausse.sqlite" >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "fichier non-SQLite → exit 1" || ko "fichier non-SQLite : mauvais code de sortie"
./deploy/restore-check.sh "$TMP/sans-tables.sqlite" >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "SQLite sans tables de protection → exit 1" || ko "SQLite sans tables : mauvais code de sortie"
./deploy/restore-check.sh "$BACKUP" >/dev/null 2>&1
[[ $? -eq 0 ]] && ok "cas nominal → exit 0 (intégrité + 4 tables)" || ko "cas nominal en échec"

# ─── 4. gen-secrets.sh — jamais de secrets dans Git, permissions 600 ────────
section "gen-secrets.sh (négatifs + nominaux)"
# 4a. sortie dans un dépôt Git SANS .gitignore → exit 1 (garde anti-commit)
rm -rf "$TMP/repo-sans-ignore"; mkdir -p "$TMP/repo-sans-ignore/deploy"
cp deploy/gen-secrets.sh "$TMP/repo-sans-ignore/deploy/"
(cd "$TMP/repo-sans-ignore" && git init -q . && ./deploy/gen-secrets.sh >/dev/null 2>&1)
[[ $? -eq 1 ]] && ok "fichier non ignoré par Git → exit 1" || ko "garde anti-commit non déclenché"
# 4b. même dépôt AVEC .gitignore → exit 0
cp .gitignore "$TMP/repo-sans-ignore/"
(cd "$TMP/repo-sans-ignore" && ./deploy/gen-secrets.sh >/dev/null 2>&1)
[[ $? -eq 0 ]] && ok "avec .gitignore → exit 0" || ko "cas nominal avec .gitignore en échec"
# 4c. installation refusée sur une cible non inscriptible → exit 1
#     (scénario racine : /proc — non inscriptible MÊME pour root)
./deploy/gen-secrets.sh /proc/self/noma-selftest/.env.production >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "cible non inscriptible (/proc, y compris root) → exit 1" || ko "cible /proc acceptée"
if [[ "$(id -u)" != "0" ]]; then
  # scénario complémentaire sans privilèges : répertoire chmod 500
  mkdir -p "$TMP/ro" && chmod 500 "$TMP/ro"
  ./deploy/gen-secrets.sh "$TMP/ro/.env.production" >/dev/null 2>&1
  [[ $? -eq 1 ]] && ok "répertoire chmod 500 (mode non root) → exit 1" || ko "répertoire non inscriptible accepté"
  chmod 700 "$TMP/ro" 2>/dev/null
else
  ok "répertoire chmod 500 : scénario sauté (root ignore les permissions)"
fi
# 4d. refus explicite : root sans propriétaire (fichier serait illisible au build)
if grep -q 'id -u' deploy/gen-secrets.sh && grep -q 'utilisateur-service' deploy/gen-secrets.sh; then
  ok "garde « root sans propriétaire » présent dans gen-secrets.sh"
else
  ko "garde « root sans propriétaire » absent"
fi
# 4d-2. garde « root sans propriétaire » ACTIF : id simulé (uid 0) → exit 1
mkdir -p "$TMP/fakebin"
printf '#!/bin/zsh\necho 0\n' > "$TMP/fakebin/id"
chmod +x "$TMP/fakebin/id"
PATH="$TMP/fakebin:$PATH" ./deploy/gen-secrets.sh "$TMP/root-sans-owner/.env.production" > "$TMP/root-guard-sortie.txt" 2>&1
if [[ $? -eq 1 ]] && grep -q "utilisateur-service" "$TMP/root-guard-sortie.txt"; then
  ok "garde « root sans propriétaire » DÉCLENCHÉ (id simulé uid 0) → exit 1 + message"
else
  ko "garde « root sans propriétaire » non déclenché avec uid 0 simulé"
fi
# 4e. P1 : régénération avec propriétaire inexistant sur un fichier EXISTANT
#     → exit 1 ET fichier original, contenu et permissions INCHANGÉS
mkdir -p "$TMP/owner-existant"
./deploy/gen-secrets.sh "$TMP/owner-existant/.env.production" >/dev/null 2>&1
echo "NOMA_AUTRE_CLE=à-préserver" >> "$TMP/owner-existant/.env.production"
AVANT=$(md5sum "$TMP/owner-existant/.env.production" | cut -d' ' -f1)
AVANT_PERMS=$(stat -c %a "$TMP/owner-existant/.env.production")
./deploy/gen-secrets.sh "$TMP/owner-existant/.env.production" utilisateur-inexistant-selftest >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "régénération avec propriétaire inexistant → exit 1" || ko "propriétaire inexistant accepté"
APRES=$(md5sum "$TMP/owner-existant/.env.production" | cut -d' ' -f1)
APRES_PERMS=$(stat -c %a "$TMP/owner-existant/.env.production")
[[ "$AVANT" == "$APRES" && "$AVANT_PERMS" == "$APRES_PERMS" ]] \
  && ok "échec de régénération : contenu et permissions de l'original INCHANGÉS" \
  || ko "l'original a été modifié/détruit lors de l'échec !"
[[ -z "$(ls -A "$TMP/owner-existant" | grep -v '.env.production')" ]] \
  && ok "aucun fichier temporaire résiduel" || ko "fichier temporaire résiduel"
# 4f. régénération réussie : les AUTRES clés configurées sont PRÉSERVÉES
./deploy/gen-secrets.sh "$TMP/owner-existant/.env.production" >/dev/null 2>&1
[[ $? -eq 0 ]] && ok "régénération nominale → exit 0" || ko "régénération nominale en échec"
grep -q '^NOMA_AUTRE_CLE=à-préserver$' "$TMP/owner-existant/.env.production" \
  && ok "les autres clés configurées sont préservées" \
  || ko "les autres clés ont été perdues à la régénération !"
[[ $(grep -c '^NOMA_.*_SECRET=' "$TMP/owner-existant/.env.production") == "2" ]] \
  && ok "exactement 2 secrets après régénération (pas de doublon)" \
  || ko "secrets dupliqués ou manquants"
# 4f-2. (mode non root) échec de propriété au remplacement : original intact
if [[ "$(id -u)" != "0" ]]; then
  AVANT=$(md5sum "$TMP/owner-existant/.env.production" | cut -d' ' -f1)
  ./deploy/gen-secrets.sh "$TMP/owner-existant/.env.production" nobody >/dev/null 2>&1
  [[ $? -eq 1 ]] && ok "chown impossible vers autre utilisateur → exit 1" || ko "chown impossible accepté"
  [[ "$AVANT" == "$(md5sum "$TMP/owner-existant/.env.production" | cut -d' ' -f1)" ]] \
    && ok "chown en échec : original inchangé (temporaire seul nettoyé)" \
    || ko "original modifié alors que le chown a échoué !"
else
  ok "chown vers autre utilisateur : scénario sauté (root réussirait)"
fi
# 4f-3. P1 : lecture IMPOSSIBLE de l'original → exit 1, original inchangé
if [[ "$(id -u)" != "0" ]]; then
  AVANT=$(md5sum "$TMP/owner-existant/.env.production" | cut -d' ' -f1)
  chmod 000 "$TMP/owner-existant/.env.production"
  ./deploy/gen-secrets.sh "$TMP/owner-existant/.env.production" >/dev/null 2>&1
  [[ $? -eq 1 ]] && ok "lecture impossible (fichier 000) → exit 1" || ko "lecture impossible acceptée (clés perdues) !"
  chmod 600 "$TMP/owner-existant/.env.production"
  [[ "$AVANT" == "$(md5sum "$TMP/owner-existant/.env.production" | cut -d' ' -f1)" ]] \
    && ok "lecture impossible : original inchangé (contenu et permissions)" \
    || ko "original remplacé malgré l'erreur de lecture !"
else
  ok "lecture impossible : scénario sauté (root lit tout)"
fi
# 4f-4. P2 : temporaire privé dès sa création — umask 077 + mktemp présents
if grep -q '^umask 077' deploy/gen-secrets.sh && grep -q 'mktemp' deploy/gen-secrets.sh; then
  ok "temporaire privé dès la création (umask 077 + mktemp dans le script)"
else
  ko "umask 077 / mktemp absent : secrets exposés pendant l'écriture"
fi
#      vérification dynamique : même sous umask permissif (000), le fichier
#      final reste privé (600) et sans résidu lisible
(umask 000 && ./deploy/gen-secrets.sh "$TMP/umask-permissif/.env.production" >/dev/null 2>&1)
[[ $? -eq 0 ]] && ok "création sous umask 000 → exit 0" || ko "création sous umask 000 en échec"
[[ $(stat -c %a "$TMP/umask-permissif/.env.production") == "600" ]] \
  && ok "sous umask 000 : fichier final privé (600)" \
  || ko "umask 000 a produit un fichier trop permissif"
[[ -z "$(ls -A "$TMP/umask-permissif" | grep -v '.env.production')" ]] \
  && ok "aucun temporaire résiduel sous umask 000" || ko "temporaire résiduel (potentiellement lisible)"
# 4g. propriétaire = utilisateur courant (transmission valide) → exit 0
./deploy/gen-secrets.sh "$TMP/owner-ok/.env.production" "$(id -un)" >/dev/null 2>&1
[[ $? -eq 0 ]] && ok "propriétaire = utilisateur courant → exit 0" || ko "transmission de propriété à soi-même en échec"
# 4g. chemin paramétrable (celui lu par systemd) → 600, 2 secrets, rien affiché
OUT=$TMP/shared/.env.production
./deploy/gen-secrets.sh "$OUT" >/dev/null 2>&1 && ./deploy/gen-secrets.sh "$OUT" >/dev/null 2>&1
[[ $? -eq 0 ]] && ok "création + régénération sur chemin paramétrable" || ko "chemin paramétrable en échec"
[[ $(stat -c %a "$OUT") == "600" ]] && ok "permissions 600" || ko "permissions ≠ 600"
[[ $(grep -c "^NOMA_.*_SECRET=" "$OUT") == "2" ]] && ok "exactement 2 secrets (régénération sans dupliquer)" || ko "contenu inattendu"
# 4h. les valeurs ne sont jamais affichées sur la sortie standard
./deploy/gen-secrets.sh "$OUT" > "$TMP/sortie.txt" 2>&1
if grep -qE "^NOMA_(IP|PROXY)_SECRET=[0-9a-f]{64}" "$TMP/sortie.txt"; then
  ko "des valeurs de secrets ont fuité dans la sortie"
else
  ok "aucune valeur de secret dans la sortie du script"
fi

# ─── bilan ───────────────────────────────────────────────────────────────────
echo ""
if [[ $FAIL -eq 0 ]]; then
  echo "✔ $PASS vérifications passées, 0 échec"
  exit 0
else
  echo "✖ $FAIL échec(s) sur $((PASS + FAIL)) vérifications"
  exit 1
fi
