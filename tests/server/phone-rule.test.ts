import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ATTRIBUTE_KEY_MESSAGE,
  IVORIAN_PREFIXES,
  OFFER_TEXT_FIELDS,
  countDigits,
  isValidNestedAttributeKey,
  isValidOfferAttributeKey,
  looksLikePhoneNumber,
  phoneInOfferMessage,
  PHONE_IN_OFFER_MESSAGE,
} from "../../lib/phone-text";
import { CatalogAttributeKeyError, CatalogPhoneNumberError } from "../../lib/server/catalog/errors";
import { findPhoneNumberField, requireNoPhoneInOfferFields } from "../../lib/server/catalog/validation";

/**
 * Lot D3, point 1 : la règle des numéros de téléphone réécrite autour des numéros ivoiriens et internationaux EXPLICITES (`lib/phone-text.ts`).
 * Corpus : la liste complète de l'audit dans les deux sens, 60 textes réalistes du marché ivoirien et 30 listes de modèles compatibles, de tailles et de capacités qui DOIVENT passer, 47 déguisements qui DOIVENT être refusés,
 * chaque règle (a) à (d) et chaque exclusion, la normalisation (alphabets, sosies, invisibles), des essais à données tirées au sort (graine fixe).
 */

const numbers = (texts: readonly string[]): void => {
  for (const text of texts) assert.equal(looksLikePhoneNumber(text), true, `« ${text} » doit être tenu pour un numéro`);
};
const notNumbers = (texts: readonly string[]): void => {
  for (const text of texts) assert.equal(looksLikePhoneNumber(text), false, `« ${text} » ne doit pas être tenu pour un numéro`);
};

describe("liste de l'audit : contournements acceptés (refusés désormais) et faux refus (acceptés désormais)", () => {
  test("contournements : lettre O, « O7 O8 O9 l0 ll », O cyrillique, « 07x08x09x10x11 », clé « tel_0708 »", () => {
    numbers([
      "07 O8 09 10 11",
      "O7 O8 O9 l0 ll",
      "07 О8 09 10 11",
      "07 о8 09 10 11",
      "07x08x09x10x11",
      "07X08X09X10X11",
    ]);
    // La clé « tel_0708 » (chiffres dans un nom d'attribut) est refusée à la publication, quelle que soit la valeur.
    assert.throws(() => requireNoPhoneInOfferFields({ attributes: { tel_0708: "09 10 11" } }), CatalogAttributeKeyError);
  });

  test("faux refus : dimensions, quantités à milliers, références, numéro de série, facture, EAN, IMEI, référence de pièce", () => {
    notNumbers([
      "2400×1080",
      "3840×2160",
      "12 500 000 FCFA",
      "12.500.000 F CFA",
      "Réf. 9300-1234",
      "S/N 12345678",
      "Facture n° 00012345",
      "4006381333931",
      "IMEI 3521 0987 654",
      "Réf pièce 0010 2233 44",
    ]);
  });
});

