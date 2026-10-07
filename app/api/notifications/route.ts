import { defaultNotificationsHttpHandlers } from "@/lib/server/notifications/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return defaultNotificationsHttpHandlers.notifications.list(request);
}
