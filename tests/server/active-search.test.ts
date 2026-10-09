import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { tokenize } from "../../lib/server/external/analysis";
import { collapseDuplicates, compareEvaluated, type CandidateRow, type Evaluated } from "../../lib/server/external/matching";
import { ACTIVE_SEARCH_ERROR_MESSAGES, ActiveSearchError, type ActiveSearchErrorCode } from "../../lib/server/active-search/errors";
import {
  ACTIVE_SEARCH_ACCELERATED_QUOTA_SHARE_PERCENT, ACTIVE_SEARCH_FRESH_COLLECTION_MS, acceleratedQuotaShare, acceleratedWatchLimit,
  ACTIVE_SEARCH_CONTRACT_VERSION, ACTIVE_SEARCH_DURATION_DAYS, ACTIVE_SEARCH_MAX_HORIZON_DAYS, ACTIVE_SEARCH_NOTICE_DAYS, ACTIVE_SEARCH_NOTIFY_BATCH, ACTIVE_SEARCH_PRICE_XOF,
  ACTIVE_SEARCH_SCAN_LOCK_TIMEOUT_MS, ACTIVE_SEARCH_STEP_BUDGET_MS, ACTIVE_SEARCH_STEP_MAX_DEMANDS, ACTIVE_SEARCH_TRACKING_MAX_DAYS, ACTIVE_SEARCH_USER_LOCK_NAMESPACE,
  ACTIVE_SEARCH_WATCH_DAILY_BUDGET, ACTIVE_SEARCH_WATCH_FREQUENCY_SECONDS, ACTIVE_SEARCH_MAX_ACCELERATED_KEYS_PER_USER,
} from "../../lib/server/active-search/config";
import { capacityAllows } from "../../lib/server/active-search/availability";
import { userCapAllows } from "../../lib/server/active-search/places";
import { ELIGIBILITY_COLUMNS, demandIneligibility, eligibilityKeyOf } from "../../lib/server/active-search/eligibility";
import { activeSearchStateDto } from "../../lib/server/active-search/http";
import { needsScan, selectFreshListings } from "../../lib/server/active-search/notify";
import { activeSearchWork, emptyActiveSearchStepResult } from "../../lib/server/active-search/step";
import { computeCoverage, type ActiveSearchState, type PeriodRow } from "../../lib/server/active-search/state";
import { TRACKING_MAX_DAYS } from "../../lib/server/notifications/config";
import {
  EXTERNAL_SOURCE_FALLBACK, EXTERNAL_TITLE_FALLBACK, EXTERNAL_TITLE_MAX_LENGTH, buildExternalDeliveryContent, buildExternalNotificationTitle, buildExternalSourceName,
} from "../../lib/server/notifications/content";
import { WALLET_ACCOUNT_KINDS, WALLET_SYSTEM_ACCOUNT_KINDS, WALLET_TRANSACTION_KINDS } from "../../lib/server/wallet/ledger";
import { VISIBLE_MAX_AGE_MS, WATCH_DEFAULT_DAILY_BUDGET, WATCH_DEFAULT_FREQUENCY_SECONDS } from "../../lib/server/external/config";

/**
 * Recherche active payante (lot RA1) : modules PURS (prix et durées de départ, éligibilité du besoin, couverture des périodes, présélection des besoins à balayer, choix des annonces à
 * notifier sans confondre doublons et capacités, DTO en liste blanche) et contrôles STATIQUES du code (étape après la collecte et isolée, crédits payés seulement, aucune attente de
 * verrou à l'entretien, aucune adresse externe dans les notifications, bloc de contraintes de la migration, scripts). Aucune base : voir tests/postgres/active-search*.test.ts.
 */

