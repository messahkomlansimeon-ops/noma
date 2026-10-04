import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { RawListing } from "../lib/normalize";

export interface CoinAfriqueExtractionInput {
  html: string;
  baseUrl: string;
}

export interface CoinAfriqueExtraction {
  listings: RawListing[];
  errors: string[];
}

export type CoinAfriqueExtractor = (
  input: CoinAfriqueExtractionInput,
) => Promise<CoinAfriqueExtraction>;

function parseCard(
  $: cheerio.CheerioAPI,
  card: Element,
  i: number,
  baseUrl: string,
): RawListing | null {
  try {
    const $card = $(card);
    const link = $card.find("a.ad__card-image").first();
    const href = link.attr("href") ?? null;
    const favoriteTitle = $card.find(".card-fav").attr("data-ad-title")?.trim() || null;
    const linkTitle = link.attr("title")?.trim() || null;
    const title = favoriteTitle ?? linkTitle;
    if (!href || !title) return null;

    const idMatch = href.match(/(\d+)\s*$/);
    if (!idMatch) return null;

    const priceRaw = $card.find(".card-fav").attr("data-ad-price") ?? null;
    const price = priceRaw ? Number.parseFloat(priceRaw) : null;
    const photo = $card.find("img.ad__card-img").attr("src") ?? null;
    const location =
      $card.find("p.ad__card-location span").first().text().trim() || null;
    const times = $card
      .find(".ad__card-timesince span")
      .map((_, el) => $(el).text().trim())
      .get()
      .join(" ")
      .trim();
    const description = $card.find("p.ad__card-description").text().trim() || null;
    const category = $card.find(".card-fav").attr("data-ad-category") ?? null;
    const origin = new URL(baseUrl).origin;

    return {
      id: `coin-${idMatch[1] ?? i}`,
      source: "coinafrique",
      title,
      price: price !== null && Number.isFinite(price) ? price : null,
      currency: "FCFA",
      zone: location?.replace(/Côte d'?Ivoire/i, "").trim().replace(/,$/, "") || null,
      vendor: null,
      url: href.startsWith("http") ? href : `${origin}${href}`,
      photo,
      date: times ? `il y a ${times}` : null,
      description: category ? `${category} — ${description ?? title}` : description,
    };
  } catch {
    return null;
  }
}

/** Parseur historique rendu pur : aucun réseau, cache ou état global. */
export async function extractCoinAfriqueCheerio({
  html,
  baseUrl,
}: CoinAfriqueExtractionInput): Promise<CoinAfriqueExtraction> {
  const $ = cheerio.load(html);
  const listings: RawListing[] = [];
  let badCards = 0;

  $("div.card.ad__card").each((i, card) => {
    const parsed = parseCard($, card, i, baseUrl);
    if (parsed) listings.push(parsed);
    else if (i < 5) badCards++;
  });

  return {
    listings,
    errors: badCards > 0 ? [`${badCards} cartes illisibles ignorées`] : [],
  };
}
