import { defaultNotificationsHttpHandlers } from "@/lib/server/notifications/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return defaultNotificationsHttpHandlers.preferences.get(request);
}

export async function PUT(request: Request): Promise<Response> {
  return defaultNotificationsHttpHandlers.preferences.put(request);
}
