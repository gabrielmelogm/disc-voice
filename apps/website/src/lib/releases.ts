import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// The bucket is private: every click gets a short-lived signed link to a file
// of the latest release, uploaded by .github/workflows/desktop.yml.

export const BUCKET = process.env.RELEASES_BUCKET || "disc-voice-files-481116707314";
const REGION = process.env.RELEASES_REGION || "sa-east-1";
const EXPIRES_IN = 300;
/** Lists prereleases too (github.com/.../releases/latest skips them). */
export const RELEASES_PAGE = "https://github.com/gabrielmelogm/disc-voice/releases";

/** The object names in releases/latest/, as the workflow uploads them. */
export const DOWNLOADS = {
  windows: "DiscVoice-Setup.exe",
  appimage: "DiscVoice_x86_64.AppImage",
  deb: "DiscVoice_amd64.deb",
  rpm: "DiscVoice_x86_64.rpm",
  flatpak: "DiscVoice_x86_64.flatpak",
} as const;

export type Download = keyof typeof DOWNLOADS;

let client: S3Client | undefined;

export function s3(): S3Client | undefined {
  const accessKeyId = process.env.RELEASES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.RELEASES_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  client ??= new S3Client({ region: REGION, credentials: { accessKeyId, secretAccessKey } });
  return client;
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}

/**
 * Redirects to a signed link for the file, or to the GitHub releases page when
 * the bucket is not configured or the file was not uploaded yet (a package
 * that a release before it did not have).
 */
export async function redirectToDownload(download: Download): Promise<Response> {
  const s3Client = s3();
  if (!s3Client) {
    console.warn("RELEASES_ACCESS_KEY_ID/RELEASES_SECRET_ACCESS_KEY are not set; redirecting to GitHub releases.");
    return redirect(RELEASES_PAGE);
  }

  const name = DOWNLOADS[download];
  const key = `releases/latest/${name}`;
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (error) {
    console.warn(`Could not find ${key} in the bucket; redirecting to GitHub releases.`, error);
    return redirect(RELEASES_PAGE);
  }

  const url = await getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: BUCKET, Key: key, ResponseContentDisposition: `attachment; filename="${name}"` }),
    { expiresIn: EXPIRES_IN },
  );
  return redirect(url);
}
