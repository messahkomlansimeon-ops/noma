import { defaultReportsHttpHandlers } from "@/lib/server/reports/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return defaultReportsHttpHandlers.list(request);
}

export async function POST(request: Request): Promise<Response> {
  return defaultReportsHttpHandlers.create(request);
}
