import { defaultProposalsHttpHandlers } from "@/lib/server/proposals/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceContext {
  params: Promise<{ id: string; action: string }>;
}

export async function POST(request: Request, context: ResourceContext): Promise<Response> {
  const { id, action } = await context.params;
  return defaultProposalsHttpHandlers.act(request, id, action);
}
