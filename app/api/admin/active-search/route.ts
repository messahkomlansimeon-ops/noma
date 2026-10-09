import { defaultAdminActiveSearchHttpHandlers } from "@/lib/server/active-search/admin-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return defaultAdminActiveSearchHttpHandlers.overview(request);
}
