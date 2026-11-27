//! Opens web pages in the system browser.
//!
//! Inside the AppImage, the runtime points LD_LIBRARY_PATH, GIO_MODULE_DIR,
//! GTK_PATH and friends at the libraries bundled with the app (built on an
//! older distro). Browser launchers inherit them, and host programs such as
//! `gio`, `kioclient` and `flatpak` then fail to load ("undefined symbol"),
//! so links never open. The launchers run here with the AppImage's additions
//! removed from their environment.

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Link inválido.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Só é possível abrir links http e https.".into());
    }
    #[cfg(target_os = "linux")]
    if let Some(appdir) = std::env::var_os("APPDIR") {
        return tauri::async_runtime::spawn_blocking(move || appimage::open(&url, &appdir))
            .await
            .map_err(|error| error.to_string())?;
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
mod appimage {
    use std::ffi::{OsStr, OsString};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    /// Set by the AppImage hooks without the host value they replace.
    const ADDED: &[&str] = &[
        "GTK_THEME",
        "GST_REGISTRY_REUSE_PLUGIN_SCANNER",
        "APPDIR",
        "APPIMAGE",
        "ARGV0",
        "OWD",
    ];

    /// The host environment: entries under `appdir` are dropped from
    /// `:`-separated lists, and variables left with nothing are removed.
    pub fn host_env(
        vars: impl IntoIterator<Item = (OsString, OsString)>,
        appdir: &OsStr,
    ) -> Vec<(OsString, Option<OsString>)> {
        let appdir = appdir.as_bytes();
        let appdir = appdir.strip_suffix(b"/").unwrap_or(appdir);
        let inside = |entry: &[u8]| {
            entry.starts_with(appdir) && matches!(entry.get(appdir.len()), None | Some(b'/'))
        };
        vars.into_iter()
            .filter_map(|(name, value)| {
                if ADDED.iter().any(|added| name == OsStr::new(added)) {
                    return Some((name, None));
                }
                let entries: Vec<&[u8]> = value.as_bytes().split(|byte| *byte == b':').collect();
                if !entries.iter().any(|entry| inside(entry)) {
                    return None;
                }
                let kept: Vec<&[u8]> = entries
                    .into_iter()
                    .filter(|entry| !entry.is_empty() && !inside(entry))
                    .collect();
                let value = (!kept.is_empty()).then(|| OsString::from_vec(kept.join(&b':')));
                Some((name, value))
            })
            .collect()
    }

    /// Tries the launchers in order until one succeeds or is still running
    /// after a moment (it handed the page to the browser).
    pub fn open(url: &str, appdir: &OsStr) -> Result<(), String> {
        let env = host_env(std::env::vars_os(), appdir);
        let mut last = "Nenhum programa para abrir links foi encontrado.".to_string();
        for mut command in open::commands(url) {
            prepare(&mut command, &env);
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    last = error.to_string();
                    continue;
                }
            };
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match child.try_wait() {
                    Ok(Some(status)) if status.success() => return Ok(()),
                    Ok(Some(status)) => {
                        last = format!("{:?} terminou com {status}", command.get_program());
                        break;
                    }
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(50))
                    }
                    Ok(None) => {
                        // Reap it whenever it exits.
                        std::thread::spawn(move || child.wait());
                        return Ok(());
                    }
                    Err(error) => return Err(error.to_string()),
                }
            }
        }
        Err(format!("Não foi possível abrir o navegador: {last}"))
    }

    fn prepare(command: &mut Command, env: &[(OsString, Option<OsString>)]) {
        for (name, value) in env {
            match value {
                Some(value) => command.env(name, value),
                None => command.env_remove(name),
            };
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
            pairs
                .iter()
                .map(|(name, value)| (name.into(), value.into()))
                .collect()
        }

        fn changes(pairs: &[(&str, &str)]) -> Vec<(String, Option<String>)> {
            host_env(env(pairs), OsStr::new("/tmp/.mount_Disc123"))
                .into_iter()
                .map(|(name, value)| {
                    (
                        name.into_string().unwrap(),
                        value.map(|v| v.into_string().unwrap()),
                    )
                })
                .collect()
        }

        #[test]
        fn removes_the_bundled_entries() {
            assert_eq!(
                changes(&[
                    (
                        "LD_LIBRARY_PATH",
                        "/tmp/.mount_Disc123/usr/lib/:/tmp/.mount_Disc123/usr/lib64/:"
                    ),
                    (
                        "PATH",
                        "/tmp/.mount_Disc123/usr/bin/:/usr/local/bin:/usr/bin"
                    ),
                    (
                        "XDG_DATA_DIRS",
                        "/tmp/.mount_Disc123/usr/share:/usr/share:/var/lib/flatpak/exports/share"
                    ),
                    ("GIO_MODULE_DIR", "/tmp/.mount_Disc123//usr/lib/gio/modules"),
                    (
                        "QT_PLUGIN_PATH",
                        "/tmp/.mount_Disc123/usr/lib/qt5/plugins/:/home/me/.local/lib/qt6/plugins"
                    ),
                ]),
                vec![
                    ("LD_LIBRARY_PATH".into(), None),
                    ("PATH".into(), Some("/usr/local/bin:/usr/bin".into())),
                    (
                        "XDG_DATA_DIRS".into(),
                        Some("/usr/share:/var/lib/flatpak/exports/share".into())
                    ),
                    ("GIO_MODULE_DIR".into(), None),
                    (
                        "QT_PLUGIN_PATH".into(),
                        Some("/home/me/.local/lib/qt6/plugins".into())
                    ),
                ]
            );
        }

        #[test]
        fn removes_what_the_hooks_add_and_keeps_the_rest() {
            assert_eq!(
                changes(&[
                    ("GTK_THEME", "Adwaita:dark"),
                    ("APPIMAGE", "/home/me/DiscVoice.AppImage"),
                    ("HOME", "/home/me"),
                    ("OTHER", "/tmp/.mount_Disc1234/usr/lib"),
                ]),
                vec![("GTK_THEME".into(), None), ("APPIMAGE".into(), None)]
            );
        }
    }
}
