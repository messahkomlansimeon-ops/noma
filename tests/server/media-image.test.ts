import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { describe, test } from "node:test";
import {
  PHOTO_MAX_PIXELS, PHOTO_MAX_SIDE, PHOTO_MIN_SIDE,
} from "../../lib/server/media/config";
import { checkDimensions, detectImageType, sanitizeImage, type ImageRejection, type SanitizedImage } from "../../lib/server/media/image";
import {
  EXIF_DATE, EXIF_MAKE, GPS_LATITUDE_BYTES, GPS_LONGITUDE_BYTES, KITCHEN_FORBIDDEN, KITCHEN_SECRET, XMP_GPS_TEXT,
  buildExifTiff, buildGrayJpeg, buildKitchenJpeg, buildKitchenPng, buildKitchenWebp, buildPng, buildWebpLossless, concatBytes, containsBytes, fakeVp8, jpegExifSegment, jpegIccSegment, jpegSegment, jpegXmpSegment, pngChunk, riffChunk, riffFile,
} from "../../scripts/photo-fixtures";

/**
 * Photos d'annonces (lot PH1), partie octets : détection du type par les seuls octets magiques, bornes de dimensions lues dans l'en-tête, suppression des métadonnées
 * (EXIF et GPS, XMP, commentaires, texte PNG, blocs WebP) vérifiée octet par octet, image reconstruite toujours valide (réanalysée par un contrôleur INDÉPENDANT du code testé),
 * idempotence, fichiers tronqués, polyglottes, bombes de décompression, mutations aléatoires.
 */

const text = (value: string): Uint8Array => Uint8Array.from([...value].map((char) => char.charCodeAt(0) & 0xff));

function accepted(bytes: Uint8Array): SanitizedImage {
  const result = sanitizeImage(bytes);
  assert.equal(result.ok, true, result.ok ? "" : `refusé : ${result.reason}`);
  if (!result.ok) throw new Error("refusé");
  return result.image;
}

function refusal(bytes: Uint8Array): ImageRejection {
  const result = sanitizeImage(bytes);
  assert.equal(result.ok, false, "devait être refusé");
  if (result.ok) throw new Error("accepté");
  return result.reason;
}

// ───────────── contrôleurs indépendants (écrits sans le code testé) ─────────────

const u16 = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1];
const u32 = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const le32 = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

interface JpegWalk { segments: Array<{ marker: number; length: number }>; width: number; height: number }

/** Parcourt un JPEG de bout en bout : les segments doivent remplir exactement le fichier, du SOI au EOI, sans un octet de plus. */
function walkJpeg(b: Uint8Array): JpegWalk {
  assert.equal(b[0], 0xff);
  assert.equal(b[1], 0xd8);
  const segments: JpegWalk["segments"] = [];
  let width = 0;
  let height = 0;
  let pos = 2;
  for (;;) {
    assert.equal(b[pos], 0xff, `marqueur attendu à ${pos}`);
    const marker = b[pos + 1];
    assert.ok(marker !== 0x00 && marker !== 0xff, "marqueur valide");
    if (marker === 0xd9) {
      assert.equal(pos + 2, b.length, "aucun octet après la fin de l'image");
      segments.push({ marker, length: 0 });
      return { segments, width, height };
    }
    const length = u16(b, pos + 2);
    assert.ok(length >= 2 && pos + 2 + length <= b.length, "segment dans le fichier");
    if (marker >= 0xc0 && marker <= 0xc2) {
      height = u16(b, pos + 5);
      width = u16(b, pos + 7);
    }
    segments.push({ marker, length });
    pos += 2 + length;
    if (marker === 0xda) {
      for (; ; pos += 1) {
        assert.ok(pos < b.length - 1, "données entropiques terminées par un marqueur");
        if (b[pos] === 0xff && b[pos + 1] !== 0x00 && !(b[pos + 1] >= 0xd0 && b[pos + 1] <= 0xd7)) break;
        if (b[pos] === 0xff) pos += 1;
      }
    }
  }
}

interface PngWalk { chunks: Array<{ type: string; data: Uint8Array }>; width: number; height: number }

/** Parcourt un PNG : CRC de chaque morceau, IHDR en tête, IEND en dernier et à la toute fin. */
function walkPng(b: Uint8Array): PngWalk {
  assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks: PngWalk["chunks"] = [];
  let pos = 8;
  for (;;) {
    const size = u32(b, pos);
    const type = String.fromCharCode(...b.subarray(pos + 4, pos + 8));
    const data = b.subarray(pos + 8, pos + 8 + size);
    assert.equal(u32(b, pos + 8 + size), crc32(b.subarray(pos + 4, pos + 8 + size)), `CRC de ${type}`);
    chunks.push({ type, data });
    pos += 12 + size;
    if (type === "IEND") {
      assert.equal(pos, b.length, "aucun octet après IEND");
      break;
    }
  }
  assert.equal(chunks[0].type, "IHDR");
  assert.ok(chunks.some((chunk) => chunk.type === "IDAT"));
  return { chunks, width: u32(chunks[0].data, 0), height: u32(chunks[0].data, 4) };
}

interface WebpWalk { chunks: Array<{ fourcc: string; data: Uint8Array }> }

