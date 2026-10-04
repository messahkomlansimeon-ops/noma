import { defaultCatalogHttpHandlers } from "@/lib/server/catalog/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return defaultCatalogHttpHandlers.demands.list(request);
}

export async function POST(request: Request): Promise<Response> {
  return defaultCatalogHttpHandlers.demands.create(request);
}
