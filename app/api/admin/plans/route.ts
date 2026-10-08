import { defaultAdminPlansHttpHandlers } from "@/lib/server/admin/plans-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return defaultAdminPlansHttpHandlers.overview(request);
}
