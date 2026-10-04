#!/bin/zsh
# Sauvegarde SQLite COHÉRENTE — sans arrêter l'application.
# VACUUM INTO produit un instantané cohérent (transaction atomique), y compris
# avec la base ouverte en WAL par l'application.
# GARDE-FOUS : la source doit exister, la sauvegarde doit contenir les tables
# attendues et passer integrity_check — sinon échec (jamais une sauvegarde
# « vide mais réussie »).
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${NOMA_DB_PATH:-./data/noma-guard.sqlite}"
OUT_DIR="${1:-./backups}"

# ── garde-fou 1 : la source existe (DatabaseSync créerait sinon une base vide)
if [[ ! -f "$DB" ]]; then
  echo "✖ source inexistante : $DB (NOMA_DB_PATH correct ?)" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$OUT_DIR/noma-guard-$STAMP.sqlite"

node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: false });
const lit = "'"'"'" + process.argv[2].replace(/'"'"'/g, "'"'"''"'"'") + "'"'"'";
db.exec(`VACUUM INTO ${lit}`);
db.close();
' "$DB" "$OUT" 2>/dev/null || { echo "✖ base source illisible (fichier corrompu ou non SQLite ?) : $DB" >&2; exit 1; }

# ── garde-fous 2 & 3 : tables attendues présentes + intégrité valide
# à la moindre anomalie : fichier de sortie SUPPRIMÉ, exit 1.
EXPECTED_TABLES="active_searches,attempts,ledger,reservations"
RESULT=$(node -e '
const { DatabaseSync } = require("node:sqlite");
const expected = process.argv[2].split(",");
const db = new DatabaseSync(process.argv[1]);
const row = db.prepare("PRAGMA integrity_check").get();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = ?")
  .all("table").map((r) => r.name);
const missing = expected.filter((t) => !tables.includes(t));
db.close();
if (row.integrity_check !== "ok") { console.log(`integrity:${row.integrity_check}`); process.exit(0); }
if (missing.length > 0) { console.log(`missing:${missing.join(",")}`); process.exit(0); }
console.log("ok");
' "$OUT" "$EXPECTED_TABLES")

if [[ "$RESULT" != "ok" ]]; then
  rm -f "$OUT"
  echo "✖ sauvegarde INVALIDE ($RESULT) — fichier supprimé : $OUT" >&2
  exit 1
fi

echo "✔ sauvegarde cohérente : $OUT (tables $EXPECTED_TABLES, intégrité ok)"