/** Parcourt un WebP : la taille RIFF est exactement celle du fichier moins 8 ; les blocs remplissent le conteneur au octet près. */
function walkWebp(b: Uint8Array): WebpWalk {
  assert.equal(String.fromCharCode(...b.subarray(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...b.subarray(8, 12)), "WEBP");
  assert.equal(le32(b, 4) + 8, b.length, "taille RIFF cohérente avec le fichier");
  const chunks: WebpWalk["chunks"] = [];
  let pos = 12;
  while (pos < b.length) {
    const fourcc = String.fromCharCode(...b.subarray(pos, pos + 4));
    const size = le32(b, pos + 4);
    chunks.push({ fourcc, data: b.subarray(pos + 8, pos + 8 + size) });
    pos += 8 + size + (size % 2);
  }
  assert.equal(pos, b.length, "les blocs remplissent exactement le conteneur");
  return { chunks };
}

/** Un contrôle commun : l'image reconstruite est valide, ses dimensions sont celles annoncées, et la nettoyer de nouveau ne change plus un octet. */
function assertValidAndStable(image: SanitizedImage): void {
  if (image.mime === "image/jpeg") {
    const walk = walkJpeg(image.bytes);
    assert.deepEqual([walk.width, walk.height], [image.width, image.height]);
    assert.equal(walk.segments.filter((segment) => segment.marker >= 0xc0 && segment.marker <= 0xc2).length, 1, "un seul cadre");
  } else if (image.mime === "image/png") {
    const walk = walkPng(image.bytes);
    assert.deepEqual([walk.width, walk.height], [image.width, image.height]);
  } else {
    walkWebp(image.bytes);
  }
  const again = accepted(image.bytes);
  assert.deepEqual(again.bytes, image.bytes, "nettoyer un fichier déjà nettoyé ne change rien");
  assert.deepEqual(again.removed, [], "rien à retirer la deuxième fois");
  assert.deepEqual([again.width, again.height, again.mime], [image.width, image.height, image.mime]);
}

const SECRETS: ReadonlyArray<[string, Uint8Array]> = [
  ["latitude GPS", GPS_LATITUDE_BYTES],
  ["longitude GPS", GPS_LONGITUDE_BYTES],
  ["marque de l'appareil", text(EXIF_MAKE)],
  ["modèle", text("Model-Z9")],
  ["date de prise de vue", text(EXIF_DATE)],
  ["XMP : coordonnées", text(XMP_GPS_TEXT)],
  ["XMP : paquet", text("xpacket")],
  ["XMP : espace de noms", text("ns.adobe.com")],
  ["EXIF : en-tête", text("Exif")],
  ["étiquette GPS d'un texte", text("GPS Latitude")],
  ["commentaire", text("COMMENTAIRE-PRIVE")],
  ["script", text("<script")],
  ["HTML", text("<html")],
  ["alert", text("alert(")],
  // PH1-bis : le texte d'un profil de couleur (JPEG APP2, PNG iCCP et son NOM, WebP ICCP) et les chaînes de l'auditeur.
  ["GPS (texte)", text("GPS")],
  ["appareil Canon", text("Canon")],
  ["numéro de téléphone", text("0708091011")],
  ["quartier", text("Cocody")],
  ["fabricant du profil", text("Apple Inc.")],
  ["nom de profil ICC_PROFILE", text("ICC_PROFILE")],
  ["bloc PNG iCCP", text("iCCP")],
  ["bloc WebP ICCP", text("ICCP")],
];

function assertNoSecret(bytes: Uint8Array, except: readonly string[] = []): void {
  for (const [label, needle] of SECRETS) {
    if (except.includes(label)) continue;
    assert.equal(containsBytes(bytes, needle), false, `le fichier nettoyé contient encore : ${label}`);
  }
}

// ═════════════ 1. Type : octets magiques seulement ═════════════

describe("détection du type par les octets magiques", () => {
  const jpeg = buildGrayJpeg({ width: 200, height: 200 });
  const png = buildPng({ width: 200, height: 200 });
  const webp = buildWebpLossless({ width: 200, height: 200 });

  test("JPEG, PNG et WebP reconnus ; le nom et le type déclaré n'existent pas pour ce code", () => {
    assert.equal(detectImageType(jpeg), "image/jpeg");
    assert.equal(detectImageType(png), "image/png");
    assert.equal(detectImageType(webp), "image/webp");
    assert.equal(accepted(jpeg).mime, "image/jpeg");
    assert.equal(accepted(png).mime, "image/png");
    assert.equal(accepted(webp).mime, "image/webp");
    // Une fonction qui ne reçoit que des octets ne peut pas lire un Content-Type menteur : un PNG « déclaré JPEG » est un PNG.
    assert.equal(sanitizeImage.length, 1);
  });

  test("SVG (même avec un script), GIF, HEIC, BMP, HTML, texte, PDF et fichier vide sont refusés", () => {
    const svg = text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(document.cookie)</script></svg>');
    const svgDeclaration = text('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const samples: Array<[string, Uint8Array]> = [
      ["svg", svg],
      ["svg avec déclaration xml", svgDeclaration],
      ["gif87", text("GIF87a\x01\x00\x01\x00")],
      ["gif89", text("GIF89a\x01\x00\x01\x00")],
      ["heic", concatBytes(Uint8Array.of(0, 0, 0, 24), text("ftypheic"), new Uint8Array(16))],
      ["avif", concatBytes(Uint8Array.of(0, 0, 0, 24), text("ftypavif"), new Uint8Array(16))],
      ["bmp", text("BM\x36\x00\x00\x00")],
      ["html", text("<!DOCTYPE html><html><body><script>alert(1)</script></body></html>")],
      ["texte", text("bonjour")],
      ["pdf", text("%PDF-1.7\n")],
      ["vide", new Uint8Array(0)],
      ["un octet", Uint8Array.of(0xff)],
      ["RIFF sans WEBP (WAVE)", concatBytes(text("RIFF"), Uint8Array.of(4, 0, 0, 0), text("WAVE"))],
      ["JPEG presque : FF D8 mais pas FF", Uint8Array.of(0xff, 0xd8, 0x00, 0x00, 0x00)],
    ];
    for (const [label, bytes] of samples) {
      assert.equal(detectImageType(bytes), null, label);
      assert.equal(refusal(bytes), "unsupported_type", label);
    }
  });

  test("faux JPEG : un fichier qui commence par les octets magiques mais n'est pas une image est refusé (jamais accepté sur la foi de son en-tête)", () => {
    for (const body of [text("<html><script>alert(1)</script></html>"), new Uint8Array(500).fill(0x41), new Uint8Array(0)]) {
      const fake = concatBytes(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), body);
      assert.equal(detectImageType(fake), "image/jpeg");
      assert.ok(["corrupt", "truncated"].includes(refusal(fake)));
    }
    const fakePng = concatBytes(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), text("<svg onload=alert(1)>"));
    assert.ok(["corrupt", "truncated"].includes(refusal(fakePng)));
    const fakeWebp = concatBytes(text("RIFF"), Uint8Array.of(0x20, 0, 0, 0), text("WEBP"), text("<script>alert(1)</script>"));
    assert.ok(["corrupt", "truncated"].includes(refusal(fakeWebp)));
  });
});

// ═════════════ 2. Polyglottes ═════════════

describe("polyglottes JPEG, PNG et WebP avec du HTML", () => {
  const html = text("<html><body><script>alert(document.cookie)</script></body></html>");

  test("JPEG : HTML dans un commentaire, dans APP13, dans APP1 et APRÈS la fin de l'image : rien ne survit", () => {
    const polyglot = buildGrayJpeg({
      width: 240, height: 200,
      after: [jpegSegment(0xfe, html), jpegSegment(0xed, html), jpegSegment(0xe1, concatBytes(text("polyglotte\0"), html)), jpegSegment(0xe5, html)],
      trailing: concatBytes(html, html),
    });
    assert.ok(containsBytes(polyglot, "<script"), "le fixture est bien un polyglotte");
    const image = accepted(polyglot);
    assertNoSecret(image.bytes);
    assert.equal(image.mime, "image/jpeg");
    assert.deepEqual(image.removed.sort(), ["APP1", "APP13", "APP5", "COM"]);
    assertValidAndStable(image);
  });

  test("PNG : HTML dans tEXt, iTXt, zTXt, un morceau privé et après IEND : rien ne survit", () => {
    const polyglot = buildPng({
      width: 220, height: 200,
      before: [{ type: "tEXt", data: concatBytes(text("Comment\0"), html) }, { type: "iTXt", data: concatBytes(text("XML:com.adobe.xmp\0\0\0\0\0"), html) }],
      after: [{ type: "zTXt", data: concatBytes(text("k\0\0"), html) }, { type: "prVt", data: html }],
      trailing: html,
    });
    assert.ok(containsBytes(polyglot, "<script"));
    const image = accepted(polyglot);
    assertNoSecret(image.bytes);
    assert.deepEqual(image.removed.sort(), ["iTXt", "prVt", "tEXt", "zTXt"]);
    assertValidAndStable(image);
  });

  test("WebP : HTML dans XMP, EXIF, un bloc inconnu et après le conteneur : rien ne survit", () => {
    const polyglot = buildWebpLossless({ width: 220, height: 200, extended: { xmp: html, exif: concatBytes(buildExifTiff({ gps: true }), html) }, trailing: html });
    assert.ok(containsBytes(polyglot, "<script"));
    const image = accepted(polyglot);
    assertNoSecret(image.bytes);
    assertValidAndStable(image);
  });
});

