# Design de noma

Direction « lagune et soleil » : bleu outremer, jaune safran, fond clair. Une seule police (Figtree). L'interface parle par l'image : peu de texte, des icônes, des illustrations, des animations douces. Aucun emoji.

Référence vivante : `app/(buyer)/page.tsx` (accueil acheteur).

## Règles

1. **Peu de texte, juste l'utile.** Un titre court, des icônes, des pastilles. On retire les paragraphes d'explication, les sous-titres décoratifs et les « astuces ». On GARDE : prix, statuts, erreurs, avertissements de sécurité, textes de confidentialité, avertissements de paiement simulé, mentions juridiques. Quand un bouton n'a pas de texte visible, il porte un `aria-label` complet.
2. **Beaucoup de visuel.** Chaque liste a une icône ou une vignette ; chaque état vide a une illustration (`components/illustrations.tsx`) via `EmptyState` ; chaque chargement utilise `Skeleton`, pas une phrase. Icônes : `lucide-react`, taille 20 à 24 px, `aria-hidden` quand elles sont décoratives.
3. **Aucun emoji**, nulle part (ni texte, ni `aria-label`, ni message de toast).
4. **Une seule police** : ne jamais écrire `font-display`, `font-serif`, `font-mono` ni `font-[…]`.
5. **Couleurs : uniquement les jetons** de `app/globals.css` : `canvas`, `ink`, `ink-soft`, `brand` (+ `-deep`, `-soft`, `-ink`), `accent` (+ `-soft`, `-ink`), `success`, `info`, `danger`, `mist`, `line`, `line-strong`. Jamais de `#hex` ni de couleur Tailwind brute (`bg-red-500`). Texte sur `accent` : toujours `text-ink`, jamais `text-white`.
6. **Texte lisible** : corps 15 à 16 px, jamais sous 12 px (`text-[12px]` seulement pour une pastille ou une légende). Contraste de 4,5 contre 1 au minimum.
7. **Cibles tactiles de 44 px** au moins (`min-h-11` ou `min-h-12`). Ajouter la classe `press` aux éléments touchables pour l'effet de pression.
8. **Animations** : `animate-rise` (entrée d'un bloc), `animate-pop` (apparition d'un badge ou d'une statistique), `stagger` sur le parent d'une liste (les enfants arrivent l'un après l'autre), `animate-float` (illustrations, déjà dedans). Pas d'animation en boucle sur du texte. `prefers-reduced-motion` est déjà géré par `globals.css`.
9. **Responsive** : on écrit mobile d'abord. Le gabarit (`app/(buyer|vendor|admin)/layout.tsx`) fournit déjà un conteneur centré de `max-w-3xl` (admin : `max-w-5xl`) et le menu latéral dès 768 px. Dans une page : colonne simple sur téléphone, `md:grid md:grid-cols-2` quand une liste de cartes gagne à s'étaler. Jamais de largeur fixe en pixels, jamais de `max-w-[480px]`.
10. **Pas de `transform` permanent** sur un conteneur de page (il casserait les éléments `fixed`). Les animations d'entrée finissent sur `transform: none`.
11. **Focus visible** : ne jamais écrire `outline-none` sans le remplacer.

## Composants (`components/ui.tsx`)

`Btn`, `BtnOutline`, `Chip`, `Badge` (tons : `carrot` = à surveiller, `sage` = bon, `sky` = info, `wash` = neutre, `forest` = plein), `Avatar`, `Input`, `Textarea`, `FieldLabel`, `Switch`, `Segmented`, `OptionCard`, `MenuRow`, `KvRow`, `StatCard`, `SectionTitle`, et les nouveaux : `IconTile` (icône dans une pastille colorée), `Card`, `EmptyState` (illustration + une phrase + une action), `Skeleton`.

`components/top-bar.tsx` : `TopBar`, `HeaderBtn` (bouton rond d'icône, avec `label`). `components/thumb.tsx` : vignette d'annonce.

## Illustrations (`components/illustrations.tsx`)

`ArtSearch`, `ArtEmpty`, `ArtBell`, `ArtChat`, `ArtHeart`, `ArtBag`, `ArtShield`, `ArtTag`, `ArtWallet`, `ArtStore`, `ArtCheck`, `ArtAlert`, `ArtPin`. Chacune prend un `className` de taille (`size-28` à `size-44`).

## Navigation

Téléphone : barre de 4 onglets en bas. À partir de 768 px : menu latéral à gauche. Les entrées sont définies une seule fois dans `components/tab-bar.tsx`.

## Ce qui ne change pas

Données, API, adresses, migrations, logique serveur, textes métier des fichiers `lib/` (ils sont testés), attributs `data-*` et `data-testid`, noms accessibles.
