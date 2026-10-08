/**
 * Fabrication d'images SANS dépendance (lot PH1) : PNG produits avec le zlib de Node, JPEG en niveaux de gris et WebP sans perte décodables par un navigateur, plus de quoi y
 * glisser des métadonnées (EXIF avec GPS, XMP, commentaires, texte PNG…) pour les essais du nettoyage. Utilisé par `demo:seed` (une photo synthétique par annonce), par les
 * essais unitaires et par `e2e:photos`. Module PUR : aucune lecture ni écriture de fichier, aucun accès réseau ni base.
 */
import { crc32, deflateSync } from "node:zlib";

const ascii = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from([...text].map((char) => char.charCodeAt(0) & 0xff));

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
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

/** Position de la première occurrence de `needle` dans `haystack` (-1 si absente) : les essais d'absence de métadonnées cherchent octet par octet. */
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let start = from; start + needle.length <= haystack.length; start += 1) {
    for (let index = 0; index < needle.length; index += 1) if (haystack[start + index] !== needle[index]) continue outer;
    return start;
  }
  return -1;
}

export const containsBytes = (haystack: Uint8Array, needle: Uint8Array | string): boolean =>
  indexOfBytes(haystack, typeof needle === "string" ? ascii(needle) : needle) !== -1;

const be16 = (value: number): Uint8Array => Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
const be32 = (value: number): Uint8Array => Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
const le32 = (value: number): Uint8Array => Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);

// ───────────── EXIF avec GPS, XMP ─────────────

/** Octets des coordonnées GPS écrites dans les EXIF fabriqués (3 rationnels chacune, grand-boutiste) : les essais vérifient qu'elles ne figurent plus dans le fichier nettoyé. */
export const GPS_LATITUDE_BYTES = Uint8Array.of(0, 0, 0, 5, 0, 0, 0, 1, 0, 0, 0, 20, 0, 0, 0, 1, 0, 0, 0, 12, 0, 0, 0, 1);
export const GPS_LONGITUDE_BYTES = Uint8Array.of(0, 0, 0, 4, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 30, 0, 0, 0, 1);
export const EXIF_MAKE = "SecretPhone-X1";
export const EXIF_DATE = "2026:10:07 12:34:56";
export const XMP_GPS_TEXT = "GPSLatitude=5,20.2N GPSLongitude=4,1.5W";

interface TiffEntry {
  tag: number;
  type: 2 | 3 | 4 | 5;
  count: number;
  value: Uint8Array;
}

function buildTiff(ifd0: TiffEntry[], gps: TiffEntry[]): Uint8Array<ArrayBuffer> {
  const entries0 = [...ifd0].sort((a, b) => a.tag - b.tag);
  const entriesGps = [...gps].sort((a, b) => a.tag - b.tag);
  const ifdSize = (list: TiffEntry[]) => 2 + 12 * list.length + 4;
  const gpsOffset = 8 + ifdSize(entries0);
  let dataOffset = gpsOffset + (entriesGps.length > 0 ? ifdSize(entriesGps) : 0);
  const area: Uint8Array[] = [];
  const encode = (list: TiffEntry[]): Uint8Array => {
    const rows: Uint8Array[] = [be16(list.length)];
    for (const entry of list) {
      const value = entry.tag === 0x8825 ? be32(gpsOffset) : entry.value;
      let field: Uint8Array;
      if (value.length <= 4) field = concatBytes(value, new Uint8Array(4 - value.length));
      else {
        field = be32(dataOffset);
        const padded = value.length % 2 === 0 ? value : concatBytes(value, Uint8Array.of(0));
        area.push(padded);
        dataOffset += padded.length;
      }
      rows.push(concatBytes(be16(entry.tag), be16(entry.type), be32(entry.count), field));
    }
    rows.push(be32(0));
    return concatBytes(...rows);
  };
  const first = encode(entries0);
  const second = entriesGps.length > 0 ? encode(entriesGps) : new Uint8Array(0);
  return concatBytes(Uint8Array.of(0x4d, 0x4d, 0x00, 0x2a), be32(8), first, second, ...area);
}

