import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(dir, "../.env.local") });

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
export const POC_MODELS = (process.env.POC_MODELS ?? "openai/gpt-4o-mini")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const CHROME_PATH =
  process.env.CHROME_PATH ?? "/usr/bin/google-chrome-stable";

export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Besoin de DÉMONSTRATION — utilisé seulement si aucun besoin n'est fourni
// sur la ligne de commande (signalé explicitement dans les logs).
export const NEED = {
  text: "iPhone 12 · 128 Go, bon état, à Abidjan, max 150 000 FCFA",
};

export const FB_URL =
  "https://www.facebook.com/marketplace/abidjan/search?query=iphone%2012";
export const COINAFRIQUE_URL =
  "https://ci.coinafrique.com/search?keyword=iphone%2012";
export const LOCANTO_URL = "https://www.locanto.ci/recherche/?q=iphone%2012";
export const ONLINE_MODEL = process.env.ONLINE_MODEL ?? "openai/gpt-4o-mini:online";
export const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY ?? "";
export const GOOGLE_CX = process.env.GOOGLE_CX ?? "";

