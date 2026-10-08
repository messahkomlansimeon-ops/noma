import { defaultMarketHttpHandlers } from "@/lib/server/market/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return defaultMarketHttpHandlers.stats(request);
}
