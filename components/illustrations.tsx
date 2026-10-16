/**
 * Illustrations de la marque : SVG maison, sans emoji, qui n'utilisent que les couleurs du site.
 * Elles sont décoratives (aria-hidden) : le sens passe toujours par le texte voisin.
 * Les classes `animate-float` / `animate-wiggle` viennent de globals.css.
 */

type Art = { className?: string };

const base = "shrink-0";

/** Loupe qui survole des étiquettes de prix : recherche, résultats, accueil. */
export function ArtSearch({ className = "size-40" }: Art) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={`${base} ${className}`} aria-hidden>
      <circle cx="80" cy="82" r="62" fill="var(--color-brand-soft)" />
      <g className="animate-float">
        <rect x="26" y="38" width="46" height="30" rx="9" fill="var(--color-accent)" transform="rotate(-8 26 38)" />
        <circle cx="38" cy="50" r="4" fill="var(--color-ink)" opacity=".85" />
        <rect x="104" y="30" width="34" height="24" rx="8" fill="var(--color-success-soft)" transform="rotate(10 104 30)" />
        <path d="M112 42h14" stroke="var(--color-success)" strokeWidth="4" strokeLinecap="round" transform="rotate(10 104 30)" />
      </g>
      <circle cx="76" cy="78" r="26" fill="#fff" stroke="var(--color-brand)" strokeWidth="9" />
      <path d="M96 98l24 24" stroke="var(--color-brand)" strokeWidth="11" strokeLinecap="round" />
      <path d="M64 74c3-7 10-10 17-8" stroke="var(--color-brand-soft)" strokeWidth="5" strokeLinecap="round" />
      <circle cx="132" cy="108" r="6" fill="var(--color-accent)" />
      <circle cx="24" cy="112" r="4" fill="var(--color-brand)" opacity=".5" />
    </svg>
  );
}

/** Boîte vide et ouverte : aucune offre, aucune commande, liste vide. */
export function ArtEmpty({ className = "size-36" }: Art) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={`${base} ${className}`} aria-hidden>
      <ellipse cx="80" cy="136" rx="46" ry="8" fill="var(--color-mist)" />
      <g className="animate-float">
        <path d="M34 62l46-20 46 20v50l-46 20-46-20z" fill="var(--color-brand-soft)" stroke="var(--color-brand)" strokeWidth="5" strokeLinejoin="round" />
        <path d="M34 62l46 20 46-20M80 82v50" stroke="var(--color-brand)" strokeWidth="5" strokeLinejoin="round" />
        <path d="M34 62L52 40l28 12M126 62L108 40 80 52" stroke="var(--color-brand)" strokeWidth="5" strokeLinejoin="round" fill="var(--color-brand-soft)" />
        <circle cx="122" cy="36" r="7" fill="var(--color-accent)" />
        <circle cx="42" cy="30" r="4" fill="var(--color-brand)" opacity=".4" />
      </g>
    </svg>
  );
}

/** Cloche qui sonne : alertes et notifications. */
export function ArtBell({ className = "size-36" }: Art) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={`${base} ${className}`} aria-hidden>
      <circle cx="80" cy="84" r="60" fill="var(--color-accent-soft)" />
      <g className="animate-wiggle" style={{ transformOrigin: "80px 38px" }}>
        <path d="M46 104c8-8 8-18 8-34a26 26 0 0 1 52 0c0 16 0 26 8 34z" fill="var(--color-brand)" />
        <path d="M70 112a10 10 0 0 0 20 0" fill="var(--color-accent)" />
        <circle cx="80" cy="36" r="6" fill="var(--color-brand)" />
        <path d="M62 70c1-8 6-14 14-16" stroke="#fff" strokeWidth="5" strokeLinecap="round" opacity=".6" />
      </g>
      <circle cx="116" cy="46" r="10" fill="var(--color-accent)" />
      <path d="M26 54c-6 6-8 14-6 22M134 54c6 6 8 14 6 22" stroke="var(--color-brand)" strokeWidth="5" strokeLinecap="round" opacity=".35" />
    </svg>
  );
}

