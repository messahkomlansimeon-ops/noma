import type { Pool } from "pg";
import { sanitizeImage } from "../lib/server/media/image";
import { uploadPhoto } from "../lib/server/media/photos";
import type { MediaStore } from "../lib/server/media/store";
import type { DemoOffer } from "./demo-seed-plan";
import { demoPhotoPng } from "./photo-fixtures";

/**
 * Photos de démonstration (lot PH1), appelées par `demo:seed` : UNE photo synthétique par annonce (PNG produit avec le zlib de Node : couleur choisie par produit, motif par annonce,
 * aucune dépendance, aucun appel externe). Passe par le VRAI service d'envoi (mêmes contrôles, même nettoyage, même stockage) : l'empreinte du fichier est unique par annonce, donc
 * rejouer `demo:seed` ne crée aucun doublon. Voir PHOTOS.md.
 */

export interface DemoPhotosReport {
  added: number;
  existing: number;
}

export async function seedDemoPhotos(input: {
  pool: Pool;
  store: MediaStore;
  offers: ReadonlyArray<{ offer: DemoOffer; offerId: string; ownerId: string }>;
}): Promise<DemoPhotosReport> {
  const report: DemoPhotosReport = { added: 0, existing: 0 };
  for (const { offer, offerId, ownerId } of input.offers) {
    const sanitized = sanitizeImage(demoPhotoPng(offer, offer.key));
    if (!sanitized.ok) throw new Error(`photo de démonstration refusée (${sanitized.reason})`);
    const result = await uploadPhoto({ pool: input.pool, store: input.store, ownerId, offerId, image: sanitized.image });
    if (result.created) report.added += 1;
    else report.existing += 1;
  }
  return report;
}
