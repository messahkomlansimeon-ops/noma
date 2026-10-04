import { defaultCatalogExtractionHttpHandlers } from "@/lib/server/catalog-extraction/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ApplyContext {
  params: Promise<{ id: string; proposalId: string }>;
}

export async function POST(request: Request, context: ApplyContext): Promise<Response> {
  const { id, proposalId } = await context.params;
  return defaultCatalogExtractionHttpHandlers.demands.apply(request, id, proposalId);
}
