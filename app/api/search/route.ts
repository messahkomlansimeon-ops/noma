/**
 * POST /api/search — recherche publique progressive (NDJSON), runtime Node.
 * Lot 5 : validation AVANT ouverture du flux, admission (Turnstile, quotas,
 * budget prévisionnel), moteur appelé avec budget imposé côté serveur,
 * événements started/source?/results/completed/error sans trace technique.
 */
import type { NextRequest } from "next/server";
import { SEARCH_BODY_MAX_BYTES, SEARCH_TEXT_MAX, type SearchMode } from "@/lib/contracts";
import { guard } from "@/lib/server/guard-runtime";
import { clientIpFromRequest, pseudonymizeIp } from "@/lib/server/ip";
import { admitPublicSearch, completePublicSearch } from "@/lib/server/admission";
import { siteverify } from "@/lib/server/turnstile";
import { buildSearchStream } from "@/lib/server/search-stream";
import { fakeRunners } from "@/lib/server/fake-sources";
import { createContinuationToken, verifyContinuationToken } from "@/lib/server/continuation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_COOKIE = "noma_sid";

const jsonError = (status: number, code: string, message: string, extraHeaders?: Record<string, string>) =>
  Response.json({ error: { code, message } }, { status, headers: extraHeaders });

/** Lecture PROGRESSIVE du corps, coupée à SEARCH_BODY_MAX_BYTES OCTETS :
 *  un corps volumineux sans Content-Length n'est jamais chargé en mémoire. */
async function readBodyCapped(
  request: NextRequest,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > SEARCH_BODY_MAX_BYTES) {
    return { ok: false };
  }
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > SEARCH_BODY_MAX_BYTES) {
      void reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(body) };
}

interface ValidatedBody {
  text: string;
  mode: SearchMode;
  location: string | null;
  budgetFcfa: number | null;
  alternatives: boolean;
  turnstileToken: string | undefined;
  continuationToken: string | undefined;
  clarification: { id: string; answer: string } | null;
}

