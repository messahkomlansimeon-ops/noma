export type ArtKey = "phone" | "sofa" | "plug" | "ac" | "drill" | "car" | "box";
export type SourceKind = "noma" | "external";
export type Availability = "confirmed" | "unknown" | "removed";
export type Category = "produits" | "services" | "locations";

export interface Offer {
  id: string;
  title: string;
  price: number;
  condition: string;
  zone: string;
  city: string;
  category: Category;
  source: SourceKind;
  sourceName: string;
  freshness: string;
  delivery: string;
  warranty: string;
  availability: Availability;
  art: ArtKey;
}

export interface AlertItem {
  id: string;
  title: string;
  zone: string;
  budget: string;
  condition: string;
  freq: "immediate" | "daily";
  until: string;
  news: number;
}

export interface ChatMessage {
  id: string;
  from: "buyer" | "vendor";
  text?: string;
  offer?: { total: number; delivery: string; slot: string };
  state?: "awaiting" | "accepted";
  time: string;
}

export interface Thread {
  id: string;
  vendor: string;
  initials: string;
  tone: "sage" | "carrot" | "sky";
  snippet: string;
  time: string;
  unread: number;
  art: ArtKey;
  product: string;
  verified?: boolean;
  messages: ChatMessage[];
}

export interface Order {
  id: string;
  title: string;
  vendor: string;
  price: number;
  art: ArtKey;
  status: "preparing" | "quote" | "sent" | "done";
  delivery?: string;
  note?: string;
  steps: string[];
  stepTimes: string[];
  step: number;
  zone?: string;
  deliveryIncluded?: string;
  payment?: string;
}

export interface Demand {
  id: string;
  title: string;
  budget: string;
  zone: string;
  delay: string;
  traits: string;
  state: "new" | "answered";
  art: ArtKey;
}

export interface Listing {
  id: string;
  title: string;
  price: number;
  art: ArtKey;
  state: "online" | "reconfirm" | "draft";
  note: string;
}

export interface Proposal {
  id: string;
  vendor: string;
  title: string;
  condition: string;
  price: number;
  priceNote: string;
  badges: { tone: "sage" | "wash"; label: string }[];
  slot: string;
  warranty: string;
  confirmed: boolean;
  art: ArtKey;
  offerId: string;
}

export interface VendorOrder {
  id: string;
  title: string;
  price: number;
  art: ArtKey;
  zone: string;
  slot: string;
  status: "preparing" | "toconfirm" | "done";
  client?: string;
  accepted?: boolean;
  step?: number;
  total?: number;
  deliveryIncluded?: string;
  delivery?: string;
  place?: string;
  payment?: boolean;
}

export interface QuoteLine {
  label: string;
  amount: number;
}

export interface CaseItem {
  id: string;
  motif: string;
  offer: string;
  meta: string;
  time: string;
  art: ArtKey;
  status: "open" | "closed";
  price?: number;
  declared?: number;
  synthesis?: string;
  signal?: string;
  decision?: string;
  motifDecision?: string;
}

export const NEED_DEFAULT = "Un iPhone 12 en bon état, à Abidjan, jusqu'à 150 000 FCFA.";

export const formatF = (n: number) =>
  `${n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "\u00A0")} FCFA`;

export const formatShort = (n: number) =>
  n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "\u00A0");

export const searchOffers: Offer[] = [
  {
    id: "o-iphone-145",
    title: "iPhone 12 · 128 Go",
    price: 145000,
    condition: "Occasion",
    zone: "Cocody",
    city: "Abidjan",
    category: "produits",
    source: "external",
    sourceName: "Site marchand",
    freshness: "vu il y a 20 min",
    delivery: "Non renseignée",
    warranty: "Non renseignée",
    availability: "unknown",
    art: "phone",
  },
  {
    id: "o-iphone-150",
    title: "iPhone 12 · 128 Go",
    price: 150000,
    condition: "Occasion",
    zone: "Marory",
    city: "Abidjan",
    category: "produits",
    source: "noma",
    sourceName: "Noma",
    freshness: "actualisé il y a 1 h",
    delivery: "Incluse",
    warranty: "1 mois annoncé",
    availability: "unknown",
    art: "phone",
  },
  {
    id: "o-iphone-140",
    title: "iPhone 12 · 128 Go",
    price: 140000,
    condition: "Occasion",
    zone: "Yopougon",
    city: "Abidjan",
    category: "produits",
    source: "external",
    sourceName: "Site marchand",
    freshness: "vu il y a 35 min",
    delivery: "Retrait uniquement",
    warranty: "Non renseignée",
    availability: "unknown",
    art: "phone",
  },
];

export const canapeOffer: Offer = {
  id: "o-canape",
  title: "Canapé 3 places",
  price: 185000,
  condition: "Bon état",
  zone: "Cocody",
  city: "Abidjan",
  category: "produits",
  source: "noma",
  sourceName: "Noma",
  freshness: "actualisé il y a 1 h",
  delivery: "À préciser",
  warranty: "Non renseignée",
  availability: "confirmed",
  art: "sofa",
};