// ═════════════ 3. Fichiers tronqués ═════════════

describe("fichiers tronqués", () => {
  test("JPEG : chaque préfixe strict d'un fichier valide est refusé (jamais d'exception)", () => {
    const jpeg = buildGrayJpeg({ width: 200, height: 200, after: [jpegExifSegment({ gps: true })] });
    accepted(jpeg);
    for (let length = 0; length < jpeg.length; length += 1) {
      const result = sanitizeImage(jpeg.subarray(0, length));
      assert.equal(result.ok, false, `préfixe de ${length} octets accepté`);
    }
  });

  test("PNG : chaque préfixe strict est refusé", () => {
    const png = buildPng({ width: 200, height: 200, pattern: "stripes" });
    accepted(png);
    for (let length = 0; length < png.length; length += 1) assert.equal(sanitizeImage(png.subarray(0, length)).ok, false, `préfixe de ${length} octets accepté`);
  });

  test("WebP : chaque préfixe strict est refusé", () => {
    const webp = buildWebpLossless({ width: 200, height: 200, extended: { exif: buildExifTiff({ gps: true }) } });
    accepted(webp);
    for (let length = 0; length < webp.length; length += 1) assert.equal(sanitizeImage(webp.subarray(0, length)).ok, false, `préfixe de ${length} octets accepté`);
  });

  test("raisons : tronqué dans les données (« truncated ») et abîmé (« corrupt »)", () => {
    const jpeg = buildGrayJpeg({ width: 200, height: 200 });
    assert.equal(refusal(jpeg.subarray(0, jpeg.length - 2)), "truncated");
    const png = buildPng({ width: 200, height: 200 });
    assert.equal(refusal(png.subarray(0, png.length - 5)), "truncated");
    const flipped = Uint8Array.from(png);
    flipped[flipped.length - 20] ^= 0xff; // octet dans le CRC d'IDAT ou ses données
    assert.equal(refusal(flipped), "corrupt");
  });
});

// ═════════════ 4. Dimensions ═════════════

describe("dimensions lues dans l'en-tête", () => {
  test("bornes exactes : 200 accepté, 199 refusé ; 4 100 accepté, 4 101 refusé ; 12,5 mégapixels acceptés, un pixel de plus refusé ; un téléphone d'entrée de gamme (4 032 × 3 024) passe", () => {
    assert.equal(PHOTO_MIN_SIDE, 200);
    assert.equal(PHOTO_MAX_SIDE, 4_100);
    assert.equal(PHOTO_MAX_PIXELS, 12_500_000);
    assert.equal(checkDimensions(200, 200), null);
    assert.equal(checkDimensions(199, 200), "too_small");
    assert.equal(checkDimensions(200, 199), "too_small");
    assert.equal(checkDimensions(4_032, 3_024), null, "12,2 Mpx : photo d'un téléphone d'entrée de gamme");
    assert.equal(checkDimensions(4_100, 3_048), null, "12 496 800 px");
    assert.equal(checkDimensions(4_100, 3_049), "too_many_pixels", "12 500 900 px");
    assert.equal(checkDimensions(3_125, 4_000), null, "12 500 000 px pile");
    assert.equal(checkDimensions(3_126, 4_000), "too_many_pixels", "12 504 000 px");
    assert.equal(checkDimensions(4_100, 200), null);
    assert.equal(checkDimensions(4_101, 200), "too_large_dimensions");
    assert.equal(checkDimensions(200, 4_101), "too_large_dimensions");
    assert.equal(checkDimensions(8_000, 5_000), "too_large_dimensions", "la bombe de l'auditeur (40 Mpx) est refusée");
    assert.equal(checkDimensions(50_000, 50_000), "too_large_dimensions");
    assert.equal(checkDimensions(0, 300), "corrupt");
    assert.equal(checkDimensions(Number.NaN, 300), "corrupt");
    assert.equal(checkDimensions(300.5, 300), "corrupt");
  });

  test("JPEG : 199 × 200 et 200 × 199 refusés, 200 × 200 accepté", () => {
    assert.equal(refusal(buildGrayJpeg({ width: 199, height: 200 })), "too_small");
    assert.equal(refusal(buildGrayJpeg({ width: 200, height: 199 })), "too_small");
    assert.deepEqual([accepted(buildGrayJpeg({ width: 200, height: 200 })).width], [200]);
    // L'en-tête annonce, les données ne suivent pas : seul l'en-tête est lu, donc le plafond borne ce que le navigateur décodera.
    assert.equal(accepted(buildGrayJpeg({ width: 800, height: 600, declared: { width: 4_032, height: 3_024 } })).width, 4_032, "un téléphone d'entrée de gamme");
    assert.equal(refusal(buildGrayJpeg({ width: 800, height: 600, declared: { width: 4_101, height: 3_000 } })), "too_large_dimensions");
    assert.equal(refusal(buildGrayJpeg({ width: 800, height: 600, declared: { width: 4_100, height: 3_049 } })), "too_many_pixels");
    assert.equal(refusal(buildGrayJpeg({ width: 800, height: 600, declared: { width: 8_000, height: 5_000 } })), "too_large_dimensions", "l'en-tête annonce 8 000 × 5 000, les données font 800 × 600 : refusé");
  });

  test("PNG : mêmes bornes (dimensions lues dans IHDR)", () => {
    assert.equal(refusal(buildPng({ width: 199, height: 200 })), "too_small");
    assert.equal(refusal(buildPng({ width: 200, height: 200, declared: { width: 4_101, height: 200 } })), "too_large_dimensions");
    assert.equal(refusal(buildPng({ width: 200, height: 200, declared: { width: 4_100, height: 3_049 } })), "too_many_pixels");
    assert.equal(accepted(buildPng({ width: 200, height: 200, declared: { width: 4_100, height: 3_048 } })).width, 4_100, "12 496 800 px : accepté (seul l'en-tête est lu)");
    assert.equal(accepted(buildPng({ width: 200, height: 200, declared: { width: 3_125, height: 4_000 } })).height, 4_000, "12,5 mégapixels pile : accepté");
    assert.equal(refusal(buildPng({ width: 200, height: 200, declared: { width: 3_126, height: 4_000 } })), "too_many_pixels");
  });

  test("bombe de décodage de l'auditeur : un VRAI PNG de 8 000 × 5 000 en niveaux de gris (quelques dizaines de Ko compressés) est refusé", () => {
    const width = 8_000;
    const height = 5_000;
    const header = concatBytes(Uint8Array.of(0, 0, 0x1f, 0x40), Uint8Array.of(0, 0, 0x13, 0x88), Uint8Array.of(8, 0, 0, 0, 0));
    const bomb = concatBytes(
      Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), pngChunk("IHDR", header),
      pngChunk("IDAT", new Uint8Array(deflateSync(new Uint8Array((width + 1) * height), { level: 9 }))), pngChunk("IEND", new Uint8Array(0)),
    );
    assert.ok(bomb.length < 100_000, `${bomb.length} octets seulement`);
    assert.equal(refusal(bomb), "too_large_dimensions");
  });

  test("WebP : mêmes bornes, flux sans perte (14 bits : jusqu'à 16 384) et toile VP8X (24 bits)", () => {
    assert.equal(refusal(buildWebpLossless({ width: 199, height: 200 })), "too_small");
    assert.equal(refusal(buildWebpLossless({ width: 4_101, height: 200 })), "too_large_dimensions");
    assert.equal(refusal(buildWebpLossless({ width: 16_384, height: 16_384 })), "too_large_dimensions");
    assert.equal(refusal(buildWebpLossless({ width: 4_100, height: 3_049 })), "too_many_pixels");
    assert.equal(accepted(buildWebpLossless({ width: 4_100, height: 3_048 })).height, 3_048);
    assert.equal(accepted(buildWebpLossless({ width: 4_032, height: 3_024 })).width, 4_032, "un téléphone d'entrée de gamme");
    assert.equal(refusal(buildWebpLossless({ width: 200, height: 200, extended: {}, canvas: { width: 50_000, height: 50_000 } })), "too_large_dimensions", "toile annoncée de 50 000 × 50 000");
    assert.equal(refusal(buildWebpLossless({ width: 200, height: 200, extended: {}, canvas: { width: 300, height: 200 } })), "corrupt", "toile et flux en désaccord");
  });

  test("bombe de décompression : un en-tête qui annonce 50 000 × 50 000 est refusé sans rien décoder (JPEG, PNG, WebP), très vite", () => {
    const started = performance.now();
    assert.equal(refusal(buildGrayJpeg({ width: 200, height: 200, declared: { width: 50_000, height: 50_000 } })), "too_large_dimensions");
    assert.equal(refusal(buildPng({ width: 200, height: 200, declared: { width: 50_000, height: 50_000 } })), "too_large_dimensions");
    assert.equal(refusal(buildWebpLossless({ width: 200, height: 200, extended: {}, canvas: { width: 50_000, height: 50_000 } })), "too_large_dimensions");
    // 65 535 × 65 535 : le maximum d'un en-tête JPEG
    assert.equal(refusal(buildGrayJpeg({ width: 200, height: 200, declared: { width: 65_535, height: 65_535 } })), "too_large_dimensions");
    // Un PNG de 2^31 − 1 de côté et un d'une dimension nulle
    assert.equal(refusal(buildPng({ width: 200, height: 200, declared: { width: 0x7fffffff, height: 0x7fffffff } })), "too_large_dimensions");
    assert.equal(refusal(buildPng({ width: 200, height: 200, declared: { width: 0, height: 200 } })), "corrupt");
    assert.ok(performance.now() - started < 1_000, "refus immédiat : l'en-tête suffit");
  });
});

