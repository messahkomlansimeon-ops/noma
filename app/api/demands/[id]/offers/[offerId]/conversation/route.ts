import { defaultSocialHttpHandlers } from "@/lib/server/social/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceContext {
  params: Promise<{ id: string; offerId: string }>;
}

export async function POST(request: Request, context: ResourceContext): Promise<Response> {
  const { id, offerId } = await context.params;
  return defaultSocialHttpHandlers.conversations.open(request, id, offerId);
}