export interface ExifOptions {
  /** Orientation 1 à 8 (absente si omise). */
  orientation?: number;
  /** Écrit un bloc GPS (latitude, longitude). */
  gps?: boolean;
}

/** Charge utile TIFF d'un EXIF (celle d'un morceau PNG « eXIf » ou d'un bloc WebP « EXIF ») : appareil, date, orientation et GPS au choix. */
export function buildExifTiff(options: ExifOptions = {}): Uint8Array<ArrayBuffer> {
  const text = (value: string): Uint8Array => concatBytes(ascii(value), Uint8Array.of(0));
  const ifd0: TiffEntry[] = [
    { tag: 0x010f, type: 2, count: EXIF_MAKE.length + 1, value: text(EXIF_MAKE) },
    { tag: 0x0110, type: 2, count: 8, value: text("Model-Z9") },
    { tag: 0x0132, type: 2, count: EXIF_DATE.length + 1, value: text(EXIF_DATE) },
  ];
  if (options.orientation !== undefined) ifd0.push({ tag: 0x0112, type: 3, count: 1, value: be16(options.orientation) });
  const gps: TiffEntry[] = [];
  if (options.gps !== false) {
    ifd0.push({ tag: 0x8825, type: 4, count: 1, value: be32(0) });
    gps.push(
      { tag: 0x0001, type: 2, count: 2, value: text("N") },
      { tag: 0x0002, type: 5, count: 3, value: GPS_LATITUDE_BYTES },
      { tag: 0x0003, type: 2, count: 2, value: text("W") },
      { tag: 0x0004, type: 5, count: 3, value: GPS_LONGITUDE_BYTES },
    );
  }
  return buildTiff(ifd0, gps);
}

/** Segment JPEG complet (marqueur, longueur, données). */
export function jpegSegment(marker: number, data: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatBytes(Uint8Array.of(0xff, marker), be16(data.length + 2), data);
}

/** APP1 EXIF d'un JPEG. */
export function jpegExifSegment(options: ExifOptions = {}): Uint8Array<ArrayBuffer> {
  return jpegSegment(0xe1, concatBytes(ascii("Exif"), Uint8Array.of(0, 0), buildExifTiff(options)));
}