/** 60 textes de vendeurs ivoiriens, tels qu'ils figurent dans une variante, un modèle, une localisation ou un attribut : AUCUN ne doit être refusé. */
const REALISTIC = [
  // téléphones
  "iPhone 13 Pro Max 256 Go bleu sierra",
  "Samsung Galaxy A54 5G 8 Go 128 Go",
  "Tecno Spark 10 Pro 8+256 Go",
  "Infinix Note 30 12/256 Go batterie 5000 mAh",
  "Xiaomi Redmi Note 12 Pro 5G 6,67 pouces 120 Hz",
  "Itel A60s 4G 2/32 Go",
  "iPhone 11 64 Go batterie 87 % face ID OK",
  "Samsung Galaxy S23 Ultra 12 Go / 512 Go, 200 MP",
  "Huawei P30 Lite 4 Go 128 Go double SIM",
  "Oppo Reno 8 Pro 12 Go 256 Go charge 80 W",
  "Google Pixel 7 128 Go débloqué",
  "Nokia 3310 2017 neuf en boîte",
  // ordinateurs
  "HP Pavilion 15-eg2000nk i5-1235U 8 Go 512 Go SSD",
  "Dell Latitude 7420 i7-1185G7 16 Go 512 Go",
  "MacBook Pro 14 pouces M1 Pro 16 Go 1 To 2021",
  "Lenovo ThinkPad T480 i5 8e génération 8 Go 256 Go",
  "Asus Vivobook 15 Ryzen 5 5500U 16 Go 512 Go",
  "iMac 24 pouces M1 8 Go 256 Go 2021",
  "PC de bureau i7 10700 32 Go RAM 1 To SSD RTX 3060 12 Go",
  "Écran Dell 27 pouces 2560x1440 75 Hz",
  "Imprimante HP LaserJet Pro M404dn 38 ppm",
  "Disque dur externe 2 To USB 3.0 7200 tr/min",
  // télévisions
  "TV Samsung 55 pouces 4K UHD Smart TV 2022",
  "LG OLED 65 pouces C1 120 Hz HDMI 2.1",
  "Hisense 43 pouces Full HD 1920x1080 garantie 12 mois",
  "TCL 50 pouces 4K 3840×2160 Android TV",
  "Sony Bravia 32 pouces HD 1366x768",
  "Décodeur Canal+ HD avec abonnement 2 mois",
  "Home cinéma 5.1 600 W Bluetooth HDMI",
  "Support mural TV 32 à 65 pouces 400x400",
  // électroménager
  "Réfrigérateur Samsung 2 portes 380 L no frost",
  "Congélateur coffre 300 L Hisense A+",
  "Machine à laver LG 9 kg chargement frontal 1400 tr/min",
  "Climatiseur Split 2 CV 18000 BTU Midea",
  "Climatiseur 1,5 CV 12000 BTU 220 V garantie 24 mois",
  "Cuisinière 4 feux gaz + four 60x60 cm",
  "Micro-ondes Samsung 28 L 900 W",
  "Ventilateur sur pied 45 cm 3 vitesses 60 W",
  "Bouilloire électrique 1,7 L 2200 W inox",
  "Mixeur Moulinex 600 W bol 1,5 L",
  "Fer à repasser Philips 2400 W vapeur",
  "Chauffe-eau électrique 50 L 1500 W",
  // motos
  "Honda CG 125 de 2018, 45 000 km, papiers à jour",
  "Yamaha Crypton 110 cc année 2020 très économique",
  "Apsonic 150 cc 2019 carte grise OK",
  "Boxer 100 neuve de 2023, 2 casques offerts",
  "Scooter Piaggio Liberty 125 2017 12 000 km",
  "TVS Apache 160 RTR 2021 kilométrage 18 500",
  "Haojue 125 cc 2022 prix à débattre",
  "Moto Sanya 125 cc, 4 temps, démarrage électrique",
  "Bajaj Pulsar 150 2020 pneus neufs 90/90-17",
  // pièces
  "Batterie 12 V 70 Ah pour voiture",
  "Pneu 205/55 R16 neuf, la paire",
  "Plaquettes de frein avant Toyota Corolla 2008-2014",
  "Alternateur Peugeot 206 1.4 essence 2003",
  "Écran iPhone 12 Pro Max original, garantie 3 mois",
  "Chargeur MacBook MagSafe 2 85 W",
  "Filtre à huile Toyota Hilux 2.5 D4D 2012-2016",
  "Amortisseur arrière Kia Picanto 2011 la paire",
  "Batterie Lenovo ThinkPad T480 48 Wh réf. 01AV421",
];

/** Localisations réalistes (en plus des 60 textes) : elles passent aussi. */
const LOCATIONS = ["Cocody, Riviera Palmeraie, rue 12, villa 25", "BP 1234 Abidjan 01", "Marcory Zone 4, rue 12", "Yopougon Siporex, lot 25 îlot 7"];

describe("60 textes réalistes du marché ivoirien : aucun faux refus", () => {
  test("il y en a bien 60 et aucun n'est tenu pour un numéro, ni seul ni comme valeur d'un champ de l'annonce", () => {
    assert.equal(REALISTIC.length, 60);
    assert.equal(new Set(REALISTIC).size, 60);
    notNumbers(REALISTIC);
    notNumbers(LOCATIONS);
    for (const text of [...REALISTIC, ...LOCATIONS]) {
      assert.doesNotThrow(() => requireNoPhoneInOfferFields({ variant: text, model: text, location: text, attributes: { description_courte: text } }), text);
    }
  });
});

/** 30 listes réalistes de modèles compatibles, de tailles, de pointures et de capacités (lot D3-bis) : AUCUNE ne doit être refusée (quatre nombres de deux chiffres à la suite, avec ou sans lettres, ne sont plus un numéro). */
const COMPAT_LISTS = [
  "Coque compatible iPhone 11 12 13 14",
  "TV 32 40 43 50 pouces",
  "Galaxy S21 S22 S23 S24",
  "Compatible iPhone 11, 12, 13, 14 Pro",
  "Chargeur pour Samsung A10 A20 A30 A50",
  "Écrans 24 27 32 34 pouces",
  "Onduleur 12 V 24 V 48 V 96 V",
  "Lot de 12 24 36 48 piles",
  "tailles 38 40 42 44",
  "24h 48h 72h 96h",
  "du 01/10 au 15/10",
  "Verre trempé iPhone 12 13 14 15",
  "Pointures 39 40 41 42 43 44",
  "Écran 32 43 50 55 pouces",
  "Compatible Samsung Galaxy A12 A13 A32 A52",
  "Capacités 16 32 64 128 Go",
  "Stockage 64 128 256 512 Go",
  "Batteries 12 V 24 V 36 V 48 V",
  "Pneus 14 15 16 17 pouces",
  "Climatiseurs 9000 12000 18000 24000 BTU",
  "Disponible en 38, 40, 42, 44, 46",
  "Compatible Redmi Note 10 11 12 13",
  "Pack de 10 20 30 40 vis",
  "Tailles 36 38 40 42 (femme)",
  "Fréquences 24 48 72 96 Hz",
  "Câble compatible iPad 10 11 12 13 pouces",
  "Piles 11 12 13 14 mm",
  "Voltages 12 24 48 60 V",
  "Tablettes 8 10 12 14 pouces",
  "Couverts 12 18 24 36 pièces",
];

describe("30 listes de modèles compatibles, de tailles et de capacités : aucun faux refus (lot D3-bis)", () => {
  test("les 30 listes passent, seules et comme valeur d'un champ de l'annonce", () => {
    assert.equal(COMPAT_LISTS.length, 30);
    assert.equal(new Set(COMPAT_LISTS).size, 30);
    notNumbers(COMPAT_LISTS);
    for (const text of COMPAT_LISTS) {
      assert.doesNotThrow(() => requireNoPhoneInOfferFields({ variant: text, model: text, location: text, attributes: { compatibilite: text } }), text);
    }
  });

  test("les cas de la revérification : refusés en fonction pure ET en exécution avant, acceptés maintenant ; 07 08 09 10 et les formes à dix chiffres restent refusés", () => {
    notNumbers(["Coque compatible iPhone 11 12 13 14", "TV 32 40 43 50 pouces", "Galaxy S21 S22 S23 S24"]);
    numbers(["07 08 09 10", "07 08 09 10 11", "0708091011", "+225 07 08 09 10 11", "07x08x09x10x11", "07 puis 08 puis 09 puis 10 puis 11"]);
  });
});

/** 47 déguisements d'un même numéro ivoirien (07 08 09 10 11) ou d'un numéro voisin : TOUS doivent être refusés. */
const DISGUISES = [
  "07 08 09 10 11",
  "0708091011",
  "07-08-09-10-11",
  "07.08.09.10.11",
  "07/08/09/10/11",
  "07_08_09_10_11",
  "07,08,09,10,11",
  "07 | 08 | 09 | 10 | 11",
  "07🙂08🙂09🙂10🙂11",
  "0 7 0 8 0 9 1 0 1 1",
  "+225 07 08 09 10 11",
  "+2250708091011",
  "(+225) 0708 091 011",
  "00225 07 08 09 10 11",
  "225 0708091011",
  "225 07 08 09 10",
  "WhatsApp : 07 08 09 10 11",
  "Appelez 05 04 03 02 01 après 18h",
  "01 05 04 03 02",
  "21 35 12 34 56",
  "27 22 44 55 66",
  "07 O8 09 10 11",
  "O7 O8 O9 l0 ll",
  "07 О8 09 1О 11",
  "Ο7 Ο8 Ο9 l0 ll",
  "07 08 09 lO 11",
  "0l 05 04 03 02",
  "07x08x09x10x11",
  "07 puis 08 puis 09 puis 10 puis 11",
  "07 et 08 et 09 et 10 et 11",
  "07o08o09o10o11",
  "０７ ０８ ０９ １０ １１",
  "٠٧ ٠٨ ٠٩ ١٠ ١١",
  "०७ ०८ ०९ १० ११",
  "𝟎𝟕 𝟎𝟖 𝟎𝟗 𝟏𝟎 𝟏𝟏",
  "0️⃣7️⃣0️⃣8️⃣0️⃣9️⃣1️⃣0️⃣1️⃣1️⃣",
  "07​08​09​10​11",
  "0­7­0­8­0­9­1­0­1­1",
  "+33 6 12 34 56 78",
  "06 12 34 56 78",
  "07 12 puis 34 56 78",
  "225 070 809 1011",
  "+33 612 345 678",
  "+1 234 567 8901",
  "0 708 091 011",
  "07 08 09 10",
  "07 · 08 · 09 · 10",
];

describe("déguisements : refusés", () => {
  test("47 déguisements (au moins 41 exigés), tous refusés (alphabets, sosies, séparateurs, lettres, indicatifs, invisibles, numéros écrits en milliers)", () => {
    assert.ok(DISGUISES.length >= 41);
    assert.equal(new Set(DISGUISES).size, DISGUISES.length);
    numbers(DISGUISES);
    for (const text of DISGUISES) assert.notEqual(findPhoneNumberField({ variant: text }), null, text);
  });
});

