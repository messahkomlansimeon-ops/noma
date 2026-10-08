import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { renderToString } from "react-dom/server";
import { BuyerMatchCard } from "../../components/matches/match-parts";
import { PhotoCover } from "../../components/photos/photo-cover";
import { PhotoGallery } from "../../components/photos/photo-gallery";
import { PhotoPicker } from "../../components/photos/photo-picker";
import { Thumb } from "../../components/thumb";
import type { StoredMatch } from "../../lib/client/api";
import { PHOTO_ACCEPT_ATTRIBUTE } from "../../lib/client/photos-api";
import { addPicked, type PickedFile } from "../../lib/client/photos-queue";
import { PHONE_REMINDER } from "../../lib/client/photos-view";

/** Écrans des photos (lot PH1) : vignette de couverture avec repli sur l'icône, galerie de la fiche, sélecteur du formulaire, rappel au vendeur, garde-fous du code source. */

const ROOT = join(import.meta.dirname, "../..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const PHOTO_A = "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const PHOTO_B = "2a2a2a2a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const PHOTO_C = "3a3a3a3a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";

describe("vignette de couverture", () => {
  test("PhotoCover : l'image de /api/media/{id}, chargement paresseux, sans référent ; un identifiant invalide donne le repli", () => {
    const html = renderToString(<PhotoCover photoId={PHOTO_A} className="size-14" fallback={<span data-fallback>icône</span>} />);
    assert.match(html, new RegExp(`<img[^>]*src="/api/media/${PHOTO_A}"`));
    assert.match(html, /loading="lazy"/);
    assert.match(html, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i);
    assert.match(html, /object-cover/);
    assert.ok(!html.includes("data-fallback"));
    for (const bad of ["../../etc/passwd", "", "javascript:alert(1)", `${PHOTO_A}/../x`]) {
      const fallback = renderToString(<PhotoCover photoId={bad} fallback={<span data-fallback>icône</span>} />);
      assert.ok(fallback.includes("data-fallback") && !fallback.includes("<img"), bad);
    }
  });

  test("Thumb : sans photo, l'icône d'avant (aucune image) ; avec photo, la vignette ; l'icône reste le repli", () => {
    const icon = renderToString(<Thumb art="phone" />);
    assert.ok(!icon.includes("<img") && icon.includes("<svg"));
    assert.equal(renderToString(<Thumb art="phone" photoId={null} />), icon, "photoId nul : strictement le même rendu qu'avant");
    assert.equal(renderToString(<Thumb art="phone" photoId={undefined} />), icon);
    const withPhoto = renderToString(<Thumb art="phone" photoId={PHOTO_A} className="size-12" />);
    assert.match(withPhoto, new RegExp(`src="/api/media/${PHOTO_A}"`));
    assert.match(withPhoto, /size-12/);
  });

  test("carte d'un résultat : la couverture quand l'annonce en a une, l'icône sinon", () => {
    const item: StoredMatch = {
      candidateId: PHOTO_B, candidate: { category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion", quantity: null, unit: null, location: "Abidjan", deadlineAt: null, price: { amount: 150_000, currency: "XOF" }, budget: null, availabilityStatus: "available" },
      compatibilityStatus: "compatible", score: 90, coverage: 1, evaluatedAt: "2031-01-01T10:00:00.000Z",
      indicators: { availability: null, price: null, confidence: { level: "high", score: 90, accountAgeBand: "gte_30d", factors: [] } }, relevance: 80, sponsored: false, proBadge: false,
    };
    const plain = renderToString(<ul><BuyerMatchCard item={item} detailHref="/besoins/x/offres/y" /></ul>);
    assert.ok(!plain.includes("<img"), "sans couverture : pas d'image");
    const covered = renderToString(<ul><BuyerMatchCard item={{ ...item, coverPhotoId: PHOTO_A }} detailHref="/besoins/x/offres/y" /></ul>);
    assert.match(covered, new RegExp(`src="/api/media/${PHOTO_A}"`));
    assert.equal(covered.match(/<img/g)?.length, 1);
  });
});

describe("galerie de la fiche", () => {
  const refs = [{ id: PHOTO_A, width: 640, height: 480 }, { id: PHOTO_B, width: 800, height: 600 }, { id: PHOTO_C, width: 300, height: 200 }];

  test("la première photo en grand (chargement immédiat, place réservée), les vignettes dessous, texte alternatif en mots simples", () => {
    const html = renderToString(<PhotoGallery photos={refs} title="iPhone 12" />);
    assert.match(html, /data-testid="photo-gallery"/);
    const main = /<img[^>]*data-testid="gallery-main"[^>]*>/.exec(html)?.[0] ?? "";
    assert.ok(main.includes(`/api/media/${PHOTO_A}`));
    assert.match(main, /loading="eager"/);
    assert.match(main, /alt="iPhone 12 : photo 1 sur 3"/);
    assert.match(main, /width="640"/);
    assert.match(main, /height="480"/);
    assert.match(html, /aspect-ratio:\s*4 \/ 3/);
    assert.equal(html.match(/data-testid="gallery-thumb"/g)?.length, 3);
    assert.match(html, /aria-label="Voir la photo 2 sur 3"/);
    assert.match(html, /aria-current="true"/);
    for (const id of [PHOTO_A, PHOTO_B, PHOTO_C]) assert.ok(html.includes(`/api/media/${id}`));
  });

  test("une seule photo : pas de rangée de vignettes ; aucune photo (ou références invalides) : rien du tout", () => {
    const single = renderToString(<PhotoGallery photos={[refs[0]]} title="iPhone 12" />);
    assert.ok(!single.includes("gallery-thumb"));
    assert.match(single, /alt="iPhone 12 : photo"/);
    assert.equal(renderToString(<PhotoGallery photos={[]} title="x" />), "");
    assert.equal(renderToString(<PhotoGallery photos={[{ id: "../../etc/passwd", width: 1, height: 1 }]} title="x" />), "");
  });
});

describe("sélecteur de photos du formulaire", () => {
  const file = (name: string): PickedFile => Object.assign(new Blob([new Uint8Array(8)], { type: "image/png" }), { name });

  test("le rappel (numéro écrit dans une photo), les formats, la limite de 6, la couverture et les erreurs en mots simples", () => {
    const empty = renderToString(<PhotoPicker items={[]} onChange={() => {}} />);
    assert.ok(empty.includes(PHONE_REMINDER.replaceAll("'", "&#x27;")), "le rappel est affiché");
    assert.match(empty, /data-testid="photo-phone-reminder"/);
    assert.match(empty, new RegExp(`accept="${PHOTO_ACCEPT_ATTRIBUTE}"`));
    assert.match(empty, /Ajouter des photos/);
    assert.match(empty, /0 photo sur 6/);
    const six = addPicked([], Array.from({ length: 6 }, (_, index) => file(`p${index}.png`)), () => null).items;
    const full = renderToString(<PhotoPicker items={six} onChange={() => {}} />);
    assert.ok(!full.includes('type="file"'), "6 photos : plus de champ d'ajout");
    assert.match(full, /6 photos sur 6/);
    assert.equal(full.match(/Couverture/g)?.length, 1, "seule la première photo est la couverture");
    const failed = renderToString(<PhotoPicker items={[{ ...six[0], status: "failed", error: "Cette photo est trop petite : 200 pixels au moins de chaque côté." }]} onChange={() => {}} />);
    assert.match(failed, /role="alert"/);
    assert.match(failed, /Cette photo est trop petite/);
    const disabled = renderToString(<PhotoPicker items={six.slice(0, 1)} onChange={() => {}} disabled />);
    assert.match(disabled, /disabled=""/);
  });
});

describe("garde-fous du code source", () => {
  const sources = readdirSync(join(ROOT, "components/photos")).map((name) => `components/photos/${name}`);

  test("jamais de HTML injecté ; chaque image est paresseuse (hors la photo principale de la galerie) et sans référent", () => {
    for (const path of sources) {
      const source = read(path);
      assert.ok(!/dangerouslySetInnerHTML|innerHTML|eval\(|document\.write/.test(source), path);
      for (const tag of source.match(/<img[\s\S]*?\/>/g) ?? []) {
        assert.match(tag, /referrerPolicy="no-referrer"|src=\{item\.previewUrl\}/, `${path} : image sans référent`);
        if (!tag.includes("gallery-main") && !tag.includes("previewUrl")) assert.match(tag, /loading="lazy"/, `${path} : image sans chargement paresseux`);
      }
    }
  });

  test("les écrans sont branchés : galerie sur la fiche, gestionnaire sur la page de l'annonce, sélecteur dans le formulaire, vignette sur les cartes, le tableau de bord et les favoris ; rappel partout où l'on ajoute", () => {
    assert.match(read("app/(buyer)/besoins/[id]/offres/[offerId]/page.tsx"), /<PhotoGallery photos=\{detail\.details\.photos \?\? \[\]\}/);
    assert.match(read("app/(vendor)/vendeur/annonces/[id]/page.tsx"), /<PhotoManager offerId=\{offer\.id\}/);
    assert.match(read("components/vendor/nouvelle-annonce-form.tsx"), /<PhotoPicker items=\{photos\}/);
    assert.match(read("components/matches/match-parts.tsx"), /photoId=\{item\.coverPhotoId\}/);
    assert.match(read("app/(vendor)/vendeur/page.tsx"), /photoId=\{offer\.coverPhotoId\}/);
    assert.match(read("app/(buyer)/favoris/page.tsx"), /<PhotoCover photoId=\{row\.coverPhotoId\}/);
    for (const path of ["components/photos/photo-manager.tsx", "components/photos/photo-picker.tsx"]) assert.match(read(path), /PHONE_REMINDER/, path);
    assert.match(read("components/vendor/nouvelle-annonce-form.tsx"), /uploadPicked\(created\.id, photos/, "les photos partent après la création de l'annonce");
  });
});
