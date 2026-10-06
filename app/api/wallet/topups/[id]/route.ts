import { defaultWalletHttpHandlers } from "@/lib/server/wallet/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: ResourceContext): Promise<Response> {
  const { id } = await context.params;
  return defaultWalletHttpHandlers.topups.get(request, id);
}