describe("règles (a) à (d)", () => {
  test("(a) dix chiffres d'un numéro ivoirien, groupes et séparateurs quelconques ; le premier groupe est 01, 05, 07, 21, 25 ou 27", () => {
    assert.deepEqual([...IVORIAN_PREFIXES], ["01", "05", "07", "21", "25", "27"]);
    for (const prefix of IVORIAN_PREFIXES) {
      const digits = `${prefix}12345678`;
      numbers([digits, `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 6)} ${digits.slice(6, 8)} ${digits.slice(8)}`, `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`, `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`, `${digits.slice(0, 5)}/${digits.slice(5)}`]);
    }
    // Dix chiffres qui ne commencent pas par un de ces préfixes : pas un numéro ivoirien (ni international, ni quatre groupes de deux).
    notNumbers(["0012345678", "1234567890", "0312345678", "0912345678", "2212345678", "3012345678"]);
    numbers(["0 7 0 8 0 9 1 0 1 1", "0708 091 011", "070 809 1011", "07 0809 1011"]);
  });

  test("(b) indicatif 00225 ou « 225 » suivi de 8 ou 10 chiffres", () => {
    numbers(["225 07 08 09 10", "225 0708091011", "2250708091011", "22507080910", "00225 07 08 09 10", "00225 0708091011", "002250708091011", "00 225 07 08 09 10 11"]);
    // Un « 225 » suivi d'un autre nombre de chiffres n'est pas un indicatif de numéro.
    notNumbers(["225 000", "225 1234567", "225 123456789", "Prix 225 000", "225", "2250"]);
  });

  test("(c) « + » suivi de 8 à 15 chiffres : international", () => {
    numbers(["+33 6 12 34 56 78", "+1 (555) 123-4567", "+12345678", "+123456789012345", "+ 12345678", "+(225) 07 08 09 10 11", "tel +221 77 123 45 67"]);
    notNumbers(["+1234567", "Batterie +10000 mAh", "+128 Go", "S21+ 128 Go", "+1234567890123456"]);
  });

  test("(d') quatre groupes de DEUX chiffres exactement, séparés seulement par des symboles ou des espaces, le premier commençant par 0 (lot D3-bis)", () => {
    numbers(["07 08 09 10", "07-08-09-10-11", "01 02 03 04", "06 12 34 56 78", "09.87.65.43", "05 10 15 20", "07/08/09/10", "07 · 08 · 09 · 10", "07×08×09×10"]);
    // Le premier groupe ne commence pas par 0 : une liste de nombres, pas un numéro.
    notNumbers(["12 34 56 78", "98.76.54.32", "10 20 30 40 50", "11 12 13 14", "32 40 43 50", "38 40 42 44", "24 27 32 34", "12 24 36 48"]);
    // Moins de quatre groupes, ou un groupe qui n'a pas exactement deux chiffres.
    notNumbers(["07 08 09", "12 34 56", "07 08 09 1", "07 08 09 123", "07 08 009 10", "0708 09 10", "1 23 45 67 8"]);
  });

  test("(d') les lettres et les mots ne séparent des groupes que pour (a), (b) et (c) : huit chiffres avec des lettres ne sont pas un numéro, dix chiffres ivoiriens le sont", () => {
    notNumbers(["07x08x09x10", "07 x 08 x 09 x 10", "07 puis 08 et 09 puis 10", "07 et 08 et 09 et 10", "06 12 puis 34 56 78", "07h08h09h10", "01 et 02 et 03 et 04"]);
    numbers(["07x08x09x10x11", "07 puis 08 puis 09 puis 10 puis 11", "07 x 08 x 09 x 10 x 11", "07 et 08 et 09 et 10 et 11", "25 puis 12 puis 34 puis 56 puis 78"]);
  });

  test("les séparateurs : au plus 3 caractères entre deux groupes (limite assumée)", () => {
    numbers(["07 . 08 . 09 . 10 . 11", "07 - 08 - 09 - 10 - 11"]);
    notNumbers(["07 .... 08 .... 09 .... 10 .... 11", "07 .. 08 .. 09 .. 10 .. 11"]);
  });
});

