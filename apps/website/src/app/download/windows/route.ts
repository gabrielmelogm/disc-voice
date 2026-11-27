import { redirectToDownload } from "@/lib/releases";

// Signed link to releases/latest/DiscVoice-Setup.exe (src/lib/releases.ts).
export const dynamic = "force-dynamic";

export function GET() {
  return redirectToDownload("windows");
}
