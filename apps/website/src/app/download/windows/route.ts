import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// The bucket is private: every click gets a short-lived signed link to the
// latest installer, uploaded by .github/workflows/desktop.yml.
export const dynamic = "force-dynamic";

const BUCKET = process.env.RELEASES_BUCKET || "disc-voice-files-481116707314";
const REGION = process.env.RELEASES_REGION || "sa-east-1";
const KEY = "releases/latest/DiscVoice-Setup.exe";
const EXPIRES_IN = 300;
const FALLBACK = "https://github.com/gabrielmelogm/disc-voice/releases/latest";

let client: S3Client | undefined;

function s3(): S3Client | undefined {
  const accessKeyId = process.env.RELEASES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.RELEASES_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  client ??= new S3Client({ region: REGION, credentials: { accessKeyId, secretAccessKey } });
  return client;
}

export async function GET() {
  const s3Client = s3();
  if (!s3Client) {
    console.warn("RELEASES_ACCESS_KEY_ID/RELEASES_SECRET_ACCESS_KEY are not set; redirecting to GitHub releases.");
    return Response.redirect(FALLBACK, 302);
  }

  const url = await getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: KEY,
      ResponseContentDisposition: 'attachment; filename="DiscVoice-Setup.exe"',
    }),
    { expiresIn: EXPIRES_IN },
  );

  return new Response(null, {
    status: 302,
    headers: { Location: url, "Cache-Control": "no-store" },
  });
}