describe("exclusions : ce qui n'est PAS un numéro", () => {
  test("milliers groupés par 3 : « 12 500 000 », « 12.500.000 », fourchettes « 25 000 - 27 000 » (premier groupe de 1 à 3 chiffres sans zéro initial)", () => {
    notNumbers([
      "12 500 000",
      "12.500.000",
      "12,500,000",
      "2 500 000 000",
      "25 000 - 27 000",
      "25 000 – 27 000",
      "21 500 - 27 000 FCFA",
      "25 000 27 000",
      "1 250 000 000",
      "225 000 000",
    ]);
    // Lot D3-bis : chaque quantité est neutralisée comme un jeton AVANT les règles ; deux quantités ne se fusionnent jamais en un numéro (préfixes 21x, 25x, 27x compris).
    notNumbers([
      "250 000 - 1 300 000",
      "Prix 1 250 000 - 1 300 000 FCFA",
      "250 000 – 1 300 000 FCFA",
      "210 000 - 1 250 000",
      "1 210 000 - 1 270 000",
      "270 000 - 1 250 000 - 2 100 000",
      "Budget : de 250 000 à 1 300 000 FCFA",
      "1 250 000 FCFA, 1 300 000 FCFA",
      "2 710 000 2 750 000",
      "250 000 / 1 300 000",
      "Prix 125 000 250 000",
    ]);
    // Un numéro dont les groupes ressemblent à des milliers reste un numéro quand il commence par zéro, qu'un « + » le précède, ou qu'un groupe qui n'est pas une quantité s'y colle.
    numbers(["0 708 091 011", "07 080 910 11", "070 809 1011", "27 123 456 78", "225 070 809 1011", "+33 612 345 678", "+1 234 567 8901", "+12 500 000"]);
  });

  test("dimension A×B, A*B, AxB à 2 ou 3 termes : chaque terme est contrôlé seul ; à quatre termes ou plus, c'est un numéro", () => {
    notNumbers(["2400×1080", "2400 × 1080", "3840*2160", "1920x1080", "2560×1440 60 Hz", "07080×91011", "12,50x12,50x12,50 cm", "210×297×10 mm", "10x15x20 cm", "2,4x1,08 m", "07×08×09", "07x08x09"]);
    numbers(["07×08×09×10", "07*08*09*10*11", "07x08x09x10x11", "07 × 08 × 09 × 10 × 11"]);
    notNumbers(["07x08x09x10", "10x15x20x30 cm", "12×24×36×48"]);
  });

  test("référence, numéro de série, facture, EAN, IMEI, année, date, heure : aucune règle ne les couvre", () => {
    notNumbers([
      "Réf. 9300-1234",
      "S/N 12345678",
      "Facture n° 00012345",
      "N° de série 987654321",
      "4006381333931",
      "5901234123457",
      "EAN 4006381333931",
      "IMEI 3521 0987 654",
      "IMEI 35 210987 654321 5",
      "Réf pièce 0010 2233 44",
      "Réf 4006 3813 3393 1",
      "00012345678",
      "07080910111",
      "2026-10-06",
      "06/10/2026",
      "12/10/2024 14:30",
      "14:30",
      "2015-2018",
      "2008-2014",
      "modèles 2019 2020 2021 2022",
    ]);
  });

  test("une suite de 11 à 14 chiffres sans indicatif n'est pas un numéro ; avec l'indicatif 225 elle en est un (et un nombre à 8 ou 10 chiffres derrière)", () => {
    notNumbers(["12345678901", "123456789012", "1234567890123", "12345678901234"]);
    numbers(["22512345678", "2251234567890"]);
  });
});

