import { defaultMissionsHttpHandlers } from "@/lib/server/missions/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultMissionsHttpHandlers.read(request, id);
}

export async function PUT(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultMissionsHttpHandlers.update(request, id);
}

export async function POST(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultMissionsHttpHandlers.act(request, id);
}
