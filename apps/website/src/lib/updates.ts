import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BUCKET, RELEASES_PAGE, s3 } from "./releases";

// The desktop app's updater (tauri-plugin-updater) asks here whether there is
// a newer version. .github/workflows/desktop.yml publishes one manifest per
// channel in releases/channels/<channel>.json:
//
//   { version, notes, pub_date,
//     platforms: { "windows-x86_64": { key, signature }, "linux-x86_64": { key, signature },
//                  "linux-x86_64-flatpak": { key } } }
//
// /api/update/latest only tells the app that a version exists (no link). The
// app calls /api/update/{target}/{arch}/{version} when the user clicks to
// update; only that answer carries a short-lived signed link to the
// installer (`key` is its object in the private bucket). Editing a manifest
// in the bucket holds back or rolls out a version.
//
// The Flatpak cannot update itself: its entry has no signature, and its
// button opens /api/update/download/{platform} in the browser, a signed link
// to the channel's newest .flatpak.

export const CHANNELS = ["alpha", "beta", "stable"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Long enough for the app to start the download after the check. */
const LINK_EXPIRES_IN = 15 * 60;

interface Manifest {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms?: Record<string, { key?: string; signature?: string }>;
}

/** Compares two semver versions; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core = "", pre] = version.trim().replace(/^v/, "").split("+")[0]!.split(/-(.*)/s);
    return { core: core.split(".").map(part => Number(part) || 0), pre: pre ? pre.split(".") : [] };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  if (!left.pre.length || !right.pre.length) return Math.sign(right.pre.length - left.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const diff = numeric ? Number(x) - Number(y) : /^\d+$/.test(x) ? -1 : /^\d+$/.test(y) ? 1 : x.localeCompare(y);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

const SEMVER = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function noUpdate(): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

async function readManifest(channel: Channel): Promise<Manifest | null> {
  const client = s3();
  if (!client) {
    console.warn("RELEASES_ACCESS_KEY_ID/RELEASES_SECRET_ACCESS_KEY are not set; no updates are offered.");
    return null;
  }
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: `releases/channels/${channel}.json` }));
    const manifest = JSON.parse((await object.Body?.transformToString()) || "null") as Manifest | null;
    return manifest && typeof manifest.version === "string" ? manifest : null;
  } catch (error) {
    // No release on this channel yet.
    console.warn(`Could not read the ${channel} update manifest.`, error);
    return null;
  }
}

/**
 * The newest version on the channel, without any download link: the app uses
 * it to show that an update exists. The signed link is only made when the
 * user clicks to update (see updateResponse).
 */
export async function latestResponse(requested: string | null): Promise<Response> {
  const channel = CHANNELS.find(name => name === requested) ?? "stable";
  const manifest = await readManifest(channel);
  const headers = {
    // The app's webview is another origin; the answer is public anyway.
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=60",
  };
  if (!manifest) return new Response(null, { status: 204, headers });
  return Response.json({
    version: manifest.version,
    notes: manifest.notes ?? "",
    pub_date: manifest.pub_date,
    platforms: Object.keys(manifest.platforms ?? {}),
  }, { headers });
}

/**
 * Redirects to a signed download of the platform's package of the channel's
 * newest version, or to the GitHub releases page when there is none.
 */
export async function downloadResponse(platform: string, requested: string | null): Promise<Response> {
  const channel = CHANNELS.find(name => name === requested) ?? "stable";
  const manifest = await readManifest(channel);
  const key = manifest?.platforms?.[platform]?.key;
  if (!key) return redirect(RELEASES_PAGE);
  const name = key.split("/").pop()!;
  const url = await getSignedUrl(
    s3()!,
    new GetObjectCommand({ Bucket: BUCKET, Key: key, ResponseContentDisposition: `attachment; filename="${name}"` }),
    { expiresIn: LINK_EXPIRES_IN },
  );
  return redirect(url);
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}

/**
 * 204 when there is nothing newer for this platform on the channel, or the
 * manifest the updater expects, with a signed link to the installer.
 */
export async function updateResponse(target: string, arch: string, current: string, requested: string | null): Promise<Response> {
  if (!SEMVER.test(current)) return new Response("Invalid version", { status: 400 });
  const channel = CHANNELS.find(name => name === requested) ?? "stable";
  const manifest = await readManifest(channel);
  if (!manifest || compareVersions(manifest.version, current) <= 0) return noUpdate();

  const platform = `${target}-${arch}`;
  const entry = manifest.platforms?.[platform];
  if (!entry?.key || !entry.signature) return noUpdate();

  const url = await getSignedUrl(s3()!, new GetObjectCommand({ Bucket: BUCKET, Key: entry.key }), { expiresIn: LINK_EXPIRES_IN });
  return Response.json({
    version: manifest.version,
    notes: manifest.notes ?? "",
    pub_date: manifest.pub_date,
    platforms: { [platform]: { url, signature: entry.signature } },
  }, { headers: { "Cache-Control": "no-store" } });
}
