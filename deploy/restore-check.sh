#!/bin/zsh
# Test de restauration — restaure la dernière sauvegarde sur une COPIE
# (jamais sur la base réelle) et vérifie intégrité + présence des tables
# attendues + compte des lignes. Une sauvegarde sans les tables de protection
# est REJETÉE (jamais déclarée valide).
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP="${1:?usage : deploy/restore-check.sh <fichier-sauvegarde.sqlite>}"
RESTORED="/tmp/noma-restore-check-$(date +%s).sqlite"

if [[ ! -f "$BACKUP" ]]; then
  echo "✖ sauvegarde inexistante : $BACKUP" >&2
  exit 1
fi

cp "$BACKUP" "$RESTORED"
chmod 600 "$RESTORED"

if ! node -e '
const { DatabaseSync } = require("node:sqlite");
const path = process.argv[1];
const expected = ["active_searches", "attempts", "ledger", "reservations"];
const db = new DatabaseSync(path);
const row = db.prepare("PRAGMA integrity_check").get();
if (row.integrity_check !== "ok") {
  console.error(`✖ intégrité : ${row.integrity_check}`);
  db.close();
  process.exit(1);
}
const counts = {};
let missing = [];
for (const table of expected) {
  try {
    counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  } catch {
    missing.push(table);
  }
}
db.close();
if (missing.length > 0) {
  console.error(`✖ tables absentes de la sauvegarde : ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`✔ intégrité ok, tables de protection présentes — ${path}`);
console.log(`  lignes : ${JSON.stringify(counts)}`);
' "$RESTORED" 2>/dev/null; then
  echo "✖ restauration INVALIDE : $BACKUP (fichier illisible, corrompu ou sans les tables de protection)" >&2
  rm -f "$RESTORED"
  exit 1
fi

echo "✔ restauration testée sur la copie $RESTORED (base réelle intacte)"
echo "  → pour restaurer réellement : arrêter l'app, remplacer NOMA_DB_PATH par la sauvegarde, relancer"
