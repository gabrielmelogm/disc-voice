//! The S3 bucket that holds files sent in chats (a Lightsail bucket, created
//! by infra/terraform). Requests are signed with AWS Signature Version 4 as
//! presigned URLs, so the API needs no AWS SDK: the same signer makes the
//! links the app opens and the requests the API sends.
//!
//! The bucket is private. Each link expires; links are signed for a whole
//! hour window, so the same file keeps the same URL (and stays in the
//! browser's cache) for that hour.
use chrono::{DateTime, Duration, DurationRound, Utc};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone)]
pub struct BucketConfig {
    pub bucket: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

impl BucketConfig {
    /// `FILES_BUCKET`, `FILES_REGION`, `FILES_ACCESS_KEY_ID` and
    /// `FILES_SECRET_ACCESS_KEY`; `None` unless all are set.
    pub fn from_env() -> Option<Self> {
        let var = |name| {
            std::env::var(name)
                .ok()
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        Some(Self {
            bucket: var("FILES_BUCKET")?,
            region: var("FILES_REGION")?,
            access_key_id: var("FILES_ACCESS_KEY_ID")?,
            secret_access_key: var("FILES_SECRET_ACCESS_KEY")?,
        })
    }
}

pub(crate) struct Bucket {
    config: BucketConfig,
    host: String,
    http: reqwest::Client,
}

/// Every signed link is valid for at least this long after it is handed out.
const LINK_WINDOW: Duration = Duration::hours(1);
/// Requests the API itself sends.
const REQUEST_EXPIRY: i64 = 300;

impl Bucket {
    pub(crate) fn new(config: BucketConfig, http: reqwest::Client) -> Self {
        let host = format!("{}.s3.{}.amazonaws.com", config.bucket, config.region);
        Self { config, host, http }
    }

    fn key(id: Uuid) -> String {
        format!("files/{}", id.simple())
    }

    pub(crate) async fn put(
        &self,
        id: Uuid,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        let url = self.presign("PUT", &Self::key(id), Utc::now(), REQUEST_EXPIRY, &[]);
        let response = self
            .http
            .put(url)
            .header("content-type", content_type)
            .body(bytes)
            .timeout(std::time::Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("S3 PUT {}", response.status()));
        }
        Ok(())
    }

    pub(crate) async fn delete(&self, id: Uuid) -> Result<(), String> {
        let url = self.presign("DELETE", &Self::key(id), Utc::now(), REQUEST_EXPIRY, &[]);
        let response = self
            .http
            .delete(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        // 204 when deleted; S3 also answers 204 for a key that is already gone.
        if !response.status().is_success() {
            return Err(format!("S3 DELETE {}", response.status()));
        }
        Ok(())
    }

    /// A link that opens the file with these response headers.
    pub(crate) fn link(&self, id: Uuid, content_type: &str, disposition: &str) -> String {
        let window = Utc::now()
            .duration_trunc(LINK_WINDOW)
            .unwrap_or_else(|_| Utc::now());
        self.presign(
            "GET",
            &Self::key(id),
            window,
            (LINK_WINDOW * 2).num_seconds(),
            &[
                ("response-content-disposition", disposition),
                ("response-content-type", content_type),
            ],
        )
    }

    fn presign(
        &self,
        method: &str,
        key: &str,
        at: DateTime<Utc>,
        expires: i64,
        extra: &[(&str, &str)],
    ) -> String {
        presign(
            &self.host,
            &self.config.region,
            &self.config.access_key_id,
            &self.config.secret_access_key,
            method,
            key,
            at,
            expires,
            extra,
        )
    }
}

/// Percent-encodes everything but unreserved characters, as SigV4 requires.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A query-string-signed URL (SigV4, unsigned payload).
#[allow(clippy::too_many_arguments)]
fn presign(
    host: &str,
    region: &str,
    access_key: &str,
    secret: &str,
    method: &str,
    key: &str,
    at: DateTime<Utc>,
    expires: i64,
    extra: &[(&str, &str)],
) -> String {
    let datetime = at.format("%Y%m%dT%H%M%SZ").to_string();
    let date = &datetime[..8];
    let scope = format!("{date}/{region}/s3/aws4_request");
    let credential = format!("{access_key}/{scope}");
    let expires = expires.to_string();
    let mut query: Vec<(&str, &str)> = vec![
        ("X-Amz-Algorithm", "AWS4-HMAC-SHA256"),
        ("X-Amz-Credential", &credential),
        ("X-Amz-Date", &datetime),
        ("X-Amz-Expires", &expires),
        ("X-Amz-SignedHeaders", "host"),
    ];
    query.extend_from_slice(extra);
    let mut encoded: Vec<(String, String)> =
        query.iter().map(|(k, v)| (encode(k), encode(v))).collect();
    encoded.sort();
    let query = encoded
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    let path = key.split('/').map(encode).collect::<Vec<_>>().join("/");
    let canonical = format!("{method}\n/{path}\n{query}\nhost:{host}\n\nhost\nUNSIGNED-PAYLOAD");
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{datetime}\n{scope}\n{}",
        hex(&Sha256::digest(canonical.as_bytes()))
    );
    let signing = [region, "s3", "aws4_request"].iter().fold(
        hmac(format!("AWS4{secret}").as_bytes(), date),
        |key, part| hmac(&key, part),
    );
    let signature = hex(&hmac(&signing, &to_sign));
    format!("https://{host}/{path}?{query}&X-Amz-Signature={signature}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// The presigned URL example from the Amazon S3 SigV4 documentation.
    #[test]
    fn signs_like_the_aws_example() {
        let url = presign(
            "examplebucket.s3.amazonaws.com",
            "us-east-1",
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "GET",
            "test.txt",
            Utc.with_ymd_and_hms(2013, 5, 24, 0, 0, 0).unwrap(),
            86400,
            &[],
        );
        assert!(url.starts_with("https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host"));
        assert!(url.ends_with(
            "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
        ));
    }

    #[test]
    fn links_are_stable_within_the_hour() {
        let bucket = Bucket::new(
            BucketConfig {
                bucket: "files".into(),
                region: "sa-east-1".into(),
                access_key_id: "AKID".into(),
                secret_access_key: "secret".into(),
            },
            reqwest::Client::new(),
        );
        let id = Uuid::nil();
        let link = bucket.link(id, "image/png", "inline; filename*=UTF-8''a.png");
        assert_eq!(
            link,
            bucket.link(id, "image/png", "inline; filename*=UTF-8''a.png")
        );
        assert!(link.starts_with(
            "https://files.s3.sa-east-1.amazonaws.com/files/00000000000000000000000000000000?"
        ));
        assert!(link
            .contains("response-content-disposition=inline%3B%20filename%2A%3DUTF-8%27%27a.png"));
        assert!(link.contains("X-Amz-Expires=7200"));
    }
}
