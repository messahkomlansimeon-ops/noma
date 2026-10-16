import { defaultProposalsHttpHandlers } from "@/lib/server/proposals/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return defaultProposalsHttpHandlers.list(request);
}