const root = join(import.meta.dirname, "../..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const DAY = 86_400_000;
const NOW = new Date("2026-10-07T10:00:00.000Z");

describe("réglages de départ", () => {
  test("prix PROVISOIRE de 2 000 FCFA pour 30 jours, horizon de 180 jours, avis 3 jours avant, suivi jusqu'à 180 jours, collecte d'1 h et 24 requêtes par jour", () => {
    assert.equal(ACTIVE_SEARCH_PRICE_XOF, 2_000);
    assert.equal(ACTIVE_SEARCH_DURATION_DAYS, 30);
    assert.equal(ACTIVE_SEARCH_MAX_HORIZON_DAYS, 180);
    assert.equal(ACTIVE_SEARCH_MAX_HORIZON_DAYS / ACTIVE_SEARCH_DURATION_DAYS, 6, "six périodes d'avance au plus");
    assert.equal(ACTIVE_SEARCH_NOTICE_DAYS, 3);
    assert.equal(ACTIVE_SEARCH_TRACKING_MAX_DAYS, 180);
    assert.equal(TRACKING_MAX_DAYS, 90, "sans l'option, le plafond du suivi reste de 90 jours");
    assert.equal(ACTIVE_SEARCH_WATCH_FREQUENCY_SECONDS, 3_600);
    assert.equal(ACTIVE_SEARCH_WATCH_DAILY_BUDGET, 24);
    assert.equal(WATCH_DEFAULT_FREQUENCY_SECONDS, 6 * 3_600, "la fréquence ordinaire reste de 6 h");
    assert.equal(WATCH_DEFAULT_DAILY_BUDGET, 4, "le budget ordinaire reste de 4 requêtes par jour et par source");
    assert.equal(ACTIVE_SEARCH_CONTRACT_VERSION, "active-search/v1");
  });

  test("le balayage est borné : 3 s, 25 besoins, 50 annonces par besoin, 2 s d'attente de verrou", () => {
    assert.equal(ACTIVE_SEARCH_STEP_BUDGET_MS, 3_000);
    assert.equal(ACTIVE_SEARCH_STEP_MAX_DEMANDS, 25);
    assert.equal(ACTIVE_SEARCH_NOTIFY_BATCH, 50);
    assert.equal(ACTIVE_SEARCH_SCAN_LOCK_TIMEOUT_MS, 2_000);
  });

  test("verrou consultatif 1_314_664_990 : distinct de tous les espaces connus (945 à 960, 970 à 972, 977, 981, 982) et de celui des missions (985)", () => {
    assert.equal(ACTIVE_SEARCH_USER_LOCK_NAMESPACE, 1_314_664_990);
    const used = [...Array.from({ length: 16 }, (_, index) => 1_314_664_945 + index), 1_314_664_970, 1_314_664_971, 1_314_664_972, 1_314_664_977, 1_314_664_981, 1_314_664_982, 1_314_664_985];
    assert.equal(used.includes(ACTIVE_SEARCH_USER_LOCK_NAMESPACE), false);
  });

  test("grand livre : un compte système et deux types de transaction de plus, préfixes de référence de 20 caractères au plus", () => {
    assert.ok((WALLET_ACCOUNT_KINDS as readonly string[]).includes("active_search_revenue"));
    assert.ok((WALLET_SYSTEM_ACCOUNT_KINDS as readonly string[]).includes("active_search_revenue"));
    for (const kind of ["search_purchase", "search_refund"]) {
      assert.ok((WALLET_TRANSACTION_KINDS as readonly string[]).includes(kind), kind);
      assert.ok(kind.length <= 20, `${kind} : préfixe de référence trop long`);
    }
  });

  test("refus de domaine : codes stables et textes fixes, jamais une donnée de la base", () => {
    const codes: ActiveSearchErrorCode[] = [
      "demand_not_active", "no_product_key", "unavailable", "user_cap", "capacity", "price_changed", "purchase_refunded", "max_horizon", "idempotency_conflict", "purchase_not_found", "already_refunded", "later_period_exists",
    ];
    assert.deepEqual(Object.keys(ACTIVE_SEARCH_ERROR_MESSAGES).sort(), [...codes].sort());
    for (const code of codes) {
      const error = new ActiveSearchError(code);
      assert.equal(error.code, code);
      assert.equal(error.message, ACTIVE_SEARCH_ERROR_MESSAGES[code]);
      assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/.test(error.message), false, "aucun identifiant dans le message");
    }
  });
});

