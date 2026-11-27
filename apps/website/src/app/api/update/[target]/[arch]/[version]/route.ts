import type { NextRequest } from "next/server";
import { updateResponse } from "@/lib/updates";

// The desktop app's updater endpoint (src/lib/updates.ts). The app sends the
// channel in the X-Update-Channel header; ?channel= works too.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ target: string; arch: string; version: string }> }) {
  const { target, arch, version } = await params;
  const channel = request.headers.get("x-update-channel") ?? request.nextUrl.searchParams.get("channel");
  return updateResponse(target, arch, decodeURIComponent(version), channel);
}
