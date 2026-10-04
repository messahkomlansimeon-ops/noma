import { parseNeed } from "./lib/need";
import { fetchCoinAfrique } from "./sources/coinafrique";

const need = parseNeed(process.argv.slice(2).join(" ") || "iPhone 12 128 Go à Abidjan");
const r = await fetchCoinAfrique(need);
console.log(`${r.source} · statut ${r.status} · ${r.listings.length} annonces · ${r.durationMs} ms · erreurs: ${r.errors.join("; ") || "—"}`);
console.log(`requête : ${r.query}`);
for (const l of r.listings.slice(0, 6)) {
  console.log(`· ${l.title} — ${l.price ?? "?"} ${l.currency} — ${l.zone ?? "?"} — ${l.date ?? "date ?"}`);
}
if (r.listings.length > 6) console.log(`… +${r.listings.length - 6} autres`);
