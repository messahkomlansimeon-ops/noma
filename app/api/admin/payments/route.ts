import { defaultAdminPaymentsHttpHandlers } from "@/lib/server/admin/payments-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return defaultAdminPaymentsHttpHandlers.overview(request);
}