function validateBody(raw: unknown): { ok: true; body: ValidatedBody } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, message: "Corps de requête invalide." };
  const body = raw as Record<string, unknown>;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length === 0) return { ok: false, message: "Décrivez ce que vous cherchez." };
  if (text.length > SEARCH_TEXT_MAX) return { ok: false, message: `Le besoin est limité à ${SEARCH_TEXT_MAX} caractères.` };
  if (body.mode !== "achat" && body.mode !== "service") {
    return { ok: false, message: "Mode de recherche invalide (achat ou service)." };
  }
  let budgetFcfa: number | null = null;
  if (body.budgetFcfa !== undefined && body.budgetFcfa !== null) {
    if (typeof body.budgetFcfa !== "number" || !Number.isFinite(body.budgetFcfa) || body.budgetFcfa < 0) {
      return { ok: false, message: "Budget invalide." };
    }
    budgetFcfa = body.budgetFcfa;
  }
  if (body.location !== undefined && body.location !== null && (typeof body.location !== "string" || body.location.length > 120)) {
    return { ok: false, message: "Localisation invalide." };
  }
  const location = typeof body.location === "string" && body.location.trim().length > 0 ? body.location.trim() : null;
  const continuationToken =
    typeof body.continuationToken === "string" && body.continuationToken.length <= 4_096
      ? body.continuationToken
      : undefined;
  let clarification: { id: string; answer: string } | null = null;
  if (body.clarification !== undefined) {
    if (typeof body.clarification !== "object" || body.clarification === null) {
      return { ok: false, message: "Précision invalide." };
    }
    const c = body.clarification as Record<string, unknown>;
    if (
      typeof c.id !== "string" || c.id.length === 0 || c.id.length > 80 ||
      typeof c.answer !== "string" || c.answer.length === 0 || c.answer.length > 80
    ) return { ok: false, message: "Précision invalide." };
    clarification = { id: c.id, answer: c.answer };
  }
  if ((continuationToken === undefined) !== (clarification === null)) {
    return { ok: false, message: "Suite de clarification incomplète." };
  }
  return {
    ok: true,
    body: {
      text,
      mode: body.mode as SearchMode,
      location,
      budgetFcfa,
      alternatives: body.alternatives === true,
      turnstileToken: typeof body.turnstileToken === "string" ? body.turnstileToken : undefined,
      continuationToken,
      clarification,
    },
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  const { cfg, db } = guard();

  // ── Interrupteur serveur : recherches désactivées ─────────────────────────
  if (cfg.searchDisabled) {
    return jsonError(503, "searches_disabled", "La recherche est temporairement désactivée.");
  }

  // ── Corps limité à 8 Ko (lu progressivement, coupé en octets), validé ─────
  const bodyRead = await readBodyCapped(request);
  if (!bodyRead.ok) {
    return jsonError(413, "payload_too_large", "Requête trop volumineuse.");
  }
  const rawText = bodyRead.text;
  let raw: unknown;
  try {
    raw = rawText.length === 0 ? null : JSON.parse(rawText);
  } catch {
    return jsonError(400, "invalid_request", "Corps de requête invalide.");
  }
  const validated = validateBody(raw);
  if (!validated.ok) {
    return jsonError(400, "invalid_request", validated.message);
  }

  // ── Session : cookie sécurisé (créé si absent) ────────────────────────────
  let sessionId = request.cookies.get(SESSION_COOKIE)?.value;
  const newSession = !sessionId;
  if (newSession) sessionId = crypto.randomUUID();

  // ── IP pseudonymisée — en-têtes crus uniquement depuis le proxy configuré ─
  const ip = clientIpFromRequest(request.headers, "", cfg.trustedProxies, cfg.proxySecret);
  const ipHash = pseudonymizeIp(ip, cfg.ipSecret);

  // ── Origine : même hôte que la requête OU domaine attendu (anti-CSRF) ─────
  const origin = request.headers.get("origin");
  if (origin) {
    let originOk = false;
    try {
      const originHost = new URL(origin).hostname;
      const requestHost = new URL(request.url).hostname;
      originOk = originHost === requestHost || cfg.turnstile.expectedHostnames.includes(originHost);
    } catch {
      originOk = false;
    }
    if (!originOk) {
      return jsonError(403, "invalid_origin", "Origine de la requête non autorisée.");
    }
  }

  // Une réponse à NOTRE question est signée, expire après 5 minutes et est
  // liée à la session, l'IP pseudonymisée et la demande originale. Elle évite
  // seulement un second Turnstile : quotas et budget restent appliqués.
  let continuationValid = false;
  if (validated.body.continuationToken && validated.body.clarification) {
    continuationValid = verifyContinuationToken(validated.body.continuationToken, {
      sessionId: sessionId!,
      ipHash,
      text: validated.body.text,
      clarificationId: validated.body.clarification.id,
      answer: validated.body.clarification.answer,
      secret: cfg.ipSecret,
      now: new Date(),
    });
    if (!continuationValid) {
      return jsonError(403, "invalid_continuation", "Cette précision a expiré. Relancez la recherche.");
    }
  }

  // ── Admission : Turnstile → quotas → réservation de budget ────────────────
  const admission = await admitPublicSearch(
    { cfg, db, verify: siteverify(cfg.turnstile.secret) },
    {
      sessionId: sessionId!,
      ipHash,
      remoteip: ip,
      turnstileToken: validated.body.turnstileToken,
      turnstileVerified: continuationValid,
      now: new Date(),
    },
  );
  if (!admission.allowed) {
    return jsonError(admission.status, admission.code, admission.message, {
      ...(admission.retryAfterSeconds ? { "Retry-After": String(admission.retryAfterSeconds) } : {}),
    });
  }

  // Sources simulées : validation locale SANS IA ni dépense (jamais en prod)
  const fakeSources = cfg.turnstile.disabledForTests && process.env.NOMA_FAKE_SOURCES === "1";

  // ── Délai global 180 s + déconnexion client → arrêt du moteur ─────────────
  const signal = AbortSignal.any([AbortSignal.timeout(180_000), request.signal]);
  const clarification = validated.body.clarification;

  const { stream } = buildSearchStream({
    searchId: admission.searchId,
    needText: validated.body.text,
    clarificationAnswer: clarification?.answer,
    alternatives: validated.body.alternatives,
    aiEnabled: fakeSources ? false : admission.aiEnabled,
    maxCostUsd: admission.reservationMicros / 1_000_000,
    structured: { budgetFcfa: validated.body.budgetFcfa, location: validated.body.location, mode: validated.body.mode },
    signal,
    ...(fakeSources ? { runners: fakeRunners(validated.body.text) } : {}),
    makeContinuationToken: (next) => createContinuationToken({
      sessionId: sessionId!,
      ipHash,
      text: validated.body.text,
      clarificationId: next.id,
      options: next.options,
      secret: cfg.ipSecret,
    }),
    onComplete: (reconciliation) => {
      completePublicSearch({ cfg, db }, sessionId!, admission.searchId, reconciliation, new Date());
    },
  });

  const sessionCookie = `${SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${
    process.env.NODE_ENV === "production" ? "; Secure" : ""
  }`;

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // reverse proxy : ne pas tamponner le flux
      "X-Accel-Buffering": "no",
      ...(newSession ? { "Set-Cookie": sessionCookie } : {}),
    },
  });
}