// ═════════════ 5. Métadonnées : EXIF, GPS, XMP, texte ═════════════

describe("suppression des métadonnées, vérifiée octet par octet", () => {
  test("JPEG : EXIF avec GPS, XMP, commentaire, APP13, MPF, vignette JFIF et octets après la fin sont retirés ; les segments utiles et les données de l'image restent", () => {
    const withIcc = jpegIccSegment();
    const input = buildGrayJpeg({
      width: 320, height: 240, gray: 77, jfifThumbnail: true,
      after: [jpegExifSegment({ gps: true }), jpegXmpSegment(), jpegSegment(0xfe, text("COMMENTAIRE-PRIVE")), jpegSegment(0xed, text("Photoshop 3.0\0 prive")), jpegSegment(0xe2, concatBytes(text("MPF\0"), new Uint8Array(30))), withIcc],
      trailing: concatBytes(text("Exif\0\0"), GPS_LATITUDE_BYTES),
    });
    for (const [label, needle] of SECRETS.slice(0, 7)) assert.ok(containsBytes(input, needle), `le fixture contient : ${label}`);
    const image = accepted(input);
    assertNoSecret(image.bytes);
    const walk = walkJpeg(image.bytes);
    const markers = walk.segments.map((segment) => segment.marker);
    assert.deepEqual(markers, [0xe0, 0xdb, 0xc0, 0xc4, 0xda, 0xd9], "JFIF, tables, cadre, balayage, fin : rien d'autre (le profil de couleur ICC est retiré aussi)");
    assert.ok(image.removed.filter((label) => label === "APP2").length === 2, "les deux APP2 (profil ICC et MPF) sont retirés");
    const jfif = walk.segments[0];
    assert.equal(jfif.length, 16, "JFIF réécrit sans vignette");
    assertValidAndStable(image);
    // Les données de l'image sont celles d'origine : octet pour octet.
    const clean = buildGrayJpeg({ width: 320, height: 240, gray: 77 });
    const entropyOf = (b: Uint8Array) => b.subarray(b.length - 2 - 10, b.length - 2);
    assert.deepEqual(entropyOf(image.bytes), entropyOf(clean));
  });

  test("JPEG : l'orientation est la SEULE donnée de l'EXIF conservée (sinon une photo prise en portrait s'afficherait couchée), dans un EXIF minimal sans GPS", () => {
    for (const orientation of [2, 3, 6, 8]) {
      const image = accepted(buildGrayJpeg({ width: 200, height: 300, after: [jpegExifSegment({ gps: true, orientation })] }));
      assertNoSecret(image.bytes, ["EXIF : en-tête"]);
      const exif = walkJpeg(image.bytes).segments.filter((segment) => segment.marker === 0xe1);
      assert.equal(exif.length, 1, `orientation ${orientation} : un seul APP1`);
      assert.equal(exif[0].length, 34, "EXIF minimal : 34 octets avec la longueur");
      // Un EXIF lu par un autre code : une seule entrée, l'étiquette 0x0112, la valeur demandée.
      const at = indexOf(image.bytes, text("Exif\0\0"));
      assert.ok(at > 0);
      const tiff = image.bytes.subarray(at + 6);
      assert.equal(String.fromCharCode(tiff[0], tiff[1]), "MM");
      assert.equal(u16(tiff, 8), 1, "une seule entrée");
      assert.equal(u16(tiff, 10), 0x0112);
      assert.equal(u16(tiff, 18), orientation);
      assertValidAndStable(image);
    }
    // Orientation normale (1), absente, ou illisible : aucun APP1.
    for (const options of [{ gps: true, orientation: 1 }, { gps: true }, { gps: true, orientation: 9 }, { gps: true, orientation: 0 }]) {
      const image = accepted(buildGrayJpeg({ width: 200, height: 300, after: [jpegExifSegment(options)] }));
      assert.equal(walkJpeg(image.bytes).segments.some((segment) => segment.marker === 0xe1), false, JSON.stringify(options));
      assertNoSecret(image.bytes);
    }
    // EXIF illisible : supprimé, pas d'exception.
    const garbage = accepted(buildGrayJpeg({ width: 200, height: 300, after: [jpegSegment(0xe1, concatBytes(text("Exif\0\0"), text("MM"), Uint8Array.of(0, 0x2a, 0xff, 0xff, 0xff, 0xff, 1, 2, 3)))] }));
    assert.equal(walkJpeg(garbage.bytes).segments.some((segment) => segment.marker === 0xe1), false);
  });

  test("PNG : tEXt, zTXt, iTXt (XMP), eXIf avec GPS, tIME, sPLT, morceaux privés, APNG et octets après IEND sont retirés ; les morceaux utiles et les pixels restent", () => {
    const icc = new Uint8Array(30).fill(3);
    const input = buildPng({
      width: 300, height: 220, pattern: "checker",
      before: [
        { type: "gAMA", data: Uint8Array.of(0, 1, 0x86, 0xa0) },
        { type: "iCCP", data: concatBytes(text("profil\0\0"), icc) },
        { type: "pHYs", data: Uint8Array.of(0, 0, 0x0e, 0xc4, 0, 0, 0x0e, 0xc4, 1) },
        { type: "tEXt", data: concatBytes(text("GPS Latitude\0"), text("5.3456")) },
        { type: "zTXt", data: concatBytes(text("GPS Longitude\0\0"), text("COMMENTAIRE-PRIVE")) },
        { type: "iTXt", data: concatBytes(text("XML:com.adobe.xmp\0\0\0\0\0"), text(XMP_GPS_TEXT)) },
        { type: "eXIf", data: buildExifTiff({ gps: true, orientation: 6 }) },
        { type: "tIME", data: Uint8Array.of(0x07, 0xea, 10, 7, 12, 34, 56) },
        { type: "sPLT", data: text("palette\0\x08") },
        { type: "acTL", data: Uint8Array.of(0, 0, 0, 2, 0, 0, 0, 0) },
        { type: "prVt", data: text("COMMENTAIRE-PRIVE") },
      ],
      after: [{ type: "eXIf", data: buildExifTiff({ gps: true }) }, { type: "tEXt", data: text("Comment\0COMMENTAIRE-PRIVE") }],
      trailing: concatBytes(text("Exif\0\0"), GPS_LATITUDE_BYTES),
    });
    const image = accepted(input);
    assertNoSecret(image.bytes);
    const walk = walkPng(image.bytes);
    assert.deepEqual(walk.chunks.map((chunk) => chunk.type), ["IHDR", "gAMA", "pHYs", "IDAT", "IEND"], "le profil de couleur (iCCP, et son NOM) est retiré aussi");
    assert.deepEqual([...image.removed].sort(), ["acTL", "eXIf", "eXIf", "iCCP", "iTXt", "prVt", "sPLT", "tEXt", "tEXt", "tIME", "zTXt"]);
    // Les pixels sont ceux d'origine et le fichier se décompresse en entier.
    const pixels = inflateSync(walk.chunks.find((chunk) => chunk.type === "IDAT")?.data as Uint8Array);
    assert.equal(pixels.length, 220 * (1 + 300 * 3));
    const original = buildPng({ width: 300, height: 220, pattern: "checker" });
    assert.deepEqual(walkPng(original).chunks.find((chunk) => chunk.type === "IDAT")?.data, walk.chunks.find((chunk) => chunk.type === "IDAT")?.data);
    assertValidAndStable(image);
  });

  test("PNG : un morceau utile qui apparaît APRÈS les données de l'image est supprimé (un décodeur l'ignorerait) ; plusieurs IDAT consécutifs sont gardés", () => {
    const base = buildPng({ width: 200, height: 200 });
    const walk = walkPng(base);
    const idat = walk.chunks.find((chunk) => chunk.type === "IDAT")?.data as Uint8Array;
    const half = Math.floor(idat.length / 2);
    const split = concatBytes(
      base.subarray(0, 8), pngChunk("IHDR", walk.chunks[0].data), pngChunk("IDAT", idat.subarray(0, half)), pngChunk("IDAT", idat.subarray(half)),
      pngChunk("gAMA", Uint8Array.of(0, 1, 0x86, 0xa0)), pngChunk("IEND", new Uint8Array(0)),
    );
    const image = accepted(split);
    assert.deepEqual(walkPng(image.bytes).chunks.map((chunk) => chunk.type), ["IHDR", "IDAT", "IDAT", "IEND"]);
    assert.deepEqual(image.removed, ["gAMA"]);
    // IDAT interrompu par un autre morceau puis repris : refusé.
    const interrupted = concatBytes(
      base.subarray(0, 8), pngChunk("IHDR", walk.chunks[0].data), pngChunk("IDAT", idat.subarray(0, half)), pngChunk("tEXt", text("a\0b")), pngChunk("IDAT", idat.subarray(half)), pngChunk("IEND", new Uint8Array(0)),
    );
    assert.equal(refusal(interrupted), "corrupt");
  });

  test("WebP : EXIF (GPS), XMP, profil de couleur (ICCP), blocs inconnus et octets après le conteneur sont retirés, les drapeaux VP8X sont mis à jour, la taille RIFF est exacte", () => {
    const icc = concatBytes(new Uint8Array(33).fill(9), text("Apple Inc. Canon Cocody 0708091011 GPS"));
    const input = buildWebpLossless({
      width: 320, height: 240, rgba: [10, 200, 30, 255],
      extended: { icc, exif: buildExifTiff({ gps: true, orientation: 6 }), xmp: text(XMP_GPS_TEXT) },
      trailing: concatBytes(text("Exif\0\0"), GPS_LATITUDE_BYTES),
    });
    assert.equal(walkWebp(input.subarray(0, le32(input, 4) + 8)).chunks.length, 5);
    const image = accepted(input);
    assertNoSecret(image.bytes);
    const walk = walkWebp(image.bytes);
    assert.deepEqual(walk.chunks.map((chunk) => chunk.fourcc), ["VP8X", "VP8L"]);
    assert.equal(walk.chunks[0].data[0], 0x00, "aucun drapeau ne reste levé : ni EXIF, ni XMP, ni profil de couleur");
    assert.deepEqual([...image.removed].sort(), ["EXIF", "ICCP", "XMP"]);
    assert.equal(walk.chunks[1].data.length, 13);
    assertValidAndStable(image);
    // Les 3 octets réservés de VP8X (qui pourraient cacher des données) sont remis à zéro ; la toile est intacte.
    const reservedSet = Uint8Array.from(buildWebpLossless({ width: 320, height: 240, extended: {} }));
    reservedSet.set([0xaa, 0xbb, 0xcc], 21);
    const reservedClean = walkWebp(accepted(reservedSet).bytes).chunks[0].data;
    assert.deepEqual([...reservedClean.subarray(1, 4)], [0, 0, 0], "octets réservés remis à zéro");
    assert.deepEqual([...reservedClean.subarray(4, 10)], [...walkWebp(reservedSet).chunks[0].data.subarray(4, 10)], "la toile est recopiée telle quelle");
    // Sans profil de couleur : le drapeau tombe aussi.
    const noIcc = accepted(buildWebpLossless({ width: 320, height: 240, extended: { exif: buildExifTiff({ gps: true }), xmp: text("x") } }));
    assert.equal(walkWebp(noIcc.bytes).chunks[0].data[0], 0x00);
    assertValidAndStable(noIcc);
    // Drapeau EXIF levé sans bloc EXIF, bloc EXIF sans drapeau : le résultat est cohérent dans les deux cas.
    const lying = Uint8Array.from(buildWebpLossless({ width: 320, height: 240, extended: {} }));
    lying[20] = 0x08 | 0x04; // octet des drapeaux de VP8X
    assert.equal(walkWebp(accepted(lying).bytes).chunks[0].data[0], 0x00);
  });

  test("WebP : format simple (sans VP8X) avec un bloc EXIF ajouté à la suite : supprimé ; avec perte (VP8) : flux reconnu et conservé", () => {
    const simple = buildWebpLossless({ width: 200, height: 200 });
    const withStray = riffFile(riffChunk("VP8L", simple.subarray(20, 20 + 13)), riffChunk("EXIF", buildExifTiff({ gps: true })));
    const image = accepted(withStray);
    assertNoSecret(image.bytes);
    assert.deepEqual(walkWebp(image.bytes).chunks.map((chunk) => chunk.fourcc), ["VP8L"]);
    const lossy = accepted(riffFile(riffChunk("VP8 ", fakeVp8(640, 480)), riffChunk("EXIF", buildExifTiff({ gps: true }))));
    assert.deepEqual([lossy.width, lossy.height, lossy.mime], [640, 480, "image/webp"]);
    assert.deepEqual(walkWebp(lossy.bytes).chunks.map((chunk) => chunk.fourcc), ["VP8 "]);
    // Lossy + alpha étendu : ALPH est conservé juste avant VP8.
    const vp8x = (flags: number, w: number, h: number) => Uint8Array.of(flags, 0, 0, 0, (w - 1) & 0xff, (w - 1) >> 8, 0, (h - 1) & 0xff, (h - 1) >> 8, 0);
    const alpha = accepted(riffFile(riffChunk("VP8X", vp8x(0x10 | 0x08, 640, 480)), riffChunk("ALPH", new Uint8Array(7)), riffChunk("VP8 ", fakeVp8(640, 480)), riffChunk("EXIF", buildExifTiff({ gps: true }))));
    assert.deepEqual(walkWebp(alpha.bytes).chunks.map((chunk) => chunk.fourcc), ["VP8X", "ALPH", "VP8 "]);
    assert.equal(walkWebp(alpha.bytes).chunks[0].data[0], 0x10, "alpha conservé, EXIF retiré");
    assertValidAndStable(alpha);
  });

  test("WebP animé (drapeau, ANIM ou ANMF) refusé", () => {
    const vp8x = (flags: number) => Uint8Array.of(flags, 0, 0, 0, 199, 0, 0, 199, 0, 0);
    const lossless = buildWebpLossless({ width: 200, height: 200 }).subarray(20, 20 + 13);
    assert.equal(refusal(riffFile(riffChunk("VP8X", vp8x(0x02)), riffChunk("VP8L", lossless))), "animated");
    assert.equal(refusal(riffFile(riffChunk("VP8X", vp8x(0x00)), riffChunk("ANIM", new Uint8Array(6)), riffChunk("VP8L", lossless))), "animated");
    assert.equal(refusal(riffFile(riffChunk("VP8X", vp8x(0x02)), riffChunk("ANIM", new Uint8Array(6)), riffChunk("ANMF", new Uint8Array(16)))), "animated");
  });
});

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let same = true;
    for (let index = 0; index < needle.length && same; index += 1) same = haystack[start + index] === needle[index];
    if (same) return start;
  }
  return -1;
}