/** Bulles de discussion : messages et propositions. */
export function ArtChat({ className = "size-36" }: Art) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={`${base} ${className}`} aria-hidden>
      <circle cx="80" cy="82" r="60" fill="var(--color-info-soft)" />
      <g className="animate-float">
        <path d="M36 44h62a12 12 0 0 1 12 12v30a12 12 0 0 1-12 12H62l-18 14V98h-8a12 12 0 0 1-12-12V56a12 12 0 0 1 12-12z" fill="var(--color-brand)" />
        <circle cx="54" cy="71" r="5" fill="#fff" />
        <circle cx="74" cy="71" r="5" fill="#fff" />
        <circle cx="94" cy="71" r="5" fill="#fff" />
        <path d="M84 100h40a10 10 0 0 1 10 10v14a10 10 0 0 1-10 10h-4v12l-14-12H84a10 10 0 0 1-10-10v-14a10 10 0 0 1 10-10z" fill="var(--color-accent)" />
      </g>
    </svg>
  );
}

/** Cœur : favoris. */
export function ArtHeart({ className = "size-36" }: Art) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={`${base} ${className}`} aria-hidden>
      <circle cx="80" cy="82" r="60" fill="var(--color-danger-soft)" />
      <g className="animate-float">
        <path d="M80 122S34 94 34 62a24 24 0 0 1 46-10 24 24 0 0 1 46 10c0 32-46 60-46 60z" fill="var(--color-danger)" />
        <path d="M52 58c0-7 5-12 12-12" stroke="#fff" strokeWidth="6" strokeLinecap="round" opacity=".55" />
      </g>
      <circle cx="128" cy="38" r="6" fill="var(--color-accent)" />
      <circle cx="30" cy="104" r="4" fill="var(--color-brand)" opacity=".45" />
    </svg>
  );
}

/** Sac et colis : commandes. */
export function ArtBag({ className = "size-36" }: Art) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={`${base} ${className}`} aria-hidden>
      <circle cx="80" cy="84" r="60" fill="var(--color-success-soft)" />
      <g className="animate-float">
        <path d="M44 58h72l8 64a8 8 0 0 1-8 9H44a8 8 0 0 1-8-9z" fill="var(--color-success)" />
        <path d="M62 66V52a18 18 0 0 1 36 0v14" stroke="var(--color-ink)" strokeWidth="7" strokeLinecap="round" />
        <path d="M66 94l10 10 20-22" stroke="#fff" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="124" cy="40" r="7" fill="var(--color-accent)" />
      </g>
    </svg>
  );
}

/** Bouclier : sécurité, signalements, modération. */
export function ArtShield({ className = "size-36" }: Art) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={`${base} ${className}`} aria-hidden>
      <circle cx="80" cy="84" r="60" fill="var(--color-brand-soft)" />
      <g className="animate-float">
        <path d="M80 28l40 14v34c0 28-18 46-40 56-22-10-40-28-40-56V42z" fill="var(--color-brand)" />
        <path d="M62 80l14 14 26-30" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="124" cy="30" r="6" fill="var(--color-accent)" />
      </g>
    </svg>
  );
}

/** Étiquette de prix : annonces, offres. */
export function ArtTag({ className = "size-36" }: Art) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={`${base} ${className}`} aria-hidden>
      <circle cx="80" cy="84" r="60" fill="var(--color-accent-soft)" />
      <g className="animate-float">
        <path d="M30 80V40a10 10 0 0 1 10-10h40a10 10 0 0 1 7 3l42 42a10 10 0 0 1 0 14l-36 36a10 10 0 0 1-14 0L33 87a10 10 0 0 1-3-7z" fill="var(--color-accent)" />
        <circle cx="54" cy="54" r="9" fill="#fff" />
        <path d="M82 76l22 22M70 88l22 22" stroke="var(--color-ink)" strokeWidth="6" strokeLinecap="round" opacity=".55" />
      </g>
    </svg>
  );
}

