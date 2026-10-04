import { OPENROUTER_API_KEY, POC_MODELS } from "./env";
import { logUsage, logLine, runCtx } from "./log";
import type { ZodType } from "zod";

interface LlmOptions {
  task: string;
  system: string;
  user: string;
  models?: string[];
  maxTokens?: number;
  /** Clé du tableau si le modèle renvoie un tableau nu au lieu d'un objet. */
  arrayKey?: string;
  /** Délai maximal PAR MODÈLE (défaut 90 s) — revue P2-9. */
  timeoutMs?: number;
  /** fetch injectable (tests hors ligne). */
  fetchImpl?: typeof fetch;
  /** L'appel peut déclencher des frais de recherche web (plugin :online) —
   *  facturés HORS tokens, inclus dans la borne du budget. */
  webSearch?: boolean;
  /** Annulation externe (orchestrateur) — revue 2 P1-1. */
  signal?: AbortSignal;
}

/**
 * BUDGET PRÉVISIONNEL avec arrêt conservateur (revue P1 — présentation
 * honnête) : la réserve d'un appel est une borne de son coût maximal :
 * - tokens d'entrée = ESTIMATION PRÉVISIONNELLE LARGE : 1 token par
 *   caractère — très au-dessus des tokenizations usuelles, mais PAS un
 *   maximum garanti (certains caractères Unicode coûtent plusieurs tokens) ;
 *   y compris le suffixe ajouté au message système et l'enveloppe de la
 *   requête ;
 * - tokens de sortie ≤ maxTokens ;
 * - prix plafonnés PAR MODÈLE (généreux, au-dessus des tarifs publics) ;
 * - frais de recherche web (plugin :online) facturés HORS tokens → ajoutés
 *   en plafond fixe.
 * Les prix OpenRouter ne sont pas contractuellement figés : tant que ces
 * bornes ne sont pas garanties par le fournisseur, le mécanisme est un
 * BUDGET PRÉVISIONNEL (arrêt conservateur), pas un plafond contractuel.
 */
const PRICE_CEILING_PER_1K: Record<string, [number, number]> = {
  "openai/gpt-4o-mini": [0.0002, 0.0008],
  "deepseek/deepseek-chat": [0.0003, 0.0014],
  "google/gemini-2.5-flash": [0.0004, 0.003],
};
const DEFAULT_PRICE_CEILING_PER_1K: [number, number] = [0.001, 0.01];
/** Frais web (plugin :online) — plafond généreux, hors tokens. */
const WEB_SEARCH_FEE_CEILING_USD = 0.05;
const SYSTEM_SUFFIX = " Réponds uniquement en JSON.";
/** Enveloppe de la requête (rôles, response_format, usage…), en caractères. */
const REQUEST_OVERHEAD_CHARS = 64;

function borneAppelUsd(opts: LlmOptions, model: string): number {
  const [inPrice, outPrice] =
    PRICE_CEILING_PER_1K[model] ?? DEFAULT_PRICE_CEILING_PER_1K;
  // estimation prévisionnelle large : 1 token/caractère (revue P2 — pas un
  // maximum garanti, certains caractères Unicode coûtent plusieurs tokens)
  const estInTokens =
    opts.system.length + SYSTEM_SUFFIX.length + opts.user.length + REQUEST_OVERHEAD_CHARS;
  const maxOut = opts.maxTokens ?? 2000;
  const webFee = opts.webSearch === true ? WEB_SEARCH_FEE_CEILING_USD : 0;
  return (estInTokens * inPrice + maxOut * outPrice) / 1000 + webFee;
}

