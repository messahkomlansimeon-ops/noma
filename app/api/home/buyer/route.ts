import { defaultHomeHttpHandlers } from "@/lib/server/home/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return defaultHomeHttpHandlers.buyer(request);
}
