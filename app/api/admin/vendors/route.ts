import { defaultAdminHttpHandlers } from "@/lib/server/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return defaultAdminHttpHandlers.vendors(request);
}
