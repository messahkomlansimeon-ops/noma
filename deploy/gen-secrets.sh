#!/bin/zsh
# Génération des secrets de production — À EXÉCUTER SUR LE SERVEUR UNIQUEMENT.
# Les valeurs ne sont JAMAIS affichées, jamais envoyées dans Git ni dans les
# messages : elles sont écrites dans le fichier indiqué (permissions 600,
# jamais committé).
#
# Usage :
#   deploy/gen-secrets.sh [fichier-sortie] [propriétaire]
#   défaut local : deploy/.env.production (utilisateur courant)
#   sur le serveur (chemin lu par systemd, fichier appartenant à
#   l'utilisateur de service — lisible au build, jamais « tous ») :
#     sudo deploy/gen-secrets.sh /opt/noma/shared/.env.production noma
#
# GARANTIES :
#   - le propriétaire est validé AVANT toute modification ;
#   - le contenu est préparé dans un fichier temporaire sécurisé du même
#     répertoire (mv atomique, même système de fichiers) — l'original n'est
#     remplacé QUE si tout a réussi : un échec ne détruit JAMAIS la
#     configuration existante (autres clés, contenu, permissions) ;
#   - la régénération préserve les autres lignes du fichier.
#
# INSTALLATION SÉCURISÉE explicite : le fichier de sortie EST le fichier que
# lit systemd (EnvironmentFile=/opt/noma/shared/.env.production) — un seul
# fichier, jamais copié dans le dépôt. La clé publique Turnstile
# (NEXT_PUBLIC_TURNSTILE_SITE_KEY, non secrète) est ajoutée ensuite PAR
# L'UTILISATEUR DE SERVICE (le fichier lui appartient) et doit être présent
# DANS L'ENVIRONNEMENT AU BUILD (next build l'inline) — voir DEPLOIEMENT.md. Le build se fait
# par `npm run build:production`, qui ne transmet au build QUE les variables NEXT_PUBLIC_* (aucun secret).
set -euo pipefail
# secrets privés DÈS LA CRÉATION du temporaire (aucune fenêtre lisible)
umask 077
cd "$(dirname "$0")/.."

OUT="${1:-deploy/.env.production}"
OWNER="${2:-}"

# root sans propriétaire = fichier root:root 600, illisible pour l'utilisateur
# de build/service → refus par construction (jamais de configuration ilisible)
if [[ "$(id -u)" == "0" && -z "$OWNER" ]]; then
  echo "✖ exécution en root sans propriétaire : le fichier serait root:root 600," >&2
  echo "  illisible pour l'utilisateur de build et de service. Indiquez-le :" >&2
  echo "  → sudo $0 $OUT <utilisateur-service>   (ex. : noma)" >&2
  exit 1
fi

# ── validations AVANT toute modification ─────────────────────────────────────
if [[ -n "$OWNER" ]] && ! id "$OWNER" >/dev/null 2>&1; then
  echo "✖ propriétaire « $OWNER » inexistant — aucun fichier modifié" >&2
  exit 1
fi
mkdir -p "$(dirname "$OUT")"

GEN_IP=$(openssl rand -hex 32)
GEN_PROXY=$(openssl rand -hex 32)

# ── contenu préparé dans un temporaire sécurisé du même répertoire ──────────
# mktemp : création ATOMIQUE et privée (0600), dans le même répertoire que
# la cible (mv atomique, même système de fichiers)
TMPFILE=$(mktemp "$(dirname "$OUT")/.env.production.tmp.XXXXXX")
trap 'rm -f "${TMPFILE:-}"' EXIT

if [[ -f "$OUT" ]]; then
  # régénération : les autres lignes (clés configurées) sont PRÉSERVÉES.
  # codes grep acceptés : 0 (lignes restantes) et 1 (aucune correspondance) ;
  # tout autre code (ex. lecture impossible) interrompt SANS remplacement.
  GREP_RC=0
  grep -vE '^NOMA_(IP|PROXY)_SECRET=' "$OUT" > "$TMPFILE" || GREP_RC=$?
  if [[ $GREP_RC -gt 1 ]]; then
    echo "✖ lecture de l'original impossible (code $GREP_RC) — fichier original inchangé" >&2
    exit 1
  fi
  printf 'NOMA_IP_SECRET=%s\nNOMA_PROXY_SECRET=%s\n' "$GEN_IP" "$GEN_PROXY" >> "$TMPFILE"
  echo "→ secrets régénérés dans ${OUT} (valeurs non affichées, autres lignes préservées)"
else
  cat > "$TMPFILE" <<EOF
# Généré sur ce serveur — NE JAMAIS committer (ignoré par Git).
# Lu par systemd : EnvironmentFile=/opt/noma/shared/.env.production
NOMA_IP_SECRET=${GEN_IP}
NOMA_PROXY_SECRET=${GEN_PROXY}
EOF
  echo "→ secrets créés dans ${OUT} (valeurs non affichées)"
fi
chmod 600 "$TMPFILE"

# propriété transmise au temporaire : si elle échoue, l'original est INTACT
if [[ -n "$OWNER" ]] && ! chown "$OWNER" "$TMPFILE" 2>/dev/null; then
  echo "✖ impossible de transmettre la propriété à « $OWNER » — fichier original inchangé" >&2
  exit 1
fi

# ── remplacement ATOMIQUE, uniquement après succès complet ───────────────────
mv "$TMPFILE" "$OUT"

# vérifications sans révéler les valeurs
if [[ "$OUT" == deploy/.env.production ]] && ! git check-ignore -q "$OUT"; then
  echo "✖ ${OUT} N'EST PAS ignoré par Git — corriger .gitignore avant de continuer" >&2
  exit 1
fi
PERMS=$(stat -c %a "$OUT")
if [[ "$PERMS" == "600" ]]; then
  echo "✔ permissions ${PERMS}"
else
  echo "✖ permissions ${PERMS} ≠ 600" >&2
  exit 1
fi
echo "→ rappel : le proxy doit transmettre x-noma-proxy-secret = NOMA_PROXY_SECRET"
echo "→ rappel : NEXT_PUBLIC_TURNSTILE_SITE_KEY doit être présent dans l'environnement AU BUILD"
