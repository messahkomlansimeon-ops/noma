import { defaultSharesHttpHandlers } from "@/lib/server/shares/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceContext {
  params: Promise<{ token: string }>;
}

export async function GET(request: Request, context: ResourceContext): Promise<Response> {
  const { token } = await context.params;
  return defaultSharesHttpHandlers.shared(request, token);
}
