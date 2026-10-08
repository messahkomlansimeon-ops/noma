import { defaultMediaHttpHandlers } from "@/lib/server/media/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PhotoContext {
  params: Promise<{ id: string; photoId: string }>;
}

export async function DELETE(request: Request, context: PhotoContext): Promise<Response> {
  const { id, photoId } = await context.params;
  return defaultMediaHttpHandlers.photos.remove(request, id, photoId);
}
