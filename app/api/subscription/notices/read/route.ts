import { defaultSubscriptionHttpHandlers } from "@/lib/server/subscriptions/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return defaultSubscriptionHttpHandlers.noticesRead(request);
}
