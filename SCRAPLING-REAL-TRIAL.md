# Essai réel limité — Pilote Scrapling sur CoinAfrique

Date : 3 octobre 2026  
Statut : **Essai réalisé — Verdict : NO-GO (différence de données) ; Cheerio reste actif en production**

---

## 1. Cadre et Respect des Contraintes

L'essai réel limité a été réalisé conformément aux directives et contraintes impératives :
- **3 téléchargements exactement** : le plafond strict de 3 requêtes HTTP a été appliqué via `createDownloadLimiter` ; aucun dépassement ni requête additionnelle.
- **Téléchargement unique et partagé** : chaque page a été téléchargée une seule fois via `safeFetch` avec ses délais et limites d'octets.
- **Même HTML en mémoire** : le même corps HTML a été fourni successivement à Cheerio puis à Scrapling (aucun enregistrement persistant du HTML brut).
- **Zéro réseau depuis Python** : `networkAttempts = 0` validé sur les 3 exécutions (sockets neutralisés par `_OfflineSocket`).
- **Aucune dépense externe** : aucun appel IA, aucun navigateur Playwright, aucun proxy n'a été utilisé.
- **Aucun contournement de blocage** : les 3 requêtes ont retourné un statut HTTP 200 normal (aucun 403, 429 ou CAPTCHA).
- **Maintien de Cheerio en production** : le connecteur actif `poc/sources/coinafrique.ts` n'a pas été modifié.

---

## 2. Mesures par Page

| Cas | URL | HTTP | Taille | Annonces Cheerio | Annonces Scrapling | Durée Cheerio | Durée Scrapling | Surcoût | RSS Python | networkAttempts | Différences |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **1. Recherche normale** | `keyword=iphone` | 200 | 559 Ko | 84 | 84 | 134,9 ms | 173,6 ms | +38,7 ms | 37,9 Mo | 0 | 6 divergences |
| **2. Autre catégorie** | `keyword=climatiseur` | 200 | 592 Ko | 84 | 84 | 95,9 ms | 196,6 ms | +100,8 ms | 38,1 Mo | 0 | 29 divergences |
| **3. Recherche rare / vide** | `keyword=introuvable999xyztest` | 200 | 417 Ko | 0 | 0 | 50,1 ms | 141,8 ms | +91,7 ms | 36,0 Mo | 0 | 0 divergence |

---

## 3. Analyse Détaillée Champ par Champ

Sur les 168 annonces extraites au total :
- **Comptage des annonces** : Parité 100 % (84 vs 84, 84 vs 84, 0 vs 0). Zéro annonce manquante, zéro annonce supplémentaire, zéro faux positif.
- **Identifiants & Liens** : 100 % identiques (`id`, `url`).
- **Données financières** : 100 % identiques (`price`, `currency`).
- **Localisation & Médias** : 100 % identiques (`zone`, `photo`, `vendor`).
- **Dates & Descriptions** : 100 % identiques (`date`, `description` avec prise en compte du texte descendant et des balises imbriquées).
- **Erreurs de parsing** : 0 erreur signalée de part et d'autre.

### Origine des divergences (35 au total)
Toutes les 35 divergences constatées concernent exclusivement le champ **`title`** et proviennent d'un traitement d'espaces blancs terminaux :
- Dans le parseur Cheerio de production (`coinafrique-parser.ts`), le titre est lu directement depuis l'attribut sans normalisation :
  `$card.find(".card-fav").attr("data-ad-title") ?? link.attr("title") ?? null;`
- Dans le parseur Python Scrapling (`parse_coinafrique.py`), un `.strip()` est appliqué systématiquement :
  `str(favorite.attrib.get("data-ad-title", "")).strip() or None`
- Sur CoinAfrique, certains titres comportent des espaces ou retours à la ligne finaux (`\n\n`) dans leur balise `data-ad-title` :
  - Ex. iPhone index 3 : Cheerio=`"Iphone 17 pro max 512 giga "` vs Scrapling=`"Iphone 17 pro max 512 giga"`
  - Ex. Climatiseur index 60 : Cheerio=`"Climatiseur Samsung Réversible (Froid/Chaud) - Excellent État\n\n"` vs Scrapling=`"Climatiseur Samsung Réversible (Froid/Chaud) - Excellent État"`

Bien que le comportement de Scrapling soit sémantiquement plus propre, il crée une différence de données par rapport à la sortie brute de Cheerio.

---

## 4. Budgets et Performances

- **Surcoût maximal mesuré** : **100,8 ms** (budget maximal : 500 ms) — ✅ Respecté
- **Consommation mémoire maximale (RSS)** : **38,1 Mo** (budget maximal : 128 Mio) — ✅ Respecté
- **Tentatives réseau Python** : **0** — ✅ Respecté
- **Stabilité de la page vide** : 0 annonce, 0 erreur, aucune hallucination — ✅ Respecté

---

## 5. Verdict et Conclusion

### Verdict : **NO-GO**
- **Motif** : Condition d'arrêt stricte d'égalité des données non satisfaite (`exactParity = false` sur les titres contenant des blancs ou sauts de ligne non strippés par Cheerio).
- **Décision d'exploitation** : **Cheerio reste le parseur exclusif et actif en production.** Aucun remplacement automatique n'a été effectué.
- **Trace d'exécution** : Le rapport structuré complet est conservé dans [`poc/results/scrapling-real-trial/benchmark.json`](poc/results/scrapling-real-trial/benchmark.json).

---

## 6. Remédiation locale après l'essai

Le parseur Cheerio normalise désormais les blancs autour de `data-ad-title` et
se replie sur le titre du lien lorsque cet attribut est vide après normalisation.
Des tests de non-régression couvrent les retours à la ligne finaux et ce repli.

Le verdict ci-dessus reste celui de l'essai réel initial. Un nouveau verdict
nécessite un nouvel essai réseau limité et explicitement autorisé.
