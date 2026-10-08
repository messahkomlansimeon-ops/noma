import { PHOTO_MAX_PIXELS, PHOTO_MAX_SIDE, PHOTO_MIN_SIDE } from "./config";

/**
 * Lecture, contrôle et NETTOYAGE des photos d'annonces (lot PH1). Module PUR : aucun accès disque ni base, aucune dépendance.
 *
 *  - Le type n'est déterminé que par les OCTETS MAGIQUES (JPEG, PNG, WebP) ; le Content-Type déclaré n'est jamais lu. SVG, GIF, HEIC, HTML et tout le reste sont refusés.
 *  - Les dimensions sont lues dans l'EN-TÊTE (jamais en décodant les pixels) : 200 à 8 000 px par côté, 40 mégapixels au plus (bombe de décompression).
 *  - Le fichier est RECONSTRUIT : seuls les segments utiles à l'affichage sont recopiés (liste blanche) ; les métadonnées (EXIF et GPS, XMP, commentaires, dates, vignettes
 *    incorporées, segments privés, PROFILS DE COULEUR ICC) et tout octet APRÈS la fin de l'image sont supprimés. Le résultat est réanalysé par le même code (`sanitizeImage` est idempotent).
 *    Les profils ICC sont retirés : ils portent du texte libre (nom, fabricant, description, copyright, souvent « Apple Inc. ») et un faux profil peut cacher n'importe quoi ; les navigateurs
 *    supposent alors sRGB (légère perte de fidélité des couleurs pour les photos en Display P3, voir PHOTOS.md).
 *
 * Ce qui n'est PAS fait (limites assumées, voir PHOTOS.md) : les pixels ne sont pas décodés (un texte écrit DANS la photo, numéro de téléphone compris, n'est pas détecté) ;
 * le flux compressé n'est pas inflaté (une bombe cachée dans le flux est bornée par le poids de 5 Mo et par les dimensions de l'en-tête).
 */

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

export type ImageRejection =
  | "unsupported_type"
  | "corrupt"
  | "truncated"
  | "too_small"
  | "too_large_dimensions"
  | "too_many_pixels"
  | "animated";

export interface SanitizedImage {
  mime: ImageMime;
  width: number;
  height: number;
  /** Fichier reconstruit : c'est lui qui est stocké, empreinte comprise. */
  bytes: Uint8Array;
  /** Étiquettes des morceaux supprimés (« APP1 », « COM », « tEXt », « EXIF »…), pour les essais et le journal ; jamais leur contenu. */
  removed: string[];
}

export type SanitizeResult = { ok: true; image: SanitizedImage } | { ok: false; reason: ImageRejection };

const fail = (reason: ImageRejection): SanitizeResult => ({ ok: false, reason });

// ───────────── type : octets magiques seulement ─────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function startsWith(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset + expected.length > bytes.length) return false;
  for (let index = 0; index < expected.length; index += 1) if (bytes[offset + index] !== expected[index]) return false;
  return true;
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** Type de l'image d'après ses seuls premiers octets ; `null` pour tout autre contenu (SVG, GIF, HEIC, HTML, texte, fichier vide…). */
export function detectImageType(bytes: Uint8Array): ImageMime | null {
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, 0, PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 12 && startsWith(bytes, 0, ascii("RIFF")) && startsWith(bytes, 8, ascii("WEBP"))) return "image/webp";
  return null;
}

/** Bornes de dimensions (l'en-tête annonce, rien n'est décodé) : trop grand d'abord (sécurité), puis trop petit. */
export function checkDimensions(width: number, height: number): ImageRejection | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return "corrupt";
  if (width > PHOTO_MAX_SIDE || height > PHOTO_MAX_SIDE) return "too_large_dimensions";
  if (width < PHOTO_MIN_SIDE || height < PHOTO_MIN_SIDE) return "too_small";
  if (width * height > PHOTO_MAX_PIXELS) return "too_many_pixels";
  return null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const u16be = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number): number => ((b[o] * 0x1000000) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0;
const u16le = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32le = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000)) >>> 0;

