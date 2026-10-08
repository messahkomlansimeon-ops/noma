import { defaultAdminSmsHttpHandlers } from "@/lib/server/sms/admin-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return defaultAdminSmsHttpHandlers.overview(request);
}