describe("normalisation : alphabets, sosies, invisibles", () => {
  /** Chiffres zéro de nombreux alphabets (début d'une série de dix chiffres décimaux). */
  const ZEROS: Record<string, number> = {
    "arabes-indiens": 0x0660,
    "arabes-indiens orientaux": 0x06f0,
    "n'ko": 0x07c0,
    "dévanagari": 0x0966,
    "bengali": 0x09e6,
    "gurmukhi": 0x0a66,
    "gujarati": 0x0ae6,
    "oriya": 0x0b66,
    "tamoul": 0x0be6,
    "télougou": 0x0c66,
    "kannada": 0x0ce6,
    "malayalam": 0x0d66,
    "thaï": 0x0e50,
    "lao": 0x0ed0,
    "tibétain": 0x0f20,
    "birman": 0x1040,
    "khmer": 0x17e0,
    "mongol": 0x1810,
    "pleine chasse": 0xff10,
  };
  const spell = (zero: number, text: string): string => [...text].map((digit) => (digit >= "0" && digit <= "9" ? String.fromCodePoint(zero + Number(digit)) : digit)).join("");

  test("chaque alphabet de chiffres est ramené à l'ASCII : « 0708091011 » et « 07 08 09 10 11 » écrits dans cet alphabet sont refusés ; les prix et années du même alphabet passent", () => {
    for (const [name, zero] of Object.entries(ZEROS)) {
      assert.equal(looksLikePhoneNumber(spell(zero, "0708091011")), true, `${name} : collé`);
      assert.equal(looksLikePhoneNumber(spell(zero, "07 08 09 10 11")), true, `${name} : groupé`);
      assert.equal(looksLikePhoneNumber(spell(zero, "2400×1080")), false, `${name} : dimension`);
      assert.equal(looksLikePhoneNumber(spell(zero, "12 500 000")), false, `${name} : milliers`);
      assert.equal(looksLikePhoneNumber(spell(zero, "2015-2018")), false, `${name} : années`);
      assert.equal(countDigits(spell(zero, "0708091011")), 10, `${name} : dix chiffres comptés`);
    }
  });

  test("chaque série de chiffres décimaux Unicode : le bloc compte un multiple de dix chiffres (garantie sur laquelle repose la valeur), et chaque début de série vaut zéro", () => {
    const isNd = (codePoint: number): boolean => /^\p{Nd}$/u.test(String.fromCodePoint(codePoint));
    let blocks = 0;
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      if (!isNd(codePoint) || (codePoint > 0 && isNd(codePoint - 1))) continue;
      let end = codePoint;
      while (isNd(end + 1)) end += 1;
      assert.equal((end - codePoint + 1) % 10, 0, `bloc de chiffres U+${codePoint.toString(16)} : ${end - codePoint + 1} chiffres`);
      // Un bloc entier, écrit comme « 0708091011 » depuis son premier chiffre, est un numéro (la valeur de chaque chiffre est exacte).
      const text = [...("0708091011")].map((digit) => String.fromCodePoint(codePoint + Number(digit))).join("");
      assert.equal(looksLikePhoneNumber(text), true, `bloc U+${codePoint.toString(16)}`);
      blocks += 1;
    }
    assert.ok(blocks >= 60, `${blocks} blocs de chiffres décimaux`);
  });

  test("sosies de chiffres : convertis seulement dans un mot de chiffres et de sosies ; « Olivier », « S21 », « Il », « lol » ne deviennent jamais des chiffres", () => {
    numbers(["O7O8O9l0ll", "07 O8 09 10 11", "O7 O8 O9 l0 ll", "07 08 09 1O 11", "0ı 05 04 03 02", "0Ι 05 04 03 02"]);
    notNumbers([
      "Olivier 07 08 09",
      "Il y a 07 pièces",
      "lol",
      "OO OO OO OO OO",
      "ll ll ll ll ll",
      "Ol lO Ol lO Ol",
      "I/O 2 ports",
      "Galaxy S21 FE 5G 128 Go",
      "Ordinateur I5 8e génération",
      "Jerrican 20l 10l 5l 2l",
      "Fût 10l 20l 30l",
      "Samsung | 128 Go | 2021",
      "Écran | OLED | 6,1 pouces | 128 Go",
    ]);
  });

  test("caractères invisibles et marques combinantes ôtés : espace de largeur nulle, trait d'union conditionnel, sélecteur de variante, cadre de touche d'emoji", () => {
    numbers([
      "07\u200b08\u200b09\u200b10\u200b11",
      "07\u200b\u200b\u200b\u200b\u200b\u200b08\u200b\u200b\u200b\u200b\u200b09\u200b10\u200b11",
      "0\u200d7\u200d0\u200d8\u200d0\u200d9\u200d1\u200d0\u200d1\u200d1",
      "07\u2060 08\u2060 09 10 11",
      "0\u0338708091011",
    ]);
    // Les dingbats numérotés sont lus comme des chiffres : ⓿➆⓿➇⓿➈❶⓿❶❶ = 0708091011.
    numbers(["\u24ff\u2786\u24ff\u2787\u24ff\u2788\u2776\u24ff\u2776\u2776"]);
    // Ces marques invisibles ne rendent pas un texte ordinaire suspect.
    notNumbers(["128\u200b Go", "iPhone\u200b 12", "2400\u200b×1080"]);
  });

  test("lettre séparatrice : seulement une lettre ou un mot seul (8 lettres au plus, une espace de chaque côté au plus) entre deux groupes de 1 ou 2 chiffres, dans une suite d'au moins 4 groupes", () => {
    numbers(["07 x 08 x 09 x 10 x 11", "07 et 08 et 09 et 10 et 11", "07puis08puis09puis10puis11", "07 puis 08 et 09 puis 10 et 11"]);
    // Trois groupes ou moins : la lettre ne sépare rien.
    notNumbers(["07x08x09", "07 et 08 et 09", "10x15 cm", "8x12", "24h 48h"]);
    // Pas un séparateur : un mot de plus de 8 lettres, deux mots, un symbole accolé, un groupe de 3 chiffres ou plus de chaque côté.
    notNumbers(["07 abcdefghi 08 abcdefghi 09 abcdefghi 10", "07 et puis 08 et puis 09 et puis 10 et puis 11", "07x-08x-09x-10x-11", "08h-12h 14h-18h", "070x080x090x101x111", "0708x091011"]);
  });
});

