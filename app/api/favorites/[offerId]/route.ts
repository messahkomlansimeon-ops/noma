import { defaultSocialHttpHandlers } from "@/lib/server/social/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceContext {
  params: Promise<{ offerId: string }>;
}

export async function DELETE(request: Request, context: ResourceContext): Promise<Response> {
  const { offerId } = await context.params;
  return defaultSocialHttpHandlers.favorites.remove(request, offerId);
}
