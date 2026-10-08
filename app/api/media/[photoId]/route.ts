import { defaultMediaHttpHandlers } from "@/lib/server/media/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MediaContext {
  params: Promise<{ photoId: string }>;
}

export async function GET(request: Request, context: MediaContext): Promise<Response> {
  const { photoId } = await context.params;
  return defaultMediaHttpHandlers.media.get(request, photoId);
}
