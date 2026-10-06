import { defaultWalletHttpHandlers } from "@/lib/server/wallet/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return defaultWalletHttpHandlers.topups.create(request);
}