function u32leBytes(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

// ───────────── JPEG ─────────────

const JFIF = ascii("JFIF\0");
const ADOBE = ascii("Adobe");
const EXIF_HEAD = ascii("Exif\0\0");

/**
 * Orientation (1 à 8) lue dans l'EXIF d'origine, SEULE valeur conservée : sans elle, une photo prise en portrait par un téléphone s'afficherait couchée. `null` si absente,
 * hors bornes ou illisible (jamais d'exception : un EXIF illisible est simplement supprimé).
 */
function readExifOrientation(segment: Uint8Array): number | null {
  if (!startsWith(segment, 0, EXIF_HEAD) || segment.length < 6 + 8) return null;
  const tiff = segment.subarray(6);
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return null;
  const read16 = (o: number): number => (little ? u16le(tiff, o) : u16be(tiff, o));
  const read32 = (o: number): number => (little ? u32le(tiff, o) : u32be(tiff, o));
  if (read16(2) !== 0x002a) return null;
  const ifd = read32(4);
  if (ifd < 8 || ifd + 2 > tiff.length) return null;
  const count = read16(ifd);
  if (count > 512 || ifd + 2 + count * 12 > tiff.length) return null;
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (read16(entry) !== 0x0112) continue;
    if (read16(entry + 2) !== 3 || read32(entry + 4) !== 1) return null;
    const value = read16(entry + 8);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

/** EXIF minimal : une seule étiquette, l'orientation (aucun GPS, aucune date, aucun appareil). */
function minimalExif(orientation: number): Uint8Array {
  return Uint8Array.of(
    0xff, 0xe1, 0x00, 0x22,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  );
}

const JPEG_SOF_KEPT = new Set([0xc0, 0xc1, 0xc2]);
/** SOF que les navigateurs n'affichent pas (sans perte, hiérarchique, arithmétique) : refusés. */
const JPEG_SOF_REFUSED = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function sanitizeJpeg(b: Uint8Array): SanitizeResult {
  const out: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  const removed: string[] = [];
  let orientation: number | null = null;
  let frame: { width: number; height: number } | null = null;
  let scans = 0;
  /** Où insérer l'EXIF minimal : juste après le SOI, ou après le JFIF s'il ouvre le fichier. */
  let exifInsertAt = 1;
  let pos = 2;
  const length = b.length;
  for (;;) {
    if (pos >= length) return fail("truncated");
    if (b[pos] !== 0xff) return fail("corrupt");
    while (pos < length && b[pos] === 0xff) pos += 1; // octets de remplissage avant un marqueur
    if (pos >= length) return fail("truncated");
    const marker = b[pos];
    pos += 1;
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return fail("corrupt");
    if (marker === 0xd9) {
      if (frame === null || scans === 0) return fail("corrupt");
      out.push(Uint8Array.of(0xff, 0xd9));
      break; // tout ce qui suit la fin de l'image est ignoré
    }
    if (marker === 0x01) continue; // TEM : sans longueur, supprimé
    if (pos + 2 > length) return fail("truncated");
    const segmentLength = u16be(b, pos);
    if (segmentLength < 2) return fail("corrupt");
    if (pos + segmentLength > length) return fail("truncated");
    const dataStart = pos + 2;
    const dataEnd = pos + segmentLength;
    const data = b.subarray(dataStart, dataEnd);
    const raw = b.subarray(pos, dataEnd); // longueur comprise
    const label = `0x${marker.toString(16).toUpperCase()}`;

    if (JPEG_SOF_REFUSED.has(marker)) return fail("unsupported_type");
    if (JPEG_SOF_KEPT.has(marker)) {
      if (frame !== null) return fail("corrupt"); // deux cadres : deux lectures possibles des dimensions
      if (data.length < 6) return fail("corrupt");
      const precision = data[0];
      const height = u16be(data, 1);
      const width = u16be(data, 3);
      const components = data[5];
      if (precision !== 8 || height === 0 || width === 0 || ![1, 3, 4].includes(components) || segmentLength !== 8 + 3 * components) return fail("corrupt");
      const refusal = checkDimensions(width, height);
      if (refusal !== null) return fail(refusal);
      frame = { width, height };
      out.push(Uint8Array.of(0xff, marker), raw);
    } else if (marker === 0xc4 || marker === 0xdb || marker === 0xdd) {
      out.push(Uint8Array.of(0xff, marker), raw); // DHT, DQT, DRI
    } else if (marker === 0xda) {
      if (frame === null) return fail("corrupt");
      scans += 1;
      out.push(Uint8Array.of(0xff, marker), raw);
      pos = dataEnd;
      const entropyStart = pos;
      for (; pos < length; pos += 1) {
        if (b[pos] !== 0xff) continue;
        if (pos + 1 >= length) return fail("truncated");
        const next = b[pos + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          pos += 1; // octet bourré ou marqueur de redémarrage : fait partie des données
          continue;
        }
        break; // marqueur (ou remplissage avant un marqueur)
      }
      if (pos >= length) return fail("truncated");
      out.push(b.subarray(entropyStart, pos));
      continue;
    } else if (marker === 0xe0 && data.length >= 14 && startsWith(data, 0, JFIF)) {
      // JFIF : réécrit SANS vignette incorporée (une vignette peut montrer une version non recadrée de la photo).
      const opening = out.length === 1;
      out.push(Uint8Array.of(0xff, 0xe0, 0x00, 0x10), data.subarray(0, 12), Uint8Array.of(0x00, 0x00));
      if (opening) exifInsertAt = out.length;
    } else if (marker === 0xee && segmentLength === 14 && startsWith(data, 0, ADOBE)) {
      out.push(Uint8Array.of(0xff, marker), raw); // transformation de couleur (Adobe) : nécessaire à l'affichage
    } else {
      // APP1 (EXIF, XMP), APP13, commentaires, autres APPn, segments réservés ou inconnus : supprimés.
      let ours = false;
      if (marker === 0xe1) {
        const found = readExifOrientation(data);
        if (found !== null && orientation === null) orientation = found;
        // Notre propre EXIF minimal (fichier déjà nettoyé) est reconstruit à l'identique : ce n'est pas une suppression.
        ours = found !== null && sameBytes(raw, minimalExif(found).subarray(2));
      }
      if (!ours) removed.push(marker === 0xfe ? "COM" : marker >= 0xe0 && marker <= 0xef ? `APP${marker - 0xe0}` : label);
    }
    pos = dataEnd;
  }
  if (frame === null) return fail("corrupt");
  // Seule l'orientation survit à la suppression de l'EXIF, dans un EXIF minimal placé juste après le SOI (et après un éventuel JFIF).
  if (orientation !== null && orientation !== 1) {
    out.splice(exifInsertAt, 0, minimalExif(orientation));
  }
  return { ok: true, image: { mime: "image/jpeg", width: frame.width, height: frame.height, bytes: concat(out), removed } };
}

// ───────────── PNG ─────────────

let crcTable: Uint32Array | null = null;

function crc32(...parts: readonly Uint8Array[]): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const part of parts) for (let index = 0; index < part.length; index += 1) crc = crcTable[(crc ^ part[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Morceaux PNG conservés (liste blanche). Tout le reste (tEXt, zTXt, iTXt, eXIf, tIME, sPLT, iCCP — profil de couleur et son NOM —, APNG, privés…) est supprimé. */
const PNG_KEPT = new Set(["PLTE", "tRNS", "gAMA", "cHRM", "sRGB", "sBIT", "bKGD", "hIST", "pHYs", "cICP"]);
const PNG_VALID_DEPTHS: Readonly<Record<number, readonly number[]>> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

function sanitizePng(b: Uint8Array): SanitizeResult {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  const removed: string[] = [];
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let first = true;
  let sawPalette = false;
  let sawData = false;
  let dataEnded = false;
  for (;;) {
    if (pos + 8 > b.length) return fail("truncated");
    const size = u32be(b, pos);
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    if (!/^[A-Za-z]{4}$/.test(type) || size > 0x7fffffff) return fail("corrupt");
    const end = pos + 12 + size;
    if (end > b.length) return fail("truncated");
    const typeBytes = b.subarray(pos + 4, pos + 8);
    const data = b.subarray(pos + 8, pos + 8 + size);
    const chunk = b.subarray(pos, end);
    if (first) {
      if (type !== "IHDR" || size !== 13) return fail("corrupt");
    }
    const keep = type === "IHDR" || type === "IDAT" || type === "IEND" || (PNG_KEPT.has(type) && !sawData);
    if (keep && crc32(typeBytes, data) !== u32be(b, pos + 8 + size)) return fail("corrupt");

    if (type === "IHDR") {
      if (!first) return fail("corrupt"); // un seul IHDR
      first = false;
      width = u32be(data, 0);
      height = u32be(data, 4);
      const depth = data[8];
      colorType = data[9];
      if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return fail("corrupt");
      if (!(colorType in PNG_VALID_DEPTHS) || !PNG_VALID_DEPTHS[colorType].includes(depth) || data[10] !== 0 || data[11] !== 0 || (data[12] !== 0 && data[12] !== 1)) return fail("corrupt");
      const refusal = checkDimensions(width, height);
      if (refusal !== null) return fail(refusal);
      out.push(chunk);
    } else if (type === "IDAT") {
      if (dataEnded) return fail("corrupt"); // les IDAT doivent se suivre
      if (colorType === 3 && !sawPalette) return fail("corrupt");
      sawData = true;
      out.push(chunk);
    } else if (type === "IEND") {
      if (size !== 0 || !sawData) return fail("corrupt");
      out.push(chunk);
      break; // tout ce qui suit IEND est ignoré
    } else {
      if (sawData) dataEnded = true;
      if (type === "PLTE" && keep) {
        if (colorType === 0 || colorType === 4 || sawPalette || size === 0 || size % 3 !== 0 || size > 768) return fail("corrupt");
        sawPalette = true;
      }
      if (keep) out.push(chunk);
      else removed.push(type);
    }
    pos = end;
  }
  return { ok: true, image: { mime: "image/png", width, height, bytes: concat(out), removed } };
}

// ───────────── WebP ─────────────

interface WebpChunk {
  fourcc: string;
  data: Uint8Array;
}

const WEBP_FLAG_ICC = 0x20;
const WEBP_FLAG_EXIF = 0x08;
const WEBP_FLAG_XMP = 0x04;
const WEBP_FLAG_ANIMATION = 0x02;

function webpChunk(fourcc: string, data: Uint8Array): Uint8Array {
  return concat([Uint8Array.from(ascii(fourcc)), u32leBytes(data.length), data, data.length % 2 === 1 ? Uint8Array.of(0) : new Uint8Array(0)]);
}

/** Dimensions annoncées par le flux de l'image (« VP8 » avec perte ou « VP8L » sans perte) ; `null` si l'en-tête du flux est invalide. */
function webpBitstreamSize(fourcc: string, data: Uint8Array): { width: number; height: number } | null {
  if (fourcc === "VP8 ") {
    if (data.length < 10 || (data[0] & 1) !== 0 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) return null;
    return { width: u16le(data, 6) & 0x3fff, height: u16le(data, 8) & 0x3fff };
  }
  if (data.length < 5 || data[0] !== 0x2f) return null;
  const bits = u32le(data, 1);
  if (bits >>> 29 !== 0) return null;
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

function sanitizeWebp(b: Uint8Array): SanitizeResult {
  if (b.length < 12) return fail("truncated");
  const riffSize = u32le(b, 4);
  if (riffSize < 4) return fail("corrupt");
  if (riffSize + 8 > b.length) return fail("truncated");
  const end = riffSize + 8; // tout ce qui suit est ignoré
  const chunks: WebpChunk[] = [];
  let pos = 12;
  while (pos < end) {
    if (pos + 8 > end) return fail("corrupt");
    const fourcc = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]);
    const size = u32le(b, pos + 4);
    const next = pos + 8 + size + (size % 2);
    if (pos + 8 + size > end) return fail("truncated");
    if (next > end) return fail("corrupt");
    chunks.push({ fourcc, data: b.subarray(pos + 8, pos + 8 + size) });
    pos = next;
  }
  if (chunks.length === 0) return fail("corrupt");

  const removed: string[] = [];
  const head = chunks[0];
  const extended = head.fourcc === "VP8X";
  if (!extended && head.fourcc !== "VP8 " && head.fourcc !== "VP8L") return fail("corrupt");
  if (chunks.some((chunk) => chunk.fourcc === "ANIM" || chunk.fourcc === "ANMF")) return fail("animated");

  let canvas: { width: number; height: number } | null = null;
  let flags = 0;
  if (extended) {
    if (head.data.length !== 10) return fail("corrupt");
    flags = head.data[0];
    if (flags & WEBP_FLAG_ANIMATION) return fail("animated");
    canvas = { width: 1 + u24le(head.data, 4), height: 1 + u24le(head.data, 7) };
    const refusal = checkDimensions(canvas.width, canvas.height);
    if (refusal !== null) return fail(refusal);
  }

  const images = chunks.filter((chunk) => chunk.fourcc === "VP8 " || chunk.fourcc === "VP8L");
  if (images.length !== 1) return fail("corrupt");
  const image = images[0];
  const size = webpBitstreamSize(image.fourcc, image.data);
  if (size === null) return fail("corrupt");
  const refusal = checkDimensions(size.width, size.height);
  if (refusal !== null) return fail(refusal);
  if (canvas !== null && (canvas.width !== size.width || canvas.height !== size.height)) return fail("corrupt");

  const kept: Uint8Array[] = [];
  const imageIndex = chunks.indexOf(image);
  chunks.forEach((chunk, index) => {
    if (chunk === head && extended) return; // reconstruit plus bas
    if (chunk === image) kept.push(webpChunk(chunk.fourcc, chunk.data));
    else if (extended && chunk.fourcc === "ALPH" && image.fourcc === "VP8 " && index === imageIndex - 1) kept.push(webpChunk("ALPH", chunk.data));
    // EXIF, XMP, ICCP (profil de couleur) et tout bloc inconnu : supprimés.
    else removed.push(chunk.fourcc === "EXIF" || chunk.fourcc === "XMP " ? chunk.fourcc.trim() : chunk.fourcc);
  });
  const parts: Uint8Array[] = [];
  if (extended && canvas !== null) {
    // EXIF, XMP et profil de couleur supprimés : leurs drapeaux sont retirés ; les 3 octets réservés sont remis à zéro (ils pourraient cacher des données) ; seule la toile est recopiée.
    const header = new Uint8Array(10);
    header[0] = flags & ~(WEBP_FLAG_EXIF | WEBP_FLAG_XMP | WEBP_FLAG_ICC | 0xc1);
    header.set(head.data.subarray(4, 10), 4);
    parts.push(webpChunk("VP8X", header));
  }
  // L'ordre d'origine des morceaux conservés est respecté (ALPH avant l'image).
  parts.push(...kept);
  const body = concat(parts);
  const file = concat([Uint8Array.from(ascii("RIFF")), u32leBytes(4 + body.length), Uint8Array.from(ascii("WEBP")), body]);
  return { ok: true, image: { mime: "image/webp", width: size.width, height: size.height, bytes: file, removed } };
}

// ───────────── point d'entrée ─────────────

/**
 * Contrôle et reconstruit une photo. Refus : type inconnu (`unsupported_type`), fichier abîmé ou tronqué, dimensions hors bornes, image animée. Ne lève jamais.
 */
export function sanitizeImage(input: Uint8Array): SanitizeResult {
  const type = detectImageType(input);
  if (type === null) return fail("unsupported_type");
  try {
    if (type === "image/jpeg") return sanitizeJpeg(input);
    if (type === "image/png") return sanitizePng(input);
    return sanitizeWebp(input);
  } catch {
    return fail("corrupt");
  }
}
