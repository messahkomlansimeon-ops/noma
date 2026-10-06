import { defaultWalletHttpHandlers } from "@/lib/server/wallet/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return defaultWalletHttpHandlers.wallet.get(request);
}
