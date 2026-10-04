import { defaultCatalogHttpHandlers } from "@/lib/server/catalog/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultCatalogHttpHandlers.demands.read(request, id);
}

export async function PATCH(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultCatalogHttpHandlers.demands.update(request, id);
}