export const galaxyOffer: Offer = {
  id: "o-galaxy",
  title: "Galaxy A54 · 128 Go",
  price: 125000,
  condition: "Bon état",
  zone: "Yopougon",
  city: "Abidjan",
  category: "produits",
  source: "noma",
  sourceName: "Noma",
  freshness: "actualisé il y a 2 h",
  delivery: "Retrait uniquement",
  warranty: "Non renseignée",
  availability: "confirmed",
  art: "phone",
};

export const chargeurOffer: Offer = {
  id: "o-chargeur",
  title: "Chargeur USB-C 20 W",
  price: 10000,
  condition: "Neuf",
  zone: "Marcory",
  city: "Abidjan",
  category: "produits",
  source: "noma",
  sourceName: "Noma",
  freshness: "actualisé il y a 30 min",
  delivery: "À préciser",
  warranty: "6 mois annoncés",
  availability: "confirmed",
  art: "plug",
};

export const allOffers: Offer[] = [
  ...searchOffers,
  canapeOffer,
  galaxyOffer,
  chargeurOffer,
];

export const featuredOffers: Offer[] = [
  searchOffers[0],
  canapeOffer,
  galaxyOffer,
  searchOffers[1],
  chargeurOffer,
];

export const favoritesSeed: { offerId: string; removed?: boolean }[] = [
  { offerId: "o-iphone-145" },
  { offerId: "o-canape" },
  { offerId: "o-iphone-140", removed: true },
];

export const alertsSeed: AlertItem[] = [
  {
    id: "a-1",
    title: "iPhone 12 · 128 Go",
    zone: "Abidjan",
    budget: "150 000 F max",
    condition: "Occasion",
    freq: "daily",
    until: "15 oct.",
    news: 3,
  },
  {
    id: "a-2",
    title: "Canapé 3 places",
    zone: "Cocody",
    budget: "200 000 F max",
    condition: "",
    freq: "immediate",
    until: "20 oct.",
    news: 0,
  },
];

export const threadsSeed: Thread[] = [
  {
    id: "t-marcory",
    vendor: "Marcory Mobile",
    initials: "MM",
    tone: "sage",
    snippet: "Disponible. Livraison demain.",
    time: "14:32",
    unread: 2,
    art: "phone",
    product: "iPhone 12 · 128 Go",
    verified: true,
    messages: [
      {
        id: "m1",
        from: "buyer",
        text: "Bonjour, est-il disponible ?",
        time: "14:28",
      },
      {
        id: "m2",
        from: "vendor",
        text: "Oui. 150 000 F, livraison incluse.",
        time: "14:32",
      },
      { id: "m3", from: "buyer", text: "Possible demain à Cocody ?", time: "14:33" },
      {
        id: "m4",
        from: "vendor",
        time: "14:34",
        offer: { total: 150000, delivery: "Incluse", slot: "2 oct. · 14 h–17 h" },
        state: "awaiting",
      },
    ],
  },
  {
    id: "t-cocody",
    vendor: "Maison Cocody",
    initials: "MC",
    tone: "carrot",
    snippet: "Voici les dimensions du canapé.",
    time: "Hier",
    unread: 0,
    art: "sofa",
    product: "Canapé 3 places",
    messages: [
      {
        id: "m5",
        from: "vendor",
        text: "Bonjour, le canapé est disponible en beige. Voici les dimensions : 190 × 85 cm.",
        time: "18:02",
      },
    ],
  },
  {
    id: "t-koffi",
    vendor: "Atelier Koffi",
    initials: "AK",
    tone: "sky",
    snippet: "Votre devis est prêt.",
    time: "Hier",
    unread: 0,
    art: "ac",
    product: "Réparation climatiseur",
    verified: true,
    messages: [
      {
        id: "m6",
        from: "vendor",
        text: "Votre devis de réparation est prêt : 25 000 FCFA, intervention demain matin.",
        time: "10:12",
      },
    ],
  },
];

export const ordersSeed: Order[] = [
  {
    id: "NM-024",
    title: "iPhone 12 · 128 Go",
    vendor: "Marcory Mobile",
    price: 150000,
    art: "phone",
    status: "preparing",
    delivery: "2 oct. · 14 h–17 h",
    steps: ["Demande envoyée", "Confirmée par le vendeur", "Offre acceptée", "Réception"],
    stepTimes: ["1 oct. · 14:20", "1 oct. · 14:32", "1 oct. · 14:40", "À venir"],
    step: 3,
    zone: "Cocody, Abidjan",
    deliveryIncluded: "Incluse",
    payment: "Direct au vendeur",
  },
  {
    id: "NM-025",
    title: "Réparation climatiseur",
    vendor: "Atelier Koffi",
    price: 25000,
    art: "ac",
    status: "quote",
    steps: ["Demande envoyée", "Devis reçu", "Devis validé", "Intervention"],
    stepTimes: ["Hier · 10:12", "Hier · 16:00", "À faire", "À venir"],
    step: 2,
    note: "Voir le devis",
  },
  {
    id: "NM-026",
    title: "Canapé 3 places",
    vendor: "Maison Cocody",
    price: 185000,
    art: "sofa",
    status: "sent",
    steps: ["Demande envoyée", "Confirmée par le vendeur", "Offre acceptée", "Réception"],
    stepTimes: ["Hier · 18:00", "À venir", "À venir", "À venir"],
    step: 1,
    note: "Confirmation attendue",
  },
];

export const demandsSeed: Demand[] = [
  {
    id: "D-104",
    title: "iPhone 12 · 128 Go",
    budget: "150 000 F max",
    zone: "Cocody",
    delay: "Pour demain",
    traits: "Bon état · 128 Go",
    state: "new",
    art: "phone",
  },
  {
    id: "D-103",
    title: "Chargeur USB-C 20 W",
    budget: "10 000 F max",
    zone: "Marory",
    delay: "",
    traits: "Neuf ou très bon état",
    state: "answered",
    art: "plug",
  },
  {
    id: "D-102",
    title: "Galaxy A54 · 128 Go",
    budget: "125 000 F max",
    zone: "Yopougon",
    delay: "",
    traits: "Bon état · 128 Go",
    state: "answered",
    art: "phone",
  },
];

export const listingsSeed: Listing[] = [
  {
    id: "l-1",
    title: "iPhone 12 · 128 Go",
    price: 150000,
    art: "phone",
    state: "online",
    note: "Disponibilité confirmée il y a 1 h",
  },
  {
    id: "l-2",
    title: "Galaxy A54 · 128 Go",
    price: 125000,
    art: "phone",
    state: "reconfirm",
    note: "",
  },
  {
    id: "l-3",
    title: "iPhone 13 · 128 Go",
    price: 190000,
    art: "phone",
    state: "draft",
    note: "Prix à compléter",
  },
];

export const proposalsSeed: Proposal[] = [
  {
    id: "p-1",
    vendor: "Marcory Mobile",
    title: "iPhone 12 · 128 Go",
    condition: "Occasion · 128 Go",
    price: 150000,
    priceNote: "",
    badges: [
      { tone: "sage", label: "Livraison incluse" },
      { tone: "wash", label: "1 mois annoncé" },
    ],
    slot: "2 oct. · 14 h–17 h",
    warranty: "",
    confirmed: true,
    art: "phone",
    offerId: "o-iphone-150",
  },
  {
    id: "p-2",
    vendor: "Mobile Cocody",
    title: "iPhone 12 · 128 Go",
    condition: "Occasion · 128 Go",
    price: 147000,
    priceNote: "145 000 F + 2 000 F de livraison",
    badges: [{ tone: "wash", label: "Garantie non renseignée" }],
    slot: "2 oct. · 16 h–18 h",
    warranty: "Non renseignée",
    confirmed: true,
    art: "phone",
    offerId: "o-iphone-145",
  },
];

export const vendorOrdersSeed: VendorOrder[] = [
  {
    id: "NM-024",
    title: "iPhone 12 · 128 Go",
    price: 150000,
    art: "phone",
    zone: "Cocody",
    slot: "2 oct. · 14 h–17 h",
    status: "preparing",
    client: "Alex O.",
    accepted: true,
    step: 1,
    total: 150000,
    deliveryIncluded: "Incluse",
    delivery: "2 oct. · 14 h–17 h",
    place: "Cocody, Abidjan",
    payment: false,
  },
  {
    id: "NM-027",
    title: "Galaxy A54 · 128 Go",
    price: 125000,
    art: "phone",
    zone: "Yopougon",
    slot: "Délai à préciser",
    status: "toconfirm",
  },
];

export const quoteSeed = {
  service: "Réparation climatiseur",
  provider: "Atelier Koffi · Cocody",
  intervention: "Remplacement du condensateur",
  lines: [
    { label: "Condensateur", amount: 10000 },
    { label: "Main-d'œuvre", amount: 10000 },
    { label: "Déplacement", amount: 5000 },
  ] as QuoteLine[],
  slot: "3 oct. · 9 h–11 h",
  valid: "7 octobre 2026",
  rule: "Direct au prestataire",
};

export const casesSeed: CaseItem[] = [
  {
    id: "S-104",
    motif: "Prix incorrect",
    offer: "iPhone 12 · 128 Go",
    meta: "1 signalement · Annonce externe",
    time: "Il y a 15 min",
    art: "phone",
    status: "open",
    price: 145000,
    declared: 170000,
    synthesis: "Écart signalé, à vérifier.",
    signal: "Signalé 14:45 · Ouvert 15:02",
  },
  {
    id: "S-103",
    motif: "Produit déjà vendu",
    offer: "Canapé 3 places",
    meta: "1 signalement · Noma",
    time: "Il y a 40 min",
    art: "sofa",
    status: "open",
  },
  {
    id: "S-102",
    motif: "Vendeur injoignable",
    offer: "iPhone 12 · 128 Go",
    meta: "2 signalements · Noma",
    time: "Il y a 1 h",
    art: "phone",
    status: "open",
  },
];
