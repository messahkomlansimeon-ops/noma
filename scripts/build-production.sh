#!/usr/bin/env bash
# build:production : build de PRODUCTION sans aucun secret (lot SMS1-bis, C3). Usage : npm run build:production  (ou : scripts/build-production.sh)
#
# Pourquoi. Turbopack garde dans .next/cache/turbopack/*.sst (droits 0644 par défaut) les variables d'environnement lues pendant le build. Un build lancé après
# `set -a; . /opt/noma/shared/.env.production; set +a` y déposait NOMA_SMS_API_KEY (la clé Meno : de l'argent réel) et NOMA_AUTH_SECRET EN CLAIR, lisibles par tout compte du serveur.
# Aucun de ces secrets n'a de raison d'être connu du build : ils sont lus par le serveur à l'EXÉCUTION (process.env, jamais inlinés ; seules les variables NEXT_PUBLIC_* sont inlinées
# dans le navigateur, et elles sont publiques par nature, comme la clé publique Turnstile).
#
# Ce que fait ce script :
#  1. umask 077, puis chmod go-rwx de .next à la fin (l'outil de build crée certains fichiers en 0664 malgré l'umask) : tout ce que le build produit est privé ;
#  2. le build s'exécute dans un environnement VIDÉ (`env -i`) où ne passent que : le strict nécessaire (PATH, HOME, langue, dossier temporaire, proxys, certificats),
#     et les variables NEXT_PUBLIC_* (valeurs publiques à inliner). NOMA_SMS_API_KEY, NOMA_AUTH_SECRET, NOMA_IP_SECRET, NOMA_PROXY_SECRET, NOMA_TURNSTILE_SECRET, DATABASE_URL, etc. ne
#     sont JAMAIS transmis, même si l'appelant les a exportées ;
#  3. le cache du build (.next/cache) est supprimé après le build ;
#  4. contrôle final : si l'appelant avait exporté des valeurs secrètes, aucune ne doit se retrouver dans .next ; sinon le build est EFFACÉ et le script échoue (code 1). Les valeurs
#     ne sont jamais affichées.
# Option de test : `scripts/build-production.sh -- <commande…>` remplace `npx next build` (les mêmes garanties s'appliquent).
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ "${1:-}" = "--" ]; then
  shift
  [ $# -ge 1 ] || { echo "build:production : commande manquante après --" >&2; exit 2; }
  BUILD_COMMAND=("$@")
else
  [ $# -eq 0 ] || { echo "build:production : usage : scripts/build-production.sh [-- commande…]" >&2; exit 2; }
  BUILD_COMMAND=(npx next build)
fi

# Variables transmises au build (liste blanche). Rien d'autre : un nouveau secret ajouté plus tard au fichier d'environnement ne peut pas fuiter par omission.
ALLOWED=(PATH HOME USER LOGNAME SHELL LANG LC_ALL LC_CTYPE TZ TMPDIR TEMP TMP
  HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY http_proxy https_proxy no_proxy all_proxy
  SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS NODE_OPTIONS XDG_CACHE_HOME XDG_CONFIG_HOME CI)
PASS=()
for name in "${ALLOWED[@]}"; do
  if [ -n "${!name+x}" ]; then PASS+=("$name=${!name}"); fi
done
while IFS= read -r name; do
  [ -n "$name" ] && PASS+=("$name=${!name}")
done < <(compgen -e | grep -E '^NEXT_PUBLIC_[A-Za-z0-9_]+$' || true)

# Valeurs secrètes de l'appelant, pour le contrôle final seulement (jamais affichées, jamais transmises au build) : les variables connues et toute variable exportée dont le nom évoque
# un secret (SECRET, KEY, TOKEN, PASSWORD, PASSWD, CREDENTIAL), hors NEXT_PUBLIC_* (publiques par nature). Les valeurs de moins de 8 caractères ou sur plusieurs lignes sont ignorées.
SECRET_NAMES=(NOMA_SMS_API_KEY NOMA_AUTH_SECRET NOMA_IP_SECRET NOMA_PROXY_SECRET NOMA_AUTH_PROXY_SECRET NOMA_TURNSTILE_SECRET NOMA_FAKE_PAYMENT_SECRET DATABASE_URL OPENROUTER_API_KEY GOOGLE_API_KEY)
while IFS= read -r name; do
  [ -n "$name" ] && SECRET_NAMES+=("$name")
done < <(compgen -e | grep -E 'SECRET|KEY|TOKEN|PASSWORD|PASSWD|CREDENTIAL' | grep -vE '^NEXT_PUBLIC_' || true)
PATTERNS="$(mktemp)"
trap 'rm -f "$PATTERNS"' EXIT
checked=0
for name in "${SECRET_NAMES[@]}"; do
  value="${!name-}"
  case "$value" in *$'\n'*) continue ;; esac
  if [ "${#value}" -ge 8 ]; then
    printf '%s\n' "$value" >> "$PATTERNS"
    checked=$((checked + 1))
  fi
done

echo "build:production : build sans secret (environnement vidé, umask 077)…" >&2
set +e
env -i "${PASS[@]}" NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production "${BUILD_COMMAND[@]}"
status=$?
set -e
if [ "$status" -ne 0 ]; then
  echo "build:production : le build a échoué (code $status)." >&2
  rm -rf .next/cache
  exit "$status"
fi

# Le cache du build n'a rien à faire sur le serveur (et c'est lui qui retenait les variables d'environnement).
rm -rf .next/cache

# Tout ce que le build a produit est rendu PRIVÉ (propriétaire seul), même ce que l'outil de build crée avec ses propres droits (constaté : des fichiers en 0664 malgré `umask 077`).
# Le serveur Node tourne sous le même compte et lit .next ; nginx n'y accède jamais.
if [ -d .next ]; then chmod -R u+rwX,go-rwx .next; fi

if [ "$checked" -gt 0 ] && [ -d .next ]; then
  if grep -rlF -f "$PATTERNS" .next > /dev/null 2>&1; then
    echo "build:production : ÉCHEC : une valeur secrète de l'environnement figure dans .next ; le build est effacé." >&2
    rm -rf .next
    exit 1
  fi
fi
echo "build:production : terminé. Aucun secret transmis au build ($checked valeur(s) secrète(s) de l'appelant vérifiée(s) absente(s) de .next) ; .next/cache supprimé." >&2
