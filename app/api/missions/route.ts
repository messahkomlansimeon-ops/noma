import { defaultMissionsHttpHandlers } from "@/lib/server/missions/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return defaultMissionsHttpHandlers.list(request);
}

export async function POST(request: Request): Promise<Response> {
  return defaultMissionsHttpHandlers.create(request);
}
