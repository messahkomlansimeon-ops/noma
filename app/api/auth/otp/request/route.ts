import { defaultAuthHttpHandlers } from "@/lib/server/auth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return defaultAuthHttpHandlers.requestOtp(request);
}
