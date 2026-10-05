import { defaultBoostHttpHandlers } from "@/lib/server/boost/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultBoostHttpHandlers.quotes.list(request, id);
}

export async function POST(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultBoostHttpHandlers.quotes.create(request, id);
}
