import { defaultExternalHttpHandlers } from "@/lib/server/external/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return defaultExternalHttpHandlers.adminCollection(request);
}