// ═════════════ 5 bis. Fichiers « cuisine » (PH1-bis) : profils de couleur compris ═════════════

describe("fichiers « cuisine » : aucune chaîne secrète ne survit, profils ICC compris, et l'image reste valide", () => {
  const kitchens: Array<[string, Uint8Array<ArrayBuffer>]> = [["jpeg", buildKitchenJpeg()], ["png", buildKitchenPng()], ["webp", buildKitchenWebp()]];

  test("les fichiers de départ portent TOUTES les chaînes interdites (le piège est réel) : EXIF/GPS, XMP, commentaire HTML, faux profil ICC avec nom de fabricant, nom de bloc iCCP, bloc ICCP, texte après la fin", () => {
    for (const [label, input] of kitchens) {
      const missing = KITCHEN_FORBIDDEN.filter((needle) => !containsBytes(input, needle) && !(label !== "png" && needle === "iCCP") && !(label !== "webp" && needle === "ICCP"));
      // « Apple Inc. » et « Canon » ne sont pas toujours en clair dans un bloc compressé (PNG) : ils sont dans le nom ou dans le texte ajouté.
      assert.deepEqual(missing.filter((needle) => !["Apple Inc.", "PK\x03\x04", "<html", "<script", "ICC_PROFILE", "xpacket"].includes(needle)), [], `${label} : ${missing.join(", ")}`);
    }
    assert.ok(containsBytes(kitchens[0][1], "ICC_PROFILE") && containsBytes(kitchens[0][1], "Apple Inc."), "JPEG : faux profil ICC avec nom de fabricant");
    assert.ok(containsBytes(kitchens[1][1], "iCCP") && containsBytes(kitchens[1][1], "GPS 5.3453N Canon EOS 0708091011"), "PNG : le NOM du bloc iCCP porte le secret");
    assert.ok(containsBytes(kitchens[2][1], "ICCP") && containsBytes(kitchens[2][1], KITCHEN_SECRET), "WebP : le bloc ICCP porte le secret");
  });

  test("JPEG : APP2 « ICC_PROFILE » (EXIF, secret, fabricant) retiré avec tout le reste ; l'orientation survit seule ; la structure est valide et stable", () => {
    const image = accepted(buildKitchenJpeg());
    for (const needle of KITCHEN_FORBIDDEN) assert.equal(containsBytes(image.bytes, needle), false, `JPEG nettoyé contient « ${needle} »`);
    assertNoSecret(image.bytes, ["EXIF : en-tête"]);
    const walk = walkJpeg(image.bytes);
    assert.deepEqual(walk.segments.map((segment) => segment.marker), [0xe0, 0xe1, 0xdb, 0xc0, 0xc4, 0xda, 0xd9], "JFIF, EXIF minimal (orientation), tables, cadre, balayage, fin");
    assert.equal(walk.segments[1].length, 34, "l'EXIF restant est le minimal de 34 octets");
    assert.deepEqual([image.width, image.height], [300, 200]);
    assertValidAndStable(image);
    // Un APP2 « ICC_PROFILE » SEUL (sans autre métadonnée) est retiré aussi.
    const onlyIcc = accepted(buildGrayJpeg({ width: 220, height: 220, after: [jpegIccSegment()] }));
    assert.deepEqual(walkJpeg(onlyIcc.bytes).segments.map((segment) => segment.marker), [0xe0, 0xdb, 0xc0, 0xc4, 0xda, 0xd9]);
    assert.deepEqual(onlyIcc.removed, ["APP2"]);
    assertNoSecret(onlyIcc.bytes);
  });

  test("PNG : le bloc iCCP (son NOM comme son contenu) est retiré avec tEXt, zTXt, iTXt, eXIf, tIME et le texte après IEND ; les pixels restent intacts et décompressent en entier", () => {
    const image = accepted(buildKitchenPng());
    for (const needle of KITCHEN_FORBIDDEN) assert.equal(containsBytes(image.bytes, needle), false, `PNG nettoyé contient « ${needle} »`);
    assertNoSecret(image.bytes);
    const walk = walkPng(image.bytes);
    assert.deepEqual(walk.chunks.map((chunk) => chunk.type), ["IHDR", "IDAT", "IEND"]);
    assert.deepEqual([...image.removed].sort(), ["eXIf", "iCCP", "iTXt", "tEXt", "tIME", "zTXt"]);
    assert.equal(inflateSync(walk.chunks[1].data).length, 240 * (1 + 320 * 3));
    assertValidAndStable(image);
  });

  test("WebP : le bloc ICCP (contenu secret) est retiré avec EXIF, XMP, le bloc inconnu et le texte après le conteneur ; le drapeau VP8X et la taille RIFF sont recalculés", () => {
    const image = accepted(buildKitchenWebp());
    for (const needle of KITCHEN_FORBIDDEN) assert.equal(containsBytes(image.bytes, needle), false, `WebP nettoyé contient « ${needle} »`);
    assertNoSecret(image.bytes);
    const walk = walkWebp(image.bytes);
    assert.deepEqual(walk.chunks.map((chunk) => chunk.fourcc), ["VP8X", "VP8L"]);
    assert.equal(walk.chunks[0].data[0], 0x00, "ni EXIF, ni XMP, ni profil de couleur");
    assert.deepEqual([...image.removed].sort(), ["EXIF", "ICCP", "XMP", "ZZZZ"]);
    assert.deepEqual([image.width, image.height], [400, 300]);
    assertValidAndStable(image);
  });

  test("avec un VRAI décodeur (PIL, si python3 et PIL sont présents) : les trois fichiers nettoyés s'ouvrent, ont la taille annoncée et ne portent plus ni profil ICC, ni EXIF, ni texte", (context) => {
    const probe = spawnSync("python3", ["-I", "-c", "import PIL"], { encoding: "utf8" });
    if (probe.status !== 0) {
      context.skip("python3 ou PIL absent");
      return;
    }
    const script = `
import sys, io
from PIL import Image
data = sys.stdin.buffer.read()
image = Image.open(io.BytesIO(data)); image.load()
print(image.format, image.size[0], image.size[1], "icc_profile" in image.info, len(image.getexif()), sorted(k for k in image.info if k not in ("dpi", "jfif", "jfif_version", "jfif_unit", "jfif_density", "gamma", "srgb", "transparency", "adobe", "adobe_transform", "background", "progressive", "progression")))
`;
    for (const [label, input] of kitchens) {
      const image = accepted(input);
      const decoded = spawnSync("python3", ["-I", "-c", script], { input: image.bytes, encoding: "utf8" });
      assert.equal(decoded.status, 0, `${label} : ${decoded.stderr}`);
      const [format, width, height, hasIcc, exifEntries, extra] = decoded.stdout.trim().split(" ", 6).concat([""]);
      assert.deepEqual([format, Number(width), Number(height)], [label === "jpeg" ? "JPEG" : label === "png" ? "PNG" : "WEBP", image.width, image.height], label);
      assert.equal(hasIcc, "False", `${label} : profil ICC`);
      assert.equal(Number(exifEntries) <= (label === "jpeg" ? 1 : 0), true, `${label} : entrées EXIF = ${exifEntries}`);
      assert.ok(!/GPS|Canon|Cocody|0708091011/.test(decoded.stdout + extra), `${label} : ${decoded.stdout}`);
    }
  });
});