function stripFences(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

export async function llmJson<T>(
  schema: ZodType<T>,
  opts: LlmOptions,
): Promise<{ data: T; model: string }> {
  const ctx = runCtx();
  // `ai: null` désactive TOUS les chemins IA (scoring, extraction Google,
  // secours SERP) — revue P1 : pas seulement le scoring
  if (ctx?.aiEnabled === false) {
    throw new Error("IA désactivée pour ce run (ai:null)");
  }
  // Budget prévisionnel, arrêt conservateur (revues P1) : revérifié avant
  // CHAQUE modèle (secours compris) ; dépense passée + réserves des appels
  // simultanés ≥ budget → aucun appel. Un coût inconnu (usage.cost absent)
  // est conservateur : budget considéré épuisé.
  const cap = ctx?.maxCostUsd;
  const guard = (phase: string) => {
    if (!ctx || cap == null) return;
    if (ctx.entries.some((e) => e.cost === null)) {
      throw new Error(
        `budget IA : coût d'un appel inconnu — aucun autre appel autorisé (budget ${cap}$, arrêt conservateur)`,
      );
    }
    const spent = ctx.entries.reduce((a, e) => a + (e.cost ?? 0), 0);
    const reserved = ctx.reservedUsd ?? 0;
    if (spent + reserved >= cap) {
      throw new Error(
        `budget IA épuisé (${spent.toFixed(4)}$ + réservé ${reserved.toFixed(4)}$ ≥ ${cap}$) — arrêt conservateur — ${phase}`,
      );
    }
  };
  guard("aucun appel lancé");

  const models = opts.models ?? POC_MODELS;
  let lastError: Error = new Error("aucune tentative");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 90_000;

  for (const model of models) {
    // déjà annulé → aucun appel, aucun crédit dépensé
    if (opts.signal?.aborted) {
      lastError = new Error(`annulé avant l'appel (${opts.signal.reason ?? "signal"})`);
      break;
    }
    guard(`modèle ${model} refusé`);
    // réserve = borne PRÉVISIONNELLE du coût de cet appel (entrée estimée
    // largement + sortie max, prix plafonné par modèle, frais web inclus) —
    // estimation, pas un maximum garanti (revue P2). Si la borne dépasse le
    // solde, l'appel est REFUSÉ — un Math.min() ici autoriserait un
    // dépassement (revue P1). Relâchée seulement quand la
    // facturation est CONSTATÉE (réponse avec usage) ou exclue (refus 4xx/
    // 5xx du fournisseur) ; une interruption conserve la réserve (revue P1 :
    // une absence de réponse ne prouve pas l'absence de facturation).
    const added = borneAppelUsd(opts, model);
    if (ctx && cap != null) {
      const spent = ctx.entries.reduce((a, e) => a + (e.cost ?? 0), 0);
      const solde = cap - spent - (ctx.reservedUsd ?? 0);
      if (added > solde) {
        throw new Error(
          `budget IA : borne de l'appel ${added.toFixed(4)}$ > solde ${solde.toFixed(4)}$ (budget ${cap}$) — modèle ${model}`,
        );
      }
      ctx.reservedUsd = (ctx.reservedUsd ?? 0) + added;
    }
    const release = () => {
      if (ctx && cap != null) {
        ctx.reservedUsd = Math.max(0, (ctx.reservedUsd ?? 0) - added);
      }
    };
    let sent = false;
    let usageRecorded = false;
    try {
      sent = true;
      const res = await doFetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        signal: opts.signal
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), opts.signal])
          : AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model,
          messages: [
            // OpenAI exige le mot "json" dans les messages pour response_format json_object.
            { role: "system", content: `${opts.system} Réponds uniquement en JSON.` },
            { role: "user", content: opts.user },
          ],
          response_format: { type: "json_object" },
          temperature: 0,
          max_tokens: opts.maxTokens ?? 2000,
          usage: { include: true },
        }),
      });

      if (!res.ok) {
        lastError = new Error(
          `${model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
        );
        logLine(`  ⚠ ${lastError.message}`);
        // refus du fournisseur (réponse reçue) : pas de complétion → pas de
        // facturation → la réserve est relâchée
        release();
        continue;
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: {
          cost?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
        };
      };
      const content = json.choices?.[0]?.message?.content ?? "";
      const usage = json.usage ?? {};
      logUsage({
        task: opts.task,
        model,
        cost: typeof usage.cost === "number" ? usage.cost : null,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
      });
      usageRecorded = true;
      // facturation CONSTATÉE (usage renvoyé) : la réserve est relâchée —
      // si le coût est inconnu, la garde bloque déjà les appels suivants
      release();

      let raw = JSON.parse(stripFences(content));
      if (opts.arrayKey && Array.isArray(raw)) raw = { [opts.arrayKey]: raw };
      const parsed = schema.safeParse(raw);
      if (parsed.success) return { data: parsed.data, model };

      lastError = new Error(
        `${model} JSON invalide: ${JSON.stringify(parsed.error.issues).slice(0, 300)}`,
      );
      logLine(`  ⚠ ${lastError.message}`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      // interruption après envoi (connexion coupée, corps illisible, annulation
      // en cours) : la facturation est INCERTE — réserve CONSERVÉE + coût
      // inconnu enregistré → arrêt conservateur du run jusqu'à réconciliation
      // (revue P1 : une absence de réponse ne prouve pas l'absence de facturation)
      if (sent && !usageRecorded && ctx && cap != null) {
        logUsage({
          task: `${opts.task} (facturation incertaine)`,
          model,
          cost: null,
          promptTokens: 0,
          completionTokens: 0,
        });
        logLine(`  ⚠ ${model} : facturation incertaine — réserve conservée, budget arrêté`);
      }
      logLine(`  ⚠ ${model} échec: ${lastError.message.slice(0, 200)}`);
    }
  }
  throw lastError ?? new Error("Aucun modèle disponible");
}