/** APP1 XMP d'un JPEG (paquet texte avec coordonnées). */
export function jpegXmpSegment(): Uint8Array<ArrayBuffer> {
  const packet = `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description>${XMP_GPS_TEXT}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  return jpegSegment(0xe1, concatBytes(ascii("http://ns.adobe.com/xap/1.0/\0"), ascii(packet)));
}

// ───────────── JPEG en niveaux de gris (décodable) ─────────────

export interface GrayJpegOptions {
  width: number;
  height: number;
  /** Niveau de gris 0 à 255 (défaut 150). */
  gray?: number;
  /** Segments insérés juste après le SOI (APP1, COM…), dans l'ordre. */
  after?: Uint8Array[];
  /** JFIF avec une vignette incorporée de 2 × 2 pixels (pour vérifier qu'elle disparaît). */
  jfifThumbnail?: boolean;
  /** Octets ajoutés APRÈS le marqueur de fin d'image. */
  trailing?: Uint8Array;
  /** Dimensions ANNONCÉES par l'en-tête SOF (les données, elles, ne couvrent que `width` × `height`) : fabrique une « bombe de décompression » sans la construire. */
  declared?: { width: number; height: number };
}

function huffmanDc(category: number): { bits: number; length: number } {
  // Table DC standard de luminance (annexe K.3.1) : catégories 0 à 11.
  const lengths = [2, 3, 3, 3, 3, 3, 4, 5, 6, 7, 8, 9];
  const codes = [0b00, 0b010, 0b011, 0b100, 0b101, 0b110, 0b1110, 0b11110, 0b111110, 0b1111110, 0b11111110, 0b111111110];
  return { bits: codes[category], length: lengths[category] };
}

/** JPEG de base (une composante, quantification 8) d'une seule teinte : un vrai fichier que les navigateurs décodent, de dimensions quelconques. */
export function buildGrayJpeg(options: GrayJpegOptions): Uint8Array<ArrayBuffer> {
  const { width, height } = options;
  const level = Math.max(0, Math.min(255, options.gray ?? 150));
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let shift = length - 1; shift >= 0; shift -= 1) bits.push((value >>> shift) & 1);
  };
  for (let block = 0; block < blocks; block += 1) {
    const diff = block === 0 ? level - 128 : 0;
    const magnitude = Math.abs(diff);
    const category = magnitude === 0 ? 0 : Math.floor(Math.log2(magnitude)) + 1;
    const code = huffmanDc(category);
    put(code.bits, code.length);
    if (category > 0) put(diff > 0 ? diff : diff + (1 << category) - 1, category);
    put(0, 1); // fin de bloc (seul symbole de la table AC : code « 0 »)
  }
  while (bits.length % 8 !== 0) bits.push(1);
  const entropy: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | bits[index + bit];
    entropy.push(byte);
    if (byte === 0xff) entropy.push(0x00);
  }
  const jfif = jpegSegment(
    0xe0,
    concatBytes(ascii("JFIF\0"), Uint8Array.of(1, 1, 0), be16(1), be16(1), options.jfifThumbnail ? Uint8Array.of(2, 2, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12) : Uint8Array.of(0, 0)),
  );
  const dqt = jpegSegment(0xdb, concatBytes(Uint8Array.of(0), new Uint8Array(64).fill(8)));
  const sof = jpegSegment(0xc0, concatBytes(Uint8Array.of(8), be16(options.declared?.height ?? height), be16(options.declared?.width ?? width), Uint8Array.of(1, 1, 0x11, 0)));
  const dcCounts = Uint8Array.of(0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0);
  const dht = jpegSegment(
    0xc4,
    concatBytes(
      Uint8Array.of(0x00), dcCounts, Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11),
      Uint8Array.of(0x10), Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), Uint8Array.of(0x00),
    ),
  );
  const sos = jpegSegment(0xda, Uint8Array.of(1, 1, 0x00, 0, 63, 0));
  return concatBytes(
    Uint8Array.of(0xff, 0xd8), jfif, ...(options.after ?? []), dqt, sof, dht, sos, Uint8Array.from(entropy), Uint8Array.of(0xff, 0xd9), options.trailing ?? new Uint8Array(0),
  );
}

// ───────────── PNG ─────────────

export function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = concatBytes(ascii(type), data);
  return concatBytes(be32(data.length), body, be32(crc32(body)));
}

export type PngPattern = "solid" | "stripes" | "checker" | "gradient" | "diagonal";

export interface PngOptions {
  width: number;
  height: number;
  color?: readonly [number, number, number];
  accent?: readonly [number, number, number];
  pattern?: PngPattern;
  /** Morceaux ajoutés avant les données de l'image. */
  before?: ReadonlyArray<{ type: string; data: Uint8Array }>;
  /** Morceaux ajoutés après les données de l'image, avant IEND. */
  after?: ReadonlyArray<{ type: string; data: Uint8Array }>;
  /** Octets ajoutés APRÈS IEND. */
  trailing?: Uint8Array;
  /** Dimensions ANNONCÉES par IHDR (les données ne couvrent que `width` × `height`) : une « bombe de décompression » sans la construire. */
  declared?: { width: number; height: number };
}

function pixelOf(pattern: PngPattern, x: number, y: number, height: number, color: readonly number[], accent: readonly number[]): readonly number[] {
  switch (pattern) {
    case "stripes":
      return Math.floor((x + y) / 24) % 2 === 0 ? color : accent;
    case "checker":
      return (Math.floor(x / 32) + Math.floor(y / 32)) % 2 === 0 ? color : accent;
    case "diagonal":
      return (x + y) % 48 < 8 ? accent : color;
    case "gradient": {
      const t = y / Math.max(1, height - 1);
      return color.map((channel, index) => Math.round(channel + (accent[index] - channel) * t));
    }
    default:
      return color;
  }
}

/** PNG RVB 8 bits, entrelacement nul : couleur et motif simples, compressé par le zlib de Node (un fichier de quelques Ko). */
export function buildPng(options: PngOptions): Uint8Array<ArrayBuffer> {
  const { width, height } = options;
  const color = options.color ?? [90, 140, 110];
  const accent = options.accent ?? [235, 235, 225];
  const pattern = options.pattern ?? "solid";
  const row = 1 + width * 3;
  const raw = new Uint8Array(row * height);
  for (let y = 0; y < height; y += 1) {
    const base = y * row;
    raw[base] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = pixelOf(pattern, x, y, height, color, accent);
      raw[base + 1 + x * 3] = pixel[0];
      raw[base + 2 + x * 3] = pixel[1];
      raw[base + 3 + x * 3] = pixel[2];
    }
  }
  const header = concatBytes(be32(options.declared?.width ?? width), be32(options.declared?.height ?? height), Uint8Array.of(8, 2, 0, 0, 0));
  return concatBytes(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", header),
    ...(options.before ?? []).map((chunk) => pngChunk(chunk.type, chunk.data)),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    ...(options.after ?? []).map((chunk) => pngChunk(chunk.type, chunk.data)),
    pngChunk("IEND", new Uint8Array(0)),
    options.trailing ?? new Uint8Array(0),
  );
}

// ───────────── WebP ─────────────

export function riffChunk(fourcc: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatBytes(ascii(fourcc), le32(data.length), data, data.length % 2 === 1 ? Uint8Array.of(0) : new Uint8Array(0));
}

export function riffFile(...chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concatBytes(...chunks);
  return concatBytes(ascii("RIFF"), le32(4 + body.length), ascii("WEBP"), body);
}

/** Flux « VP8L » (sans perte) d'une seule couleur : cinq codes préfixes à un seul symbole, donc aucun bit par pixel ; décodable par les navigateurs. */
export function vp8lSolid(width: number, height: number, rgba: readonly [number, number, number, number]): Uint8Array<ArrayBuffer> {
  const header = (width - 1) | ((height - 1) << 14) | (1 << 28);
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let index = 0; index < length; index += 1) bits.push((value >>> index) & 1); // poids faible d'abord
  };
  put(0, 1); // aucune transformation
  put(0, 1); // aucun cache de couleurs
  put(0, 1); // aucune image de méta-préfixes
  for (const symbol of [rgba[1], rgba[0], rgba[2], rgba[3], 0]) {
    put(1, 1); // code simple
    put(0, 1); // un seul symbole
    put(1, 1); // symbole sur 8 bits
    put(symbol, 8);
  }
  while (bits.length % 8 !== 0) bits.push(0);
  const stream: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) byte |= bits[index + bit] << bit;
    stream.push(byte);
  }
  return concatBytes(Uint8Array.of(0x2f), le32(header >>> 0), Uint8Array.from(stream));
}

export interface WebpOptions {
  width: number;
  height: number;
  rgba?: readonly [number, number, number, number];
  /** Fichier au format étendu (VP8X) avec ces blocs (l'ordre : ICCP, [image], EXIF, XMP). */
  extended?: { icc?: Uint8Array; exif?: Uint8Array; xmp?: Uint8Array };
  /** Octets ajoutés APRÈS la fin du conteneur RIFF. */
  trailing?: Uint8Array;
  /** Dimensions de la toile annoncées par VP8X (format étendu), si elles diffèrent de celles du flux. */
  canvas?: { width: number; height: number };
}

export function buildWebpLossless(options: WebpOptions): Uint8Array<ArrayBuffer> {
  const image = riffChunk("VP8L", vp8lSolid(options.width, options.height, options.rgba ?? [90, 140, 110, 255]));
  if (options.extended === undefined) return concatBytes(riffFile(image), options.trailing ?? new Uint8Array(0));
  const { icc, exif, xmp } = options.extended;
  const flags = (icc ? 0x20 : 0) | (exif ? 0x08 : 0) | (xmp ? 0x04 : 0);
  const canvasWidth = options.canvas?.width ?? options.width;
  const canvasHeight = options.canvas?.height ?? options.height;
  const canvas = concatBytes(
    Uint8Array.of(flags, 0, 0, 0),
    Uint8Array.of((canvasWidth - 1) & 0xff, ((canvasWidth - 1) >> 8) & 0xff, ((canvasWidth - 1) >> 16) & 0xff),
    Uint8Array.of((canvasHeight - 1) & 0xff, ((canvasHeight - 1) >> 8) & 0xff, ((canvasHeight - 1) >> 16) & 0xff),
  );
  return concatBytes(
    riffFile(riffChunk("VP8X", canvas), ...(icc ? [riffChunk("ICCP", icc)] : []), image, ...(exif ? [riffChunk("EXIF", exif)] : []), ...(xmp ? [riffChunk("XMP ", xmp)] : [])),
    options.trailing ?? new Uint8Array(0),
  );
}

/** Flux « VP8 » (avec perte) STRUCTURELLEMENT valide (image clé, code de départ, dimensions) mais sans image décodable : pour les essais d'analyse seulement. */
export function fakeVp8(width: number, height: number): Uint8Array<ArrayBuffer> {
  return concatBytes(Uint8Array.of(0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a), Uint8Array.of(width & 0xff, (width >> 8) & 0x3f), Uint8Array.of(height & 0xff, (height >> 8) & 0x3f), new Uint8Array(24));
}

// ───────────── photos de démonstration ─────────────

const DEMO_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [96, 142, 112], [86, 128, 168], [196, 120, 84], [140, 112, 168], [88, 150, 150], [176, 148, 80], [150, 96, 104], [104, 120, 96],
];
const DEMO_PATTERNS: readonly PngPattern[] = ["stripes", "checker", "diagonal", "gradient"];

function hashText(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619) >>> 0;
  return value;
}

/** Photo synthétique d'une annonce de démonstration : 480 × 360, couleur choisie par produit (marque et modèle), motif par annonce. Déterministe : mêmes octets à chaque fois. */
export function demoPhotoPng(product: { brand: string; model: string }, offerKey: string): Uint8Array<ArrayBuffer> {
  const color = DEMO_PALETTE[hashText(`${product.brand}|${product.model}`) % DEMO_PALETTE.length];
  const accent: readonly [number, number, number] = [Math.min(255, color[0] + 70), Math.min(255, color[1] + 70), Math.min(255, color[2] + 70)];
  return buildPng({ width: 480, height: 360, color, accent, pattern: DEMO_PATTERNS[hashText(offerKey) % DEMO_PATTERNS.length] });
}

// ───────────── fichiers « cuisine » (PH1-bis) : tout ce qui peut porter du texte, y compris les profils ICC ─────────────

/** Texte secret glissé partout : coordonnées, appareil, date, numéro de téléphone, quartier. Aucune de ces chaînes ne doit survivre au nettoyage. */
export const KITCHEN_SECRET = "GPSLatitude 5.3453N Canon EOS 5D 2024:05:01 10:00:00 tel 0708091011 Cocody secret";

/** Chaînes interdites dans un fichier nettoyé (celles de l'auditeur, plus les noms de blocs de profil de couleur). */
export const KITCHEN_FORBIDDEN: readonly string[] = ["GPS", "Canon", "0708091011", "Cocody", "Apple Inc.", "ICC_PROFILE", "iCCP", "ICCP", "xpacket", "<html", "<script", "PK\x03\x04"];

const text = (value: string): Uint8Array<ArrayBuffer> => ascii(value);

/** Segment APP2 « ICC_PROFILE » d'un JPEG : un faux profil rempli d'un EXIF, du texte secret et d'un nom de fabricant. */
export function jpegIccSegment(): Uint8Array<ArrayBuffer> {
  return jpegSegment(0xe2, concatBytes(text("ICC_PROFILE\0"), Uint8Array.of(1, 1), text("Exif\0\0"), text(KITCHEN_SECRET), text(" Apple Inc. Display P3")));
}

/** JPEG « cuisine » : EXIF (orientation 6, GPS), XMP, Photoshop, commentaire HTML, faux profil ICC, MPF, segments privés, vignette JFIF, HTML et archive après la fin de l'image. */
export function buildKitchenJpeg(size: { width: number; height: number } = { width: 300, height: 200 }): Uint8Array<ArrayBuffer> {
  return buildGrayJpeg({
    ...size,
    gray: 110,
    jfifThumbnail: true,
    after: [
      jpegExifSegment({ gps: true, orientation: 6 }),
      jpegXmpSegment(),
      jpegSegment(0xed, concatBytes(text("Photoshop 3.0\0"), text("8BIM"), text("Abidjan Cocody "), text(KITCHEN_SECRET))),
      jpegSegment(0xfe, concatBytes(text("<html><script>alert(1)</script> "), text(KITCHEN_SECRET))),
      jpegIccSegment(),
      jpegSegment(0xe2, concatBytes(text("MPF\0"), text(KITCHEN_SECRET))),
      jpegSegment(0xe9, text(KITCHEN_SECRET)),
      jpegSegment(0xef, text(KITCHEN_SECRET)),
    ],
    trailing: concatBytes(text("<html><body><script>alert('apres EOI')</script></body></html>"), text("PK\x03\x04"), text(KITCHEN_SECRET)),
  });
}

/** PNG « cuisine » : bloc iCCP dont le NOM porte le secret, tEXt, zTXt, iTXt (XMP) compressés, eXIf, tIME, texte après IEND. */
export function buildKitchenPng(size: { width: number; height: number } = { width: 320, height: 240 }): Uint8Array<ArrayBuffer> {
  const compressed = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array(deflateSync(text(value)));
  return buildPng({
    ...size,
    pattern: "checker",
    before: [
      { type: "iCCP", data: concatBytes(text("GPS 5.3453N Canon EOS 0708091011\0\0"), compressed(`${"\0".repeat(128)}${KITCHEN_SECRET} Apple Inc.`)) },
      { type: "tEXt", data: concatBytes(text("Comment\0"), text(KITCHEN_SECRET)) },
      { type: "zTXt", data: concatBytes(text("Author\0\0"), compressed(KITCHEN_SECRET)) },
      { type: "iTXt", data: concatBytes(text("XML:com.adobe.xmp\0\x01\0\0\0"), compressed(`<x:xmpmeta>${KITCHEN_SECRET}</x:xmpmeta>`)) },
      { type: "eXIf", data: buildExifTiff({ gps: true, orientation: 6 }) },
      { type: "tIME", data: Uint8Array.of(0x07, 0xe8, 5, 1, 10, 0, 0) },
    ],
    trailing: concatBytes(text("PK\x03\x04"), text(KITCHEN_SECRET), text("<html><script>alert(2)</script>")),
  });
}

/** WebP « cuisine » : ICCP (texte secret), EXIF, XMP, bloc inconnu, tout cela suivi de texte après le conteneur. */
export function buildKitchenWebp(size: { width: number; height: number } = { width: 400, height: 300 }): Uint8Array<ArrayBuffer> {
  const bare = buildWebpLossless({ ...size, rgba: [180, 60, 60, 255], extended: { icc: concatBytes(new Uint8Array(64), text(KITCHEN_SECRET)), exif: buildExifTiff({ gps: true, orientation: 6 }), xmp: text(`<x:xmpmeta>${KITCHEN_SECRET}</x:xmpmeta>`) } });
  const unknown = riffChunk("ZZZZ", text(KITCHEN_SECRET));
  const withUnknown = concatBytes(bare, unknown);
  const patched = Uint8Array.from(withUnknown);
  new DataView(patched.buffer).setUint32(4, patched.length - 8, true);
  return concatBytes(patched, text("<html><script>alert(3)</script>"), text(KITCHEN_SECRET));
}
