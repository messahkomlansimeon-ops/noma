import { defaultAdminHttpHandlers } from "@/lib/server/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultAdminHttpHandlers.report(request, id);
}