/** Générateur déterministe (mulberry32) : les essais tirés au sort sont reproductibles. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

describe("essais à données tirées au sort (graine fixe)", () => {
  const SYSTEMS = [0x0030, 0x0660, 0x06f0, 0x0966, 0x0e50, 0xff10];
  const SYMBOLS = [" ", ".", "-", "/", ":", ",", "_", " - ", " . ", "#", "·", " • ", "\u{1f642}", "|", "~"];
  const WORDS = ["x", "o", "et", "puis", "X"];

  test("2000 numéros ivoiriens tirés au sort, sous toutes les mises en forme (groupes, séparateurs, alphabets, mots, sosies, indicatif) : tous refusés", () => {
    const random = prng(20261007);
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
    let count = 0;
    for (let index = 0; index < 2000; index += 1) {
      const prefix = pick(IVORIAN_PREFIXES);
      let digits = prefix;
      while (digits.length < 10) digits += String(Math.floor(random() * 10));
      const zero = pick(SYSTEMS);
      const style = index % 5;
      let text: string;
      if (style === 0) {
        // groupes de deux, un séparateur choisi pour tout le numéro
        const separator = pick(SYMBOLS);
        text = digits.match(/../g)!.join(separator);
      } else if (style === 1) {
        // groupes de longueurs quelconques
        const parts: string[] = [];
        let at = 0;
        while (at < 10) {
          const size = 1 + Math.floor(random() * 4);
          parts.push(digits.slice(at, at + size));
          at += size;
        }
        // Lot D3-bis : un numéro écrit en groupes qui forment une quantité à milliers (« 27 776 44 015 2 ») est neutralisé comme une quantité (limite documentée) : le tirage évite les séparateurs de
        // milliers quand un groupe de trois chiffres suit le premier.
        let separator = pick(SYMBOLS);
        if ([" ", ".", ","].includes(separator) && parts.slice(1).some((part) => part.length === 3)) separator = "-";
        text = parts.join(separator);
      } else if (style === 2) {
        // un mot (ou une lettre) entre les groupes de deux
        const word = pick(WORDS);
        text = digits.match(/../g)!.join(random() < 0.5 ? word : ` ${word} `);
      } else if (style === 3) {
        // indicatif
        const code = pick(["+225", "+225 ", "00225", "00225 ", "225 ", "(+225) "]);
        text = `${code}${random() < 0.5 ? digits : digits.match(/../g)!.join(" ")}`;
      } else {
        // sosies de zéro et de un dans un numéro en groupes de deux
        text = digits.match(/../g)!.map((pair) => pair.replace(/0/g, () => pick(["O", "o", "О", "о", "0"])).replace(/1/g, () => pick(["l", "I", "і", "1"]))).join(pick([" ", "-", ".", "/"]));
      }
      text = [...text].map((character) => (character >= "0" && character <= "9" ? String.fromCodePoint(zero + Number(character)) : character)).join("");
      assert.equal(looksLikePhoneNumber(text), true, `essai ${index} : « ${text} » (${digits})`);
      count += 1;
    }
    assert.equal(count, 2000);
  });

  test("3000 annonces ordinaires assemblées au hasard (marque, modèle, capacité, prix, année, dimensions) : aucune n'est refusée", () => {
    const random = prng(1007);
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
    const MODELS = ["iPhone 12", "iPhone 13 Pro", "Galaxy S21", "Galaxy A54 5G", "Redmi Note 12", "Spark 10 Pro", "Pavilion 15", "Latitude 5420", "ThinkPad T480", "Bravia 43", "Crypton 110", "Split 1,5 CV", "Hilux 2.5 D4D", "XPS 15 9520"];
    const STORAGE = ["64 Go", "128 Go", "256 Go", "512 Go", "1 To", "8 Go 256 Go", "16 Go 512 Go", "4+128 Go", "12/256 Go"];
    const EXTRA = ["2021", "2022", "2015-2018", "5000 mAh", "120 Hz", "1920x1080", "2400×1080", "3840×2160", "43 pouces", "55 pouces", "65 W", "1400 tr/min", "12000 BTU", "garantie 12 mois", "batterie 87 %", "45 000 km", "Réf. 9300-1234", "S/N 12345678", "300 L", "9 kg", "220 V", "2,4x1,08 m", "205/55 R16"];
    const PRICES = ["150 000 FCFA", "99 000 F", "1 250 000", "25 000 - 27 000 FCFA", "275 000", "12 500 000 FCFA", "12.500.000 F CFA", "750000", "21 500 FCFA"];
    for (let index = 0; index < 3000; index += 1) {
      const parts = [pick(MODELS), pick(STORAGE), pick(EXTRA), random() < 0.5 ? pick(PRICES) : pick(EXTRA)];
      // Les morceaux sont séparés par deux mots : jamais deux nombres collés l'un à l'autre (un champ ordinaire n'aligne pas une dimension et un prix sans un mot).
      const text = parts.join(" et aussi ");
      assert.equal(looksLikePhoneNumber(text), false, `essai ${index} : « ${text} »`);
    }
  });
});

describe("limites assumées, documentées", () => {
  test("un numéro coupé entre plusieurs champs, plusieurs attributs ou plusieurs éléments d'une liste n'est PAS détecté (les champs ne sont jamais concaténés)", () => {
    assert.equal(findPhoneNumberField({ variant: "Tel 07 08 09", location: "Cocody 10 11" }), null);
    assert.equal(findPhoneNumberField({ attributes: { appel: "07 08 09", suite: "10 11" } }), null);
    assert.equal(findPhoneNumberField({ attributes: { liste: ["07", "08", "09", "10", "11"] } }), null);
    assert.equal(findPhoneNumberField({ attributes: { tailles: ["38", "40", "42", "44"] } }), null, "la concaténation refuserait des listes honnêtes");
    assert.doesNotThrow(() => requireNoPhoneInOfferFields({ variant: "Tel 07 08 09", location: "Cocody 10 11", attributes: { appel: "07 08 09", suite: "10 11" } }));
  });

  test("limites du lot D3-bis : quatre groupes de deux chiffres dont le premier commence par 0 restent refusés (« remises 05 10 15 20 ») ; huit chiffres avec des lettres ou un premier groupe sans 0 passent ; un fixe écrit en milliers est pris pour une quantité", () => {
    numbers(["remises 05 10 15 20", "Taille 06 08 10 12"]);
    notNumbers(["07x08x09x10", "27 00 00 00", "2 712 345 678", "Livraison 10 20 30 40"]);
  });

  test("un numéro en toutes lettres ou séparé par plus de trois symboles n'est pas détecté", () => {
    notNumbers(["zéro sept zéro huit zéro neuf dix onze", "07 ........ 08 ........ 09 ........ 10 ........ 11"]);
  });
});

describe("champ concerné et noms d'attributs (publication)", () => {
  test("le message nomme le champ : « Pas de numéro de téléphone dans l'annonce (champ : variante) : l'acheteur vous contactera par noma. »", () => {
    assert.equal(phoneInOfferMessage("variant"), "Pas de numéro de téléphone dans l'annonce (champ : variante) : l'acheteur vous contactera par noma.");
    assert.equal(PHONE_IN_OFFER_MESSAGE, "Pas de numéro de téléphone dans l'annonce : l'acheteur vous contactera par noma.");
    assert.equal(phoneInOfferMessage(null), PHONE_IN_OFFER_MESSAGE);
    const expected: Record<string, string> = { category: "catégorie", brand: "marque", model: "modèle", variant: "variante", condition: "état", unit: "unité", location: "localisation", attributes: "attributs" };
    for (const field of OFFER_TEXT_FIELDS) {
      assert.equal(phoneInOfferMessage(field), `Pas de numéro de téléphone dans l'annonce (champ : ${expected[field]}) : l'acheteur vous contactera par noma.`);
    }
    for (const field of ["category", "brand", "model", "variant", "condition", "unit", "location"] as const) {
      const error = (() => {
        try {
          requireNoPhoneInOfferFields({ [field]: "07 08 09 10 11" });
        } catch (caught) {
          return caught;
        }
        return null;
      })();
      assert.ok(error instanceof CatalogPhoneNumberError, field);
      assert.equal(error.field, field);
      assert.equal(error.message, phoneInOfferMessage(field));
    }
    const attribute = (() => {
      try {
        requireNoPhoneInOfferFields({ attributes: { contact: "07 08 09 10 11" } });
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    assert.ok(attribute instanceof CatalogPhoneNumberError);
    assert.equal(attribute.field, "attributes");
    assert.equal(findPhoneNumberField({ attributes: { contact: "07 08 09 10 11" } }), "attributes");
    assert.equal(findPhoneNumberField({ variant: "128 Go" }), null);
  });

  test("noms d'attributs : [a-z_] seulement (minuscules et tiret bas), sinon refus explicite sans répéter le nom ; les valeurs sont contrôlées une à une", () => {
    for (const key of ["stockage", "prix_neuf", "chargeur_inclus", "__secret", "a"]) assert.equal(isValidOfferAttributeKey(key), true, key);
    for (const key of ["tel_0708", "Couleur", "ram8", "prix-neuf", "prix neuf", "é", "", "a.b", "tel٣", "key1"]) assert.equal(isValidOfferAttributeKey(key), false, JSON.stringify(key));
    assert.equal(isValidNestedAttributeKey("sourceUnit"), true);
    assert.equal(isValidNestedAttributeKey("value"), true);
    assert.equal(isValidNestedAttributeKey("unit1"), false);
    assert.throws(() => requireNoPhoneInOfferFields({ attributes: { tel_0708: "x" } }), (error: unknown) => error instanceof CatalogAttributeKeyError && error.message === ATTRIBUTE_KEY_MESSAGE && !error.message.includes("tel_0708"));
    assert.throws(() => requireNoPhoneInOfferFields({ attributes: { Couleur: "noir" } }), CatalogAttributeKeyError);
    assert.throws(() => requireNoPhoneInOfferFields({ attributes: { liste: [{ ram8: "x" }] } }), CatalogAttributeKeyError, "clé d'un objet dans une liste");
    assert.throws(() => requireNoPhoneInOfferFields({ attributes: { stockage: { value: 128, unit1: "Go" } } }), CatalogAttributeKeyError, "clé imbriquée avec un chiffre");
    assert.doesNotThrow(() => requireNoPhoneInOfferFields({ attributes: { stockage_capacite: { value: 128, unit: "Go", sourceUnit: "GB" }, charge_rapide: true } }), "clés de l'extraction (sourceUnit)");
    // Les valeurs sont contrôlées chacune : une valeur qui porte un numéro est refusée avec le champ « attributs ».
    assert.throws(() => requireNoPhoneInOfferFields({ attributes: { contact: "07 O8 09 10 11" } }), (error: unknown) => error instanceof CatalogPhoneNumberError && error.field === "attributes");
    assert.throws(() => requireNoPhoneInOfferFields({ attributes: { garantie: { value: "12 mois", unit: "07x08x09x10x11" } } }), CatalogPhoneNumberError);
    assert.throws(() => requireNoPhoneInOfferFields({ attributes: { ean: 2250708091011 } }), CatalogPhoneNumberError);
    assert.doesNotThrow(() => requireNoPhoneInOfferFields({ attributes: { ean: 4006381333931, resolution: "3840×2160", prix: "12 500 000 FCFA" } }));
    // Les noms sont contrôlés AVANT les valeurs : l'erreur de nom prime.
    assert.throws(() => requireNoPhoneInOfferFields({ attributes: { tel_0708: "07 08 09 10 11" } }), CatalogAttributeKeyError);
  });
});