/** Portefeuille : porte-monnaie. */
export function ArtWallet({ className = "size-36" }: Art) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={`${base} ${className}`} aria-hidden>
      <circle cx="80" cy="84" r="60" fill="var(--color-brand-soft)" />
      <g className="animate-float">
        <rect x="28" y="52" width="104" height="72" rx="14" fill="var(--color-brand)" />
        <path d="M28 70a14 14 0 0 1 14-14h66" stroke="var(--color-brand-deep)" strokeWidth="6" strokeLinecap="round" />
        <rect x="90" y="80" width="42" height="26" rx="10" fill="var(--color-accent)" />
        <circle cx="105" cy="93" r="5" fill="var(--color-ink)" />
        <circle cx="120" cy="36" r="8" fill="var(--color-accent)" />
        <path d="M120 32v8M117 36h6" stroke="var(--color-ink)" strokeWidth="2.5" strokeLinecap="round" />
      </g>
    </svg>
  );
}

/** Boutique : espace vendeur. */
export function ArtStore({ className = "size-36" }: Art) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={`${base} ${className}`} aria-hidden>
      <circle cx="80" cy="84" r="60" fill="var(--color-success-soft)" />
      <g className="animate-float">
        <path d="M30 62l10-26h80l10 26z" fill="var(--color-brand)" />
        <path d="M30 62a16 16 0 0 0 32 0 16 16 0 0 0 36 0 16 16 0 0 0 32 0" fill="var(--color-accent)" />
        <rect x="38" y="76" width="84" height="52" rx="4" fill="#fff" stroke="var(--color-ink)" strokeWidth="5" />
        <rect x="68" y="96" width="24" height="32" rx="3" fill="var(--color-brand)" />
        <circle cx="124" cy="34" r="6" fill="var(--color-accent)" />
      </g>
    </svg>
  );
}

/** Coche animée dans un cercle : succès, confirmation. */
export function ArtCheck({ className = "size-28" }: Art) {
  return (
    <svg viewBox="0 0 120 120" fill="none" className={`${base} ${className}`} aria-hidden>
      <circle cx="60" cy="60" r="52" fill="var(--color-success-soft)" className="animate-pop" />
      <circle cx="60" cy="60" r="36" fill="var(--color-success)" className="animate-pop" style={{ animationDelay: "80ms" }} />
      <path d="M43 61l12 12 23-26" stroke="#fff" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" className="animate-pop" style={{ animationDelay: "180ms", transformOrigin: "60px 60px" }} />
    </svg>
  );
}

/** Triangle d'alerte : erreur, page introuvable, service indisponible. */
export function ArtAlert({ className = "size-32" }: Art) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={`${base} ${className}`} aria-hidden>
      <circle cx="80" cy="84" r="60" fill="var(--color-accent-soft)" />
      <g className="animate-float">
        <path d="M80 30l50 88H30z" fill="var(--color-accent)" stroke="var(--color-ink)" strokeWidth="5" strokeLinejoin="round" />
        <path d="M80 62v28" stroke="var(--color-ink)" strokeWidth="9" strokeLinecap="round" />
        <circle cx="80" cy="104" r="5.5" fill="var(--color-ink)" />
      </g>
    </svg>
  );
}

/** Carte et épingle : lieu, ville, livraison. */
export function ArtPin({ className = "size-36" }: Art) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={`${base} ${className}`} aria-hidden>
      <circle cx="80" cy="84" r="60" fill="var(--color-info-soft)" />
      <path d="M30 108l30-12 40 14 30-12v26l-30 12-40-14-30 12z" fill="#fff" stroke="var(--color-brand)" strokeWidth="4" strokeLinejoin="round" />
      <ellipse cx="80" cy="118" rx="16" ry="5" fill="var(--color-ink)" opacity=".18" />
      <g className="animate-float">
        <path d="M80 28a26 26 0 0 0-26 26c0 22 26 50 26 50s26-28 26-50a26 26 0 0 0-26-26z" fill="var(--color-brand)" />
        <circle cx="80" cy="54" r="10" fill="var(--color-accent)" />
      </g>
    </svg>
  );
}
