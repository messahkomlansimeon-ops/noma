import { defaultCatalogExtractionHttpHandlers } from "@/lib/server/catalog-extraction/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultCatalogExtractionHttpHandlers.demands.list(request, id);
}

export async function POST(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultCatalogExtractionHttpHandlers.demands.create(request, id);
}
