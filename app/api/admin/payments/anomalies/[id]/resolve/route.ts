import { defaultAdminPaymentsHttpHandlers } from "@/lib/server/admin/payments-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultAdminPaymentsHttpHandlers.resolveAnomaly(request, id);
}
