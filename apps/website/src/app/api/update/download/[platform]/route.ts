import type { NextRequest } from "next/server";
import { downloadResponse } from "@/lib/updates";

// The Flatpak's update button opens this in the browser: a signed link to the
// newest package of ?channel= for the platform (src/lib/updates.ts).
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  return downloadResponse(platform, request.nextUrl.searchParams.get("channel"));
}
