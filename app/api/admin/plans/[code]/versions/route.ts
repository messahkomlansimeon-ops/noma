import { defaultAdminPlansHttpHandlers } from "@/lib/server/admin/plans-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceContext {
  params: Promise<{ code: string }>;
}

export async function POST(request: Request, context: ResourceContext): Promise<Response> {
  const { code } = await context.params;
  return defaultAdminPlansHttpHandlers.createVersion(request, code);
}
