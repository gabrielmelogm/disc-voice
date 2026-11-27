import { redirectToDownload } from "@/lib/releases";

// /download/linux/appimage, /download/linux/deb and /download/linux/rpm:
// signed links to the Linux packages in releases/latest/ (src/lib/releases.ts).
export const dynamic = "force-dynamic";

const FORMATS = ["appimage", "deb", "rpm"] as const;

export async function GET(_request: Request, { params }: { params: Promise<{ format: string }> }) {
  const { format } = await params;
  const download = FORMATS.find(f => f === format);
  if (!download) return new Response("Not found", { status: 404 });
  return redirectToDownload(download);
}
