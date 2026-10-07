import { defaultNotificationsHttpHandlers } from "@/lib/server/notifications/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultNotificationsHttpHandlers.tracking.get(request, id);
}

export async function POST(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultNotificationsHttpHandlers.tracking.act(request, id);
}