describe("éligibilité du besoin (UNE seule fonction pour l'achat et l'écran)", () => {
  const complete = { category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: null, location_text: "Cocody" };
  const available = { collectionAvailable: true };
  const input = (over: Partial<Parameters<typeof demandIneligibility>[0]> = {}) => ({ status: "active", archived: false, mission_carrier: false, ...complete, ...over });

  test("actif, non archivé, avec une clé produit et une collecte disponible : éligible ; brouillon, satisfait, archivé (statut ou date) : demand_not_active", () => {
    assert.equal(demandIneligibility(input(), available), null);
    for (const status of ["draft", "satisfied", "archived"]) assert.equal(demandIneligibility(input({ status }), available), "demand_not_active", status);
    assert.equal(demandIneligibility(input({ archived: true }), available), "demand_not_active");
    assert.match(ELIGIBILITY_COLUMNS, /d\.status AS status, d\.archived_at IS NOT NULL AS archived/);
  });

  test("B1 : sans clé produit (catégorie, marque ou modèle absents ou vides) : no_product_key, jamais une option vendue sans rien à surveiller", () => {
    for (const over of [{ category: null }, { brand: null }, { model: null }, { category: "" }, { brand: "   " }, { model: "" }]) {
      assert.equal(eligibilityKeyOf(input(over)), null, JSON.stringify(over));
      assert.equal(demandIneligibility(input(over), available), "no_product_key", JSON.stringify(over));
    }
    assert.notEqual(eligibilityKeyOf(input()), null);
    assert.match(ELIGIBILITY_COLUMNS, /d\.category AS category, d\.brand AS brand, d\.model AS model, d\.variant AS variant, d\.location_text AS location_text/);
  });

  test("B1 : aucune collecte externe possible (aucun connecteur ou aucune source active, toujours le cas en production) : unavailable", () => {
    assert.equal(demandIneligibility(input(), { collectionAvailable: false }), "unavailable");
  });

  test("B1 : ordre des motifs (besoin inactif, puis clé produit, puis disponibilité)", () => {
    assert.equal(demandIneligibility(input({ status: "satisfied", model: null }), { collectionAvailable: false }), "demand_not_active");
    assert.equal(demandIneligibility(input({ model: null }), { collectionAvailable: false }), "no_product_key");
  });

  test("MV1 : le besoin PORTEUR d'une mission est refusé en tout premier (mission_carrier), quel que soit le reste ; la colonne lue est l'existence d'une mission qui le référence", () => {
    assert.equal(demandIneligibility(input({ mission_carrier: true }), available), "mission_carrier");
    assert.equal(demandIneligibility(input({ mission_carrier: true, status: "archived", archived: true, model: null }), { collectionAvailable: false }), "mission_carrier", "avant demand_not_active, no_product_key et unavailable");
    assert.equal(demandIneligibility(input({ mission_carrier: false }), available), null);
    assert.match(ELIGIBILITY_COLUMNS, /EXISTS \(SELECT 1 FROM missions m WHERE m\.demand_id = d\.id\) AS mission_carrier/);
  });

  test("MV1 : l'achat ET l'état traduisent mission_carrier en « introuvable » (CatalogNotFoundError, le 404 d'un besoin d'autrui), jamais en motif de refus visible", () => {
    for (const name of ["purchase.ts", "state.ts"]) {
      const text = strip(read(`lib/server/active-search/${name}`));
      assert.match(text, /ineligible === "mission_carrier"\) throw new CatalogNotFoundError\("demande"\)/, `${name} : mission_carrier → CatalogNotFoundError`);
    }
    assert.equal(/"mission_carrier"/.test(strip(read("lib/server/active-search/errors.ts"))), false, "mission_carrier n'est pas un code de refus de domaine");
    assert.equal(/mission_carrier/.test(strip(read("lib/server/active-search/http.ts"))), false, "aucune réponse HTTP ne nomme le besoin porteur");
  });

  test("l'achat ET la lecture de l'état passent par cette fonction avec la disponibilité de la collecte, sans test de statut en ligne", () => {
    const purchase = strip(read("lib/server/active-search/purchase.ts"));
    const state = strip(read("lib/server/active-search/state.ts"));
    for (const [name, text] of [["purchase.ts", purchase], ["state.ts", state]] as const) {
      assert.match(text, /demandIneligibility\(/, `${name} appelle demandIneligibility`);
      assert.match(text, /ELIGIBILITY_COLUMNS/, `${name} lit les colonnes d'éligibilité`);
      assert.match(text, /collectionAvailable: .*externalCollectionAvailable\(|collectionAvailable: available/, `${name} fournit la disponibilité de la collecte`);
    }
    assert.equal(/status !== "active"/.test(purchase), false, "purchase.ts ne décide pas lui-même de l'éligibilité");
    assert.match(purchase, /expectedPriceXof !== ACTIVE_SEARCH_PRICE_XOF/, "le prix affiché est comparé au prix courant");
  });
});

describe("collecte accélérée : au plus la moitié du quota de chaque source (A5)", () => {
  test("part de 50 % du quota journalier ; au quota par défaut (200), 100 requêtes accélérées soit 4 surveillances de 24 requêtes", () => {
    assert.equal(ACTIVE_SEARCH_ACCELERATED_QUOTA_SHARE_PERCENT, 50);
    assert.equal(acceleratedQuotaShare(200), 100);
    assert.equal(acceleratedQuotaShare(201), 100, "arrondi à l'inférieur");
    assert.equal(acceleratedQuotaShare(0), 0);
    assert.equal(acceleratedWatchLimit(200), 4);
    assert.equal(acceleratedWatchLimit(47), 0, "un quota trop petit ne porte aucune surveillance accélérée");
    assert.equal(acceleratedWatchLimit(48), 1);
    assert.equal(acceleratedWatchLimit(10_000), Math.floor(5_000 / 24));
  });

  test("contrôle d'admission : une clé déjà engagée est toujours admise, une NOUVELLE clé seulement s'il reste de la capacité", () => {
    const full = { maxWatches: 2, keys: ["a", "b"] };
    assert.equal(capacityAllows(full, "a"), true, "clé déjà engagée");
    assert.equal(capacityAllows(full, "c"), false, "capacité atteinte");
    assert.equal(capacityAllows({ maxWatches: 2, keys: ["a"] }, "c"), true);
    assert.equal(capacityAllows({ maxWatches: 0, keys: [] }, "c"), false, "aucune source active : aucune capacité");
  });

  test("une collecte réussie compte pour le relevé dans la fenêtre de fraîcheur des annonces (48 h)", () => {
    assert.equal(ACTIVE_SEARCH_FRESH_COLLECTION_MS, VISIBLE_MAX_AGE_MS);
    assert.equal(ACTIVE_SEARCH_FRESH_COLLECTION_MS, 48 * 3_600_000);
  });
});

describe("couverture des périodes", () => {
  const period = (number: number, startDay: number, endDay: number): PeriodRow => {
    const startsAt = new Date(NOW.getTime() + startDay * DAY);
    const endsAt = new Date(NOW.getTime() + endDay * DAY);
    return { id: `p${number}`, number, startsAt, endsAt, startsAtText: startsAt.toISOString(), endsAtText: endsAt.toISOString() };
  };

  test("période courante et fin de la chaîne contiguë ; la fin est exclusive ; un trou casse la chaîne", () => {
    const chain = [period(1, 0, 30), period(2, 30, 60), period(3, 60, 90)];
    const middle = computeCoverage(chain, new Date(NOW.getTime() + 45 * DAY));
    assert.equal(middle.current?.number, 2);
    assert.equal(middle.chainEnd?.number, 3);
    assert.equal(computeCoverage(chain, new Date(NOW.getTime() + 90 * DAY)).current, null, "la fin est exclusive");
    assert.equal(computeCoverage(chain, new Date(NOW.getTime() - DAY)).current, null, "avant le début : rien");
    const gap = [period(1, 0, 30), period(2, 31, 61)];
    assert.equal(computeCoverage(gap, new Date(NOW.getTime() + 10 * DAY)).chainEnd?.number, 1, "une période qui ne commence pas à la fin de la précédente n'est pas contiguë");
    assert.equal(computeCoverage([], NOW).current, null);
  });
});

describe("présélection des besoins à balayer", () => {
  const collected = new Date("2026-10-07T09:00:00.000Z");
  const watch = (lastRun: Date | null, ok = true) => ({ product_key: "k", last_run_at: lastRun, has_fresh_ok_run: ok });
  const demand = (over: Partial<Parameters<typeof needsScan>[0]> = {}) => ({ baseline_pending: false, state_version: 1, content_version: 1, scanned_at: collected, ...over });

  test("relevé en attente : seulement après une première collecte RÉUSSIE de la surveillance", () => {
    assert.equal(needsScan(demand({ baseline_pending: true, scanned_at: null }), undefined), false, "pas de surveillance");
    assert.equal(needsScan(demand({ baseline_pending: true, scanned_at: null }), watch(null, false)), false, "jamais collectée");
    assert.equal(needsScan(demand({ baseline_pending: true, scanned_at: null }), watch(collected, false)), false, "collectée sans succès");
    assert.equal(needsScan(demand({ baseline_pending: true, scanned_at: null }), watch(collected, true)), true);
    assert.equal(needsScan(demand({ baseline_pending: null, state_version: null, scanned_at: null }), watch(collected, true)), true, "aucun état : relevé en attente");
  });

  test("besoin modifié depuis le relevé : relevé aussitôt ; sinon balayage seulement si la surveillance a été collectée depuis (filigrane)", () => {
    assert.equal(needsScan(demand({ state_version: 1, content_version: 2 }), watch(collected)), true, "modifié");
    assert.equal(needsScan(demand(), watch(collected)), false, "rien de neuf depuis le dernier balayage");
    assert.equal(needsScan(demand(), watch(new Date(collected.getTime() + 1))), true, "collectée depuis");
    assert.equal(needsScan(demand({ scanned_at: null }), watch(collected)), true, "balayage à refaire (suivi repris)");
    assert.equal(needsScan(demand(), watch(null)), false, "surveillance jamais collectée");
    assert.equal(needsScan(demand(), undefined), false, "pas de surveillance");
  });

  test("le travail de l'étape compte fins, arrêts, retours du suivi, avis, notifications, résumés et relevés, pas un simple examen", () => {
    const empty = emptyActiveSearchStepResult();
    assert.equal(activeSearchWork(empty), 0);
    assert.equal(activeSearchWork({ ...empty, examined: 9, deferred: 3, busy: 2, trackingHeld: 4, deliveries: 7 }), 0);
    for (const field of ["ended", "stopped", "trackingClamped", "notices", "notified", "digested", "baselines"] as const) assert.equal(activeSearchWork({ ...empty, [field]: 1 }), 1, field);
  });
});

describe("annonces à notifier : une fois par groupe de doublons, jamais deux capacités confondues", () => {
  const row = (id: string, source: string, price: number, group: string | null, title: string): CandidateRow => ({
    id, source_code: source, source_name: `Source ${source}`, canonical_url: `https://${source}.example/${id}`, title, price_amount: String(price), price_currency: "XOF", location_text: "Cocody",
    listed_at: null, availability_confirmed_at: null, last_seen_at: NOW, first_seen_at: NOW, duplicate_group_id: group, analysis: null,
  });
  const evaluated = (candidate: CandidateRow): Evaluated => ({
    row: candidate, score: 100, price: Number(candidate.price_amount),
    candidate: { sourceCode: candidate.source_code, priceAmount: Number(candidate.price_amount), priceCurrency: "XOF", tokens: tokenize(candidate.title), url: candidate.canonical_url },
  });
  const evaluation = (rows: CandidateRow[]) => {
    const candidates = rows.map(evaluated);
    return { items: collapseDuplicates(candidates).sort((a, b) => compareEvaluated(a.entry, b.entry)), candidates };
  };
  const ids = (list: Array<{ entry: { row: { id: string } } }>): string[] => list.map((item) => item.entry.row.id).sort();

  test("deux annonces d'un même groupe sont UNE seule annonce à notifier (la moins chère), qui absorbe l'autre", () => {
    const { fresh, covered } = selectFreshListings(evaluation([row("a1", "a", 102_000, "g", "iPhone 12 128 Go noir"), row("b1", "b", 100_000, "g", "iPhone 12 128 Go noir")]), new Set());
    assert.deepEqual(ids(fresh), ["b1"]);
    assert.deepEqual(fresh[0].absorbedIds, ["a1"]);
    assert.deepEqual(covered, []);
  });

  test("un membre du groupe déjà vu couvre tout le groupe : rien à notifier, l'autre membre est marqué « doublon »", () => {
    const { fresh, covered } = selectFreshListings(evaluation([row("a1", "a", 102_000, "g", "iPhone 12 128 Go noir"), row("b1", "b", 100_000, "g", "iPhone 12 128 Go noir")]), new Set(["a1"]));
    assert.deepEqual(fresh, []);
    assert.deepEqual(covered, ["b1"]);
  });

  test("doublon VÉRIFIÉ non regroupé (regroupement en retard) d'une annonce déjà vue : couvert, jamais notifié", () => {
    const { fresh, covered } = selectFreshListings(evaluation([row("a1", "a", 102_000, null, "iPhone 12 128 Go noir"), row("b1", "b", 100_000, null, "iPhone 12 128 Go noir")]), new Set(["a1"]));
    assert.deepEqual(fresh, []);
    assert.deepEqual(covered, ["b1"]);
  });

  test("deux CAPACITÉS différentes ne sont jamais confondues, même au prix voisin et sans groupe : 64 Go vu, 128 Go notifié", () => {
    const rows = [row("a1", "a", 100_000, null, "iPhone 12 64 Go noir"), row("b1", "b", 101_000, null, "iPhone 12 128 Go noir")];
    const { fresh, covered } = selectFreshListings(evaluation(rows), new Set(["a1"]));
    assert.deepEqual(ids(fresh), ["b1"]);
    assert.deepEqual(covered, []);
  });

  test("un groupe enregistré qui regroupe à tort deux capacités : la lecture ne les absorbe pas, le second est notifié", () => {
    const rows = [row("a1", "a", 100_000, "g", "iPhone 12 64 Go noir"), row("b1", "b", 101_000, "g", "iPhone 12 128 Go noir")];
    const result = evaluation(rows);
    assert.equal(result.items.length, 2, "deux annonces présentées à part");
    assert.ok(result.items.every((item) => item.absorbedIds.length === 0));
    const { fresh } = selectFreshListings(result, new Set(["a1"]));
    assert.deepEqual(ids(fresh), ["b1"]);
  });

  test("A2 : DÉFENSE — une annonce vue pour la première fois AVANT l'instant de coupure du relevé n'est jamais notifiée (existante), même si elle n'a pas été marquée vue", () => {
    const cutoff = new Date("2026-10-07T09:00:00.000Z");
    const early = { ...row("a1", "a", 100_000, null, "iPhone 12 128 Go noir"), first_seen_at: new Date(cutoff.getTime() - 1) };
    const atCutoff = { ...row("a2", "a", 90_000, null, "iPhone 12 256 Go blanc"), first_seen_at: cutoff };
    const later = { ...row("a3", "a", 80_000, null, "iPhone 12 512 Go bleu"), first_seen_at: new Date(cutoff.getTime() + 1) };
    const result = selectFreshListings(evaluation([early, atCutoff, later]), new Set(), cutoff);
    assert.deepEqual(ids(result.fresh), ["a3"], "seule la plus récente que la coupure est nouvelle (la coupure est inclusive)");
    assert.deepEqual([...result.existing].sort(), ["a1", "a2"], "les deux autres sont de l'existant : marquées vues sans notification");
    assert.deepEqual(ids(selectFreshListings(evaluation([early, atCutoff, later]), new Set(), null).fresh), ["a1", "a2", "a3"], "sans coupure, rien n'est écarté");
  });

  test("A2 : un groupe de doublons dont un membre est ancien (avant la coupure) est de l'existant en entier", () => {
    const cutoff = new Date("2026-10-07T09:00:00.000Z");
    const old = { ...row("a1", "a", 102_000, "g", "iPhone 12 128 Go noir"), first_seen_at: new Date(cutoff.getTime() - 3_600_000) };
    const recent = { ...row("b1", "b", 100_000, "g", "iPhone 12 128 Go noir"), first_seen_at: new Date(cutoff.getTime() + 3_600_000) };
    const result = selectFreshListings(evaluation([old, recent]), new Set(), cutoff);
    assert.deepEqual(result.fresh, []);
    assert.deepEqual([...result.existing].sort(), ["a1", "b1"]);
  });

  test("deux annonces nouvelles et distinctes sont toutes deux à notifier ; une annonce déjà vue ne l'est pas", () => {
    const rows = [row("a1", "a", 100_000, null, "iPhone 12 128 Go noir"), row("a2", "a", 90_000, null, "iPhone 12 256 Go blanc")];
    assert.deepEqual(ids(selectFreshListings(evaluation(rows), new Set()).fresh), ["a1", "a2"]);
    assert.deepEqual(ids(selectFreshListings(evaluation(rows), new Set(["a1"])).fresh), ["a2"]);
  });
});

describe("contenu des notifications d'annonces d'autres sites (liste blanche)", () => {
  test("titre nettoyé : un titre sain est gardé, un texte qui ressemble à un numéro, trop chargé en chiffres ou fait de caractères de contrôle est remplacé, jamais une adresse", () => {
    assert.equal(buildExternalNotificationTitle("iPhone 12 128 Go violet"), "iPhone 12 128 Go violet");
    assert.equal(buildExternalNotificationTitle("  iPhone   12\n128 Go  "), "iPhone 12 128 Go");
    for (const unsafe of ["Appelez le 07 08 09 10 11", "iPhone 12 0708091011", "iPhone\u202e12", "iPhone\u0000 12", "   ", "ref 1234567890123456"]) assert.equal(buildExternalNotificationTitle(unsafe), EXTERNAL_TITLE_FALLBACK, JSON.stringify(unsafe));
    assert.equal(buildExternalNotificationTitle(null), EXTERNAL_TITLE_FALLBACK);
    assert.equal(buildExternalNotificationTitle(undefined), EXTERNAL_TITLE_FALLBACK);
    const long = buildExternalNotificationTitle(`iPhone ${"x".repeat(300)}`);
    assert.ok(long.length <= EXTERNAL_TITLE_MAX_LENGTH && long.endsWith("…"));
  });

  test("nom de la source : nettoyé de la même façon, « un autre site » s'il est refusé", () => {
    assert.equal(buildExternalSourceName("Annonces Démo A"), "Annonces Démo A");
    for (const unsafe of ["07 08 09 10 11", "Source\u202e", "", "x".repeat(81)]) assert.equal(buildExternalSourceName(unsafe), EXTERNAL_SOURCE_FALLBACK, JSON.stringify(unsafe));
    assert.equal(buildExternalSourceName(null), EXTERNAL_SOURCE_FALLBACK);
  });

  test("contenu d'un envoi externe : titre, prix, lien vers la page du BESOIN ; aucune autre clé", () => {
    const demandId = "22222222-2222-4222-8222-222222222222";
    const content = buildExternalDeliveryContent({ title: "iPhone 12", price: { amount: 139_000, currency: "XOF" }, demandId });
    assert.deepEqual(content, { title: "iPhone 12", price: { amount: 139_000, currency: "XOF" }, link: `/besoins/${demandId}` });
    assert.deepEqual(Object.keys(content).sort(), ["link", "price", "title"]);
  });
});

describe("DTO de l'état : liste blanche, prix provisoire, crédits payés, aucun renouvellement", () => {
  const state: ActiveSearchState = {
    demandId: "22222222-2222-4222-8222-222222222222", demandStatus: "active", active: true, suspended: false, accelerationPending: false, startsAt: NOW, endsAt: new Date(NOW.getTime() + 30 * DAY), remainingDays: 30, purchasedPeriods: 1,
    nextEndsAt: new Date(NOW.getTime() + 60 * DAY), canPurchase: true, blockedReason: null, maxEndsAt: new Date(NOW.getTime() + 180 * DAY), expiringSoon: false, priceXof: 2_000, durationDays: 30,
    balanceXof: 5_000, readAt: NOW,
  };

  test("clés exactes ; jamais d'identifiant d'achat, de transaction ou de compte", () => {
    const dto = activeSearchStateDto(state);
    assert.deepEqual(Object.keys(dto).sort(), [
      "accelerationPending", "active", "autoRenew", "balanceXof", "blockedReason", "canPurchase", "contractVersion", "demandId", "demandStatus", "durationDays", "endsAt", "expiringSoon", "maxEndsAt", "nextEndsAt",
      "paidCreditsOnly", "priceProvisional", "priceXof", "purchasedPeriods", "readAt", "remainingDays", "startsAt", "suspended",
    ]);
    assert.equal(dto.priceProvisional, true);
    assert.equal(dto.paidCreditsOnly, true);
    assert.equal(dto.autoRenew, false);
    assert.equal(JSON.stringify(dto).includes("transaction"), false);
  });
});

describe("code : étape du worker, crédits payés, entretien sans attente, aucune adresse externe", () => {
  test("l'étape « activeSearch » vient APRÈS « collect » et dans son propre try, avec un code d'erreur stable", () => {
    const runner = strip(read("lib/server/matching/runner.ts"));
    const collect = runner.indexOf("await runCollectStep(");
    const search = runner.indexOf("await runActiveSearchStep(");
    assert.ok(collect > 0 && search > collect, "runActiveSearchStep est appelé après runCollectStep");
    const before = runner.slice(collect, search);
    assert.match(before, /catch \(error\) \{[^}]*collect_error_/, "la collecte a son propre catch");
    const block = runner.slice(runner.lastIndexOf("try {", search), runner.indexOf("return {", search));
    assert.match(block, /catch \(error\) \{\s*errors\.push\(`active_search_error_\$\{errorCodeOf\(error\)\}`\)/, "l'étape a son propre try/catch avec son code");
    assert.match(runner, /activeSearchWork\(activeSearch\) === 0/, "l'étape compte dans « au repos »");
  });

  test("l'achat n'écrit que le compte de l'acheteur (crédits PAYÉS) et celui des revenus de la recherche active : jamais le sous-compte promotionnel", () => {
    const purchase = strip(read("lib/server/active-search/purchase.ts"));
    const refund = strip(read("lib/server/active-search/refund.ts"));
    assert.equal(/user_promo/.test(purchase), false);
    assert.equal(/user_promo/.test(refund), false);
    const accounts = [...purchase.matchAll(/account: \{ kind: "([a-z_]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(accounts, ["active_search_revenue", "user"]);
    assert.match(purchase, /kind: "search_purchase"/);
    assert.match(refund, /kind: "search_refund"/);
  });

  test("migration : le garde des comptes promotionnels n'admet AUCUN type de recherche active", () => {
    const sql = read("database/migrations/0028_active_search.sql");
    const guard = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION wallet_guard_account_usage"), sql.indexOf("-- ───────────── 2."));
    const promoBranches = guard.slice(guard.indexOf("WHEN 'user_promo'"), guard.indexOf("WHEN 'subscription_revenue'"));
    assert.equal(/search_/.test(promoBranches), false, "ni search_purchase ni search_refund sur un compte promotionnel");
    assert.match(guard, /WHEN 'active_search_revenue' THEN\s+\(transaction_kind = 'search_purchase' AND NEW\.amount > 0\) OR \(transaction_kind = 'search_refund' AND NEW\.amount < 0\)/);
  });

  test("migration 0028 (RA1-bis) : arrêt final, avis final, période et propriétaire contrôlés à l'insertion, relevé cohérent, chaîne contiguë en SQL, accélération avec valeurs de base", () => {
    const sql = read("database/migrations/0028_active_search.sql");
    assert.match(sql, /stop_reason IN \('demand_archived', 'refunded'\)/, "un besoin satisfait ne s'arrête plus : seul l'archivage ou le remboursement");
    assert.equal(/demand_satisfied/.test(sql), false);
    assert.match(sql, /active_search_stop_final/, "M1 : la raison et la date d'arrêt sont figées dès que l'ancien statut n'est plus actif");
    assert.match(sql, /active_search_notice_final/, "M1 : l'avis envoyé ne change plus (NULL vers une valeur seulement)");
    assert.match(sql, /active_search_purchase_period_mismatch/, "M6 : fin = début + durée");
    assert.match(sql, /active_search_purchase_owner_mismatch/, "M6 : acheteur = propriétaire du besoin");
    assert.match(sql, /chk_active_search_state_baseline CHECK \(baseline_pending = \(baseline_taken_at IS NULL\) AND baseline_pending = \(baseline_cutoff_at IS NULL\)\)/);
    assert.match(sql, /FUNCTION active_search_chain_end\(p_purchase UUID\)/, "M3 : la fin de la chaîne se lit en SQL (avis d'échéance)");
    assert.match(sql, /accelerated BOOLEAN NOT NULL DEFAULT FALSE/);
    assert.match(sql, /base_frequency_seconds/);
    assert.match(sql, /accelerated_requests/, "A5 : requêtes accélérées comptées par source et par jour");
  });

  test("entretien : aucune instruction n'attend un verrou (SKIP LOCKED), aucune connexion dédiée", () => {
    const maintenance = strip(read("lib/server/active-search/maintenance.ts"));
    assert.ok((maintenance.match(/SKIP LOCKED/g) ?? []).length >= 4, "fins, arrêts, retour du suivi et avis");
    assert.equal(/\.connect\(/.test(maintenance), false);
    const step = strip(read("lib/server/active-search/step.ts"));
    assert.equal(/\.connect\(/.test(step), false, "l'étape n'ouvre pas de connexion dédiée");
  });

  test("balayage : un verrou tenté jamais attendu, lock_timeout, une transaction par besoin, aucune adresse d'annonce externe dans les notifications", () => {
    const notify = strip(read("lib/server/active-search/notify.ts"));
    assert.match(notify, /pg_try_advisory_xact_lock\(\$1::int, hashtext\(\$2\)\)/);
    assert.match(notify, /SET LOCAL lock_timeout/);
    assert.equal(/canonical_url|\.url\b|listing\.url/.test(notify), false, "aucune URL externe n'est lue ni écrite par le balayage");
    assert.match(notify, /buildExternalDeliveryContent\(\{ title, price, demandId: demand\.id \}\)/);
    const content = strip(read("lib/server/notifications/content.ts"));
    assert.match(content, /link: demandLink\(input\.demandId\)/, "le lien d'un envoi externe est la page du besoin");
  });

  test("le suivi du besoin ne dépasse 90 jours que pendant l'option (180) : le plafond vient de trackingMaxDaysFor", () => {
    const tracking = strip(read("lib/server/notifications/tracking.ts"));
    assert.match(tracking, /trackingMaxDaysFor\(/);
    assert.equal(/TRACKING_MAX_DAYS/.test(tracking), false, "plus de plafond fixe dans le suivi");
  });

  test("scripts : refund, simulate et les essais du lot sont déclarés ; le simulateur garde la base d'essai", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    assert.match(scripts["active-search:refund"], /scripts\/active-search-refund\.ts/);
    assert.match(scripts["active-search:simulate"], /scripts\/active-search-simulate\.ts/);
    assert.match(scripts["test:active-search"], /tests\/postgres\/active-search\.integration\.test\.ts/);
    assert.match(scripts["test:active-search"], /tests\/server\/active-search\.test\.ts/);
    assert.match(scripts["test:active-search-client"], /tests\/client\/active-search-api\.test\.ts/);
    const simulate = strip(read("scripts/active-search-simulate.ts"));
    assert.match(simulate, /checkDemoSeedEnvironment\(process\.env\)/);
    assert.ok(simulate.indexOf("checkDemoSeedEnvironment") < simulate.indexOf("simulateNewExternalListing("), "le garde-fou passe avant toute écriture");
  });
});

describe("places de collecte accélérée et plafond par compte (lot RA1-ter)", () => {
  test("plafond de deux clés produit distinctes par acheteur : une clé déjà suivie n'ajoute rien, une troisième clé est refusée", () => {
    assert.equal(ACTIVE_SEARCH_MAX_ACCELERATED_KEYS_PER_USER, 2);
    assert.equal(userCapAllows(new Set(), "a"), true);
    assert.equal(userCapAllows(new Set(["a"]), "b"), true);
    assert.equal(userCapAllows(new Set(["a", "b"]), "a"), true, "prolonger une clé déjà suivie");
    assert.equal(userCapAllows(new Set(["a", "b"]), "c"), false, "troisième produit");
    assert.equal(userCapAllows(new Set(["a", "b", "c"]), "a"), false, "au-delà du plafond (réactivation, modification) : la prolongation est refusée aussi");
  });

  test("migration 0029 : une table de places par clé produit, sans clé étrangère (verrou global jamais en attente d'un verrou de ligne du besoin)", () => {
    const sql = strip(read("database/migrations/0029_active_search_places.sql").replace(/^--.*$/gm, ""));
    assert.match(sql, /CREATE TABLE active_search_places \(\s*product_key TEXT PRIMARY KEY CHECK \(char_length\(product_key\) BETWEEN 3 AND 600\)/);
    assert.equal(/REFERENCES/.test(sql), false, "aucune clé étrangère vers demands ou users");
    assert.match(sql, /idx_active_search_places_user/);
    assert.equal((sql.match(/CREATE TABLE/g) ?? []).length, 1, "additive : une seule table");
    assert.equal(/ALTER TABLE|DROP /.test(sql), false, "aucune modification d'une table existante");
  });

  test("une seule fonction écrit les places (places.ts) ; achat, changement de besoin et cycle de collecte l'appellent ; la lecture des clés accélérées vient des places", () => {
    const writers: string[] = [];
    for (const file of ["lib/server/active-search/places.ts", "lib/server/active-search/places-run.ts", "lib/server/active-search/purchase.ts", "lib/server/active-search/maintenance.ts", "lib/server/active-search/notify.ts",
      "lib/server/active-search/refund.ts", "lib/server/active-search/state.ts", "lib/server/external/watches.ts", "lib/server/external/collect.ts", "lib/server/catalog/demands.ts"]) {
      if (/(INSERT INTO|DELETE FROM|UPDATE) active_search_places/.test(strip(read(file)))) writers.push(file);
    }
    assert.deepEqual(writers, ["lib/server/active-search/places.ts"], "UNE seule fonction écrit la table des places");
    const purchase = strip(read("lib/server/active-search/purchase.ts"));
    assert.equal((purchase.match(/reconcileAcceleratedPlaces\(/g) ?? []).length, 2, "avant le contrôle d'admission, puis après l'écriture de l'achat");
    assert.match(purchase, /userCapAllows\(/, "plafond par compte contrôlé pour l'activation comme pour la prolongation");
    assert.equal(/if \(!extension\) \{[^}]*userCapAllows/.test(purchase), false, "le plafond ne dépend pas du genre d'achat");
    const demands = strip(read("lib/server/catalog/demands.ts"));
    assert.equal((demands.match(/reconcilePlacesAfterDemandChange\(/g) ?? []).length, 2, "modification d'un besoin et transition de statut (réactivation, satisfait)");
    assert.match(strip(read("lib/server/external/collect.ts")), /reconcilePlacesForCycle\(/);
    assert.match(strip(read("lib/server/external/watches.ts")), /const boosted = await readAcceleratedKeys\(/, "seules les clés avec une place accélèrent une surveillance");
    assert.match(strip(read("lib/server/active-search/places-run.ts")), /SAVEPOINT active_search_places/, "un changement de besoin ne fait jamais échouer à cause de l'accélération");
  });

  test("la recherche active est absente (jamais une erreur SQL) tant que la migration 0029 manque", () => {
    assert.match(strip(read("lib/server/active-search/state.ts")), /to_regclass\('active_search_places'\) IS NOT NULL/);
    assert.match(strip(read("lib/server/active-search/purchase.ts")), /activeSearchSchemaPresent\(client\)\)\) throw new ActiveSearchError\("unavailable"\)/);
  });
});
