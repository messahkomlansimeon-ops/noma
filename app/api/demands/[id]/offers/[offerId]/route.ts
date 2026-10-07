import { defaultMetricsHttpHandlers } from "@/lib/server/metrics/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceContext {
  params: Promise<{ id: string; offerId: string }>;
}

export async function GET(request: Request, context: ResourceContext): Promise<Response> {
  const { id, offerId } = await context.params;
  return defaultMetricsHttpHandlers.demandOffers.get(request, id, offerId);
}
