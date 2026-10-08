import { defaultMediaHttpHandlers } from "@/lib/server/media/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultMediaHttpHandlers.photos.list(request, id);
}

export async function POST(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultMediaHttpHandlers.photos.upload(request, id);
}

export async function PUT(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultMediaHttpHandlers.photos.reorder(request, id);
}