// ═════════════ 6. Structures invalides ═════════════

describe("structures invalides refusées", () => {
  test("JPEG : deux cadres, cadre absent, balayage avant le cadre, SOF sans perte ou arithmétique, précision 12 bits, hauteur nulle, composantes impossibles, longueur de segment impossible", () => {
    const base = buildGrayJpeg({ width: 200, height: 200 });
    const sofAt = indexOf(base, Uint8Array.of(0xff, 0xc0));
    assert.ok(sofAt > 0);
    const sofSegment = base.subarray(sofAt, sofAt + 2 + 11);
    const twice = concatBytes(base.subarray(0, sofAt), sofSegment, base.subarray(sofAt));
    assert.equal(refusal(twice), "corrupt", "deux cadres");
    const noFrame = concatBytes(base.subarray(0, sofAt), base.subarray(sofAt + 13));
    assert.equal(refusal(noFrame), "corrupt", "balayage sans cadre");
    for (const marker of [0xc3, 0xc9, 0xca, 0xc5, 0xcf]) {
      const changed = Uint8Array.from(base);
      changed[sofAt + 1] = marker;
      assert.equal(refusal(changed), "unsupported_type", `SOF 0x${marker.toString(16)}`);
    }
    const progressive = Uint8Array.from(base);
    progressive[sofAt + 1] = 0xc2;
    assert.equal(accepted(progressive).mime, "image/jpeg", "progressif (SOF2) accepté");
    const mutate = (index: number, value: number): Uint8Array => {
      const changed = Uint8Array.from(base);
      changed[sofAt + index] = value;
      return changed;
    };
    assert.equal(refusal(mutate(4, 12)), "corrupt", "précision 12 bits");
    assert.equal(refusal(concatBytes(mutate(5, 0).subarray(0, sofAt + 5), Uint8Array.of(0, 0), base.subarray(sofAt + 7))), "corrupt", "hauteur nulle");
    assert.equal(refusal(mutate(9, 2)), "corrupt", "deux composantes avec une longueur de trois");
    const dqtAt = indexOf(base, Uint8Array.of(0xff, 0xdb));
    const tooShort = Uint8Array.from(base);
    tooShort[dqtAt + 2] = 0;
    tooShort[dqtAt + 3] = 1; // longueur de segment inférieure à 2
    assert.equal(refusal(tooShort), "corrupt");
    const tooLong = Uint8Array.from(base);
    tooLong[dqtAt + 2] = 0xff;
    tooLong[dqtAt + 3] = 0xff; // longueur de segment qui dépasse le fichier
    assert.equal(refusal(tooLong), "truncated");
    assert.equal(refusal(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)), "corrupt", "fin d'image sans cadre ni balayage");
    assert.equal(refusal(Uint8Array.of(0xff, 0xd8, 0xff, 0xd8, 0xff, 0xd9)), "corrupt", "second SOI");
  });

  test("PNG : signature seule, IHDR absent ou de mauvaise taille, IHDR répété, CRC faux, profondeur incompatible, compression inconnue, palette absente ou interdite, IDAT absent, IEND non vide", () => {
    const sig = buildPng({ width: 200, height: 200 }).subarray(0, 8);
    const ihdrData = (width: number, height: number, depth: number, color: number, compression = 0, filter = 0, interlace = 0): Uint8Array =>
      concatBytes(Uint8Array.of(0, 0, (width >> 8) & 0xff, width & 0xff, 0, 0, (height >> 8) & 0xff, height & 0xff, depth, color, compression, filter, interlace));
    const idat = pngChunk("IDAT", Uint8Array.of(0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01));
    const iend = pngChunk("IEND", new Uint8Array(0));
    assert.equal(refusal(sig), "truncated");
    assert.equal(refusal(concatBytes(sig, idat, iend)), "corrupt", "IHDR absent");
    assert.equal(refusal(concatBytes(sig, pngChunk("IHDR", new Uint8Array(12)), idat, iend)), "corrupt", "IHDR trop court");
    assert.equal(refusal(concatBytes(sig, pngChunk("IHDR", ihdrData(200, 200, 8, 2)), pngChunk("IHDR", ihdrData(200, 200, 8, 2)), idat, iend)), "corrupt", "IHDR répété");
    assert.equal(accepted(concatBytes(sig, pngChunk("IHDR", ihdrData(200, 200, 8, 2)), idat, iend)).width, 200, "structure minimale valide (les pixels ne sont pas décodés)");
    assert.equal(refusal(concatBytes(sig, pngChunk("IHDR", ihdrData(200, 200, 16, 3)), idat, iend)), "corrupt", "profondeur 16 interdite avec palette");
    assert.equal(refusal(concatBytes(sig, pngChunk("IHDR", ihdrData(200, 200, 8, 5)), idat, iend)), "corrupt", "type de couleur 5");
    assert.equal(refusal(concatBytes(sig, pngChunk("IHDR", ihdrData(200, 200, 8, 2, 1)), idat, iend)), "corrupt", "compression inconnue");
    assert.equal(refusal(concatBytes(sig, pngChunk("IHDR", ihdrData(200, 200, 8, 2, 0, 0, 2)), idat, iend)), "corrupt", "entrelacement inconnu");
    assert.equal(refusal(concatBytes(sig, pngChunk("IHDR", ihdrData(200, 200, 8, 3)), idat, iend)), "corrupt", "palette absente");
    assert.equal(accepted(concatBytes(sig, pngChunk("IHDR", ihdrData(200, 200, 8, 3)), pngChunk("PLTE", new Uint8Array(6)), idat, iend)).width, 200);
    assert.equal(refusal(concatBytes(sig, pngChunk("IHDR", ihdrData(200, 200, 8, 0)), pngChunk("PLTE", new Uint8Array(6)), idat, iend)), "corrupt", "palette interdite en niveaux de gris");
    assert.equal(refusal(concatBytes(sig, pngChunk("IHDR", ihdrData(200, 200, 8, 2)), iend)), "corrupt", "IDAT absent");
    assert.equal(refusal(concatBytes(sig, pngChunk("IHDR", ihdrData(200, 200, 8, 2)), idat, pngChunk("IEND", Uint8Array.of(1)))), "corrupt", "IEND non vide");
    const badCrc = Uint8Array.from(concatBytes(sig, pngChunk("IHDR", ihdrData(200, 200, 8, 2)), idat, iend));
    badCrc[8 + 8 + 13 + 1] ^= 1;
    assert.equal(refusal(badCrc), "corrupt", "CRC d'IHDR faux");
  });

  test("WebP : RIFF trop court ou taille annoncée supérieure au fichier, premier bloc inconnu, deux flux d'image, flux invalide, bloc dont la taille dépasse le conteneur", () => {
    const lossless = buildWebpLossless({ width: 200, height: 200 }).subarray(20, 20 + 13);
    assert.equal(refusal(concatBytes(text("RIFF"), Uint8Array.of(4, 0, 0, 0), text("WEBP"))), "corrupt", "aucun bloc");
    assert.equal(refusal(riffFile(riffChunk("ABCD", new Uint8Array(4)))), "corrupt", "premier bloc inconnu");
    assert.equal(refusal(riffFile(riffChunk("VP8L", lossless), riffChunk("VP8L", lossless))), "corrupt", "deux flux");
    assert.equal(refusal(riffFile(riffChunk("VP8L", Uint8Array.of(0x2f, 0, 0, 0)))), "corrupt", "flux trop court");
    assert.equal(refusal(riffFile(riffChunk("VP8L", Uint8Array.of(0x2e, 0, 0, 0, 0)))), "corrupt", "signature VP8L fausse");
    assert.equal(refusal(riffFile(riffChunk("VP8 ", new Uint8Array(12)))), "corrupt", "VP8 sans code de départ");
    const oversized = Uint8Array.from(riffFile(riffChunk("VP8L", lossless)));
    oversized[16] = 0xff;
    oversized[17] = 0xff; // taille du bloc : bien plus grande que le conteneur
    assert.ok(["truncated", "corrupt"].includes(refusal(oversized)));
    const oddRiff = Uint8Array.from(riffFile(riffChunk("VP8L", lossless)));
    oddRiff[4] += 1;
    assert.ok(["truncated", "corrupt"].includes(refusal(oddRiff)));
  });
});

// ═════════════ 7. Mutations aléatoires ═════════════

describe("mutations aléatoires (jamais d'exception ; ce qui est accepté est valide, stable et sans secret)", () => {
  function generator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  const fixtures: Array<[string, Uint8Array]> = [
    ["jpeg", buildGrayJpeg({ width: 200, height: 200, after: [jpegExifSegment({ gps: true, orientation: 6 }), jpegXmpSegment(), jpegSegment(0xfe, text("COMMENTAIRE-PRIVE"))], trailing: text("<script>alert(1)</script>") })],
    ["png", buildPng({ width: 200, height: 200, pattern: "diagonal", before: [{ type: "tEXt", data: text("GPS Latitude\0COMMENTAIRE-PRIVE") }, { type: "eXIf", data: buildExifTiff({ gps: true }) }], trailing: text("<script>alert(1)</script>") })],
    ["webp", buildWebpLossless({ width: 200, height: 200, extended: { icc: new Uint8Array(21), exif: buildExifTiff({ gps: true }), xmp: text(XMP_GPS_TEXT) }, trailing: text("<script>alert(1)</script>") })],
  ];

  for (const [label, original] of fixtures) {
    test(`${label} : 4 000 mutations d'octets, de coupes et d'insertions`, () => {
      const random = generator(label.length * 7919);
      let accepted = 0;
      let refused = 0;
      for (let round = 0; round < 4_000; round += 1) {
        const bytes = Uint8Array.from(original);
        const kind = Math.floor(random() * 4);
        let candidate: Uint8Array = bytes;
        if (kind === 0) for (let index = 0; index < 1 + Math.floor(random() * 4); index += 1) candidate[Math.floor(random() * candidate.length)] = Math.floor(random() * 256);
        else if (kind === 1) candidate = bytes.subarray(0, Math.floor(random() * bytes.length));
        else if (kind === 2) {
          const at = Math.floor(random() * bytes.length);
          candidate = concatBytes(bytes.subarray(0, at), Uint8Array.of(Math.floor(random() * 256), Math.floor(random() * 256)), bytes.subarray(at));
        } else {
          const at = Math.floor(random() * bytes.length);
          candidate = concatBytes(bytes.subarray(0, at), bytes.subarray(at + 1 + Math.floor(random() * 5)));
        }
        const result = sanitizeImage(candidate);
        if (!result.ok) {
          refused += 1;
          assert.ok(["unsupported_type", "corrupt", "truncated", "too_small", "too_large_dimensions", "too_many_pixels", "animated"].includes(result.reason));
          continue;
        }
        accepted += 1;
        assertValidAndStable(result.image);
        assert.ok(result.image.bytes.length <= candidate.length + 40, "le fichier nettoyé n'est jamais plus gros que l'original (hors EXIF d'orientation)");
        assertNoSecret(result.image.bytes, ["EXIF : en-tête"]);
      }
      assert.ok(accepted > 0 && refused > 0, `${accepted} acceptés, ${refused} refusés`);
    });
  }
});

// ═════════════ 8. Fixtures décodables ═════════════

describe("fixtures fabriquées sans dépendance", () => {
  test("les PNG fabriqués se décompressent en entier (dimensions et nombre d'octets exacts) et sont déterministes", () => {
    const png = buildPng({ width: 480, height: 360, color: [90, 140, 110], pattern: "stripes" });
    const walk = walkPng(png);
    const pixels = inflateSync(walk.chunks.find((chunk) => chunk.type === "IDAT")?.data as Uint8Array);
    assert.equal(pixels.length, 360 * (1 + 480 * 3));
    assert.deepEqual(buildPng({ width: 480, height: 360, color: [90, 140, 110], pattern: "stripes" }), png);
    assert.ok(png.length < 20_000, `${png.length} octets`);
  });
});

