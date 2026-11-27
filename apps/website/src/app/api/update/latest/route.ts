import type { NextRequest } from "next/server";
import { latestResponse } from "@/lib/updates";

// Newest desktop version on ?channel=, with no download link (src/lib/updates.ts).
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return latestResponse(request.nextUrl.searchParams.get("channel"));
}
