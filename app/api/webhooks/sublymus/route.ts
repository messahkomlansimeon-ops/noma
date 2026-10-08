import { defaultWalletHttpHandlers } from "@/lib/server/wallet/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Webhook Sublymus → noma (lot PAY1) : authentifié par la signature HMAC du corps brut et le gestionnaire, jamais par une session. Voir PAIEMENT-WAVE.md. */
export async function POST(request: Request): Promise<Response> {
  return defaultWalletHttpHandlers.sublymus.webhook(request);
}
