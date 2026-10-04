/**
 * Preuves navigateur (captures/HTML) — revue P2 : des recherches simultanées
 * ne doivent pas écraser leurs preuves. Les captures sont écrites SEULEMENT
 * quand le run demande des artefacts (`artifactsDir`), dans un dossier PAR
 * SOURCE, jamais dans un chemin partagé fixe.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runCtx } from "./log";

export function evidenceDir(source: string): string | null {
  const dir = runCtx()?.artifactsDir;
  if (!dir) return null; // aucun artefact demandé → aucune écriture
  const path = join(dir, `evidence-${source}`);
  mkdirSync(path, { recursive: true });
  return path;
}