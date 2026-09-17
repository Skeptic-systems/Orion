//! SoundCloud through the bundled yt-dlp. SoundCloud closed its API client
//! registration in 2019, so there is no key to obtain and no quota to manage;
//! yt-dlp's extractor does the searching and the stream resolving, and it is
//! kept current upstream when SoundCloud changes.
//!
//! Signing in is optional and works like the YouTube one: soundcloud.com's own
//! page in an Orion window, its cookies land in the shared webview profile,
//! and the resolver hands them to yt-dlp. Anonymously everything public still
//! plays; the session adds Go+ tracks and anything private to the account.

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const LOGIN_WINDOW: &str = "soundcloud-login";
const ORIGIN: &str = "https://soundcloud.com";
const SIGN_IN_URL: &str = "https://soundcloud.com/signin";
const SIGN_IN_TIMEOUT_SECS: u64 = 600;
/// SoundCloud sets the rest of the session right after the first cookie.
const SIGN_IN_SETTLE_MS: u64 = 1500;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);
const COOKIE_READ_TIMEOUT: Duration = Duration::from_secs(3);
const COOKIE_CACHE_TTL: Duration = Duration::from_secs(300);
/// Results per search page. SoundCloud's own search pages in twenties.
const PAGE_SIZE: usize = 20;
const MAX_PAGE: usize = 10;

type CookieJar = Vec<(String, String)>;

static COOKIE_CACHE: Mutex<Option<(Instant, CookieJar)>> = Mutex::new(None);

fn forget_cookies() {
    if let Ok(mut cache) = COOKIE_CACHE.lock() {
        *cache = None;
    }
}

/// soundcloud.com cookies from the webview profile all Orion windows share.
async fn soundcloud_cookies(app: &AppHandle) -> CookieJar {
    let window = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next());
    let (Some(window), Ok(url)) = (window, tauri::Url::parse(ORIGIN)) else {
        return Vec::new();
    };
    // Reading cookies on the UI thread deadlocks WebView2, so it happens on a
    // worker, and bounded: an empty jar only means an anonymous session.
    let read = tauri::async_runtime::spawn_blocking(move || window.cookies_for_url(url));
    tokio::time::timeout(COOKIE_READ_TIMEOUT, read)
        .await
        .ok()
        .and_then(Result::ok)
        .and_then(Result::ok)
        .map(|cookies| {
            cookies
                .into_iter()
                .map(|cookie| (cookie.name().to_string(), cookie.value().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// SoundCloud's session cookie. Its presence is the whole sign-in check.
fn is_signed_in(jar: &CookieJar) -> bool {
    jar.iter()
        .any(|(name, value)| name == "oauth_token" && !value.is_empty())
}

async fn cached_cookies(app: &AppHandle) -> CookieJar {
    if let Ok(cache) = COOKIE_CACHE.lock() {
        if let Some((at, jar)) = cache.as_ref() {
            if at.elapsed() < COOKIE_CACHE_TTL {
                return jar.clone();
            }
        }
    }
    let jar = soundcloud_cookies(app).await;
    if let Ok(mut cache) = COOKIE_CACHE.lock() {
        *cache = Some((Instant::now(), jar.clone()));
    }
    jar
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundCloudStatus {
    signed_in: bool,
}

#[tauri::command]
pub async fn soundcloud_status(app: AppHandle) -> SoundCloudStatus {
    SoundCloudStatus {
        signed_in: is_signed_in(&cached_cookies(&app).await),
    }
}

/// The signed-in session as a cookie file for the resolver, or `None` when
/// nobody is signed in. Shaped for yt-dlp's `--cookies`.
pub(crate) async fn audio_session(app: &AppHandle) -> Result<Option<String>, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    let url = tauri::Url::parse(ORIGIN).map_err(|err| err.to_string())?;
    let read = tauri::async_runtime::spawn_blocking(move || window.cookies_for_url(url));
    let cookies = tokio::time::timeout(COOKIE_READ_TIMEOUT, read)
        .await
        .map_err(|_| "SoundCloud session timed out")?
        .map_err(|_| "SoundCloud session unavailable")?
        .map_err(|_| "SoundCloud session unavailable")?;
    if !cookies.iter().any(|c| c.name() == "oauth_token") {
        return Ok(None);
    }
    let mut text = String::from("# Netscape HTTP Cookie File\n");
    for cookie in cookies {
        let domain = cookie.domain().unwrap_or(".soundcloud.com");
        let path = cookie.path().unwrap_or("/");
        // A tab or newline in a value would forge a second cookie line.
        if [domain, path, cookie.name(), cookie.value()]
            .iter()
            .any(|field| field.contains(['\n', '\r', '\t']))
        {
            continue;
        }
        text.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            domain,
            if domain.starts_with('.') { "TRUE" } else { "FALSE" },
            path,
            if cookie.secure().unwrap_or(false) { "TRUE" } else { "FALSE" },
            cookie.expires_datetime().map(|t| t.unix_timestamp()).unwrap_or(0),
            cookie.name(),
            cookie.value()
        ));
    }
    Ok(Some(text))
}

/// Opens soundcloud.com's sign-in in an Orion window and closes it once the
/// session exists. The outcome arrives as a `soundcloud-sign-in` event.
#[tauri::command]
pub async fn soundcloud_sign_in(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = window.set_focus();
        return Ok(());
    }
    let url = tauri::Url::parse(SIGN_IN_URL).map_err(|err| err.to_string())?;
    WebviewWindowBuilder::new(&app, LOGIN_WINDOW, WebviewUrl::External(url))
        .title("Sign in to SoundCloud")
        .inner_size(480.0, 720.0)
        .center()
        .build()
        .map_err(|err| err.to_string())?;

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let open = handle.get_webview_window(LOGIN_WINDOW).is_some();
            let mut signed_in = is_signed_in(&soundcloud_cookies(&handle).await);
            let timed_out = started.elapsed().as_secs() > SIGN_IN_TIMEOUT_SECS;

            if !signed_in && open && !timed_out {
                continue;
            }
            if signed_in && open {
                tokio::time::sleep(Duration::from_millis(SIGN_IN_SETTLE_MS)).await;
                signed_in = is_signed_in(&soundcloud_cookies(&handle).await);
            }
            if let Some(window) = handle.get_webview_window(LOGIN_WINDOW) {
                let _ = window.close();
            }
            // The next resolve reads the new session instead of a cached one.
            forget_cookies();
            crate::youtube_audio::forget_session();
            let _ = handle.emit("soundcloud-sign-in", json!({ "signedIn": signed_in }));
            break;
        }
    });
    Ok(())
}

/// Drops the SoundCloud cookies from Orion's webview profile. The browser the
/// user normally uses is not touched.
#[tauri::command]
pub async fn soundcloud_sign_out(app: AppHandle) -> Result<(), String> {
    crate::youtube_audio::invalidate_session().await;
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        for cookie in window.cookies().map_err(|err| err.to_string())? {
            let ours = cookie.domain().is_some_and(|domain| {
                let domain = domain.trim_start_matches('.');
                domain == "soundcloud.com" || domain.ends_with(".soundcloud.com")
            });
            if ours {
                let _ = window.delete_cookie(cookie);
            }
        }
        Ok(())
    })
    .await
    .map_err(|err| err.to_string())?;

    forget_cookies();
    let _ = app.emit("soundcloud-sign-in", json!({ "signedIn": false }));
    result
}

/// The permalink path — `user/track-slug` — which is how Orion refers to a
/// SoundCloud track everywhere else.
fn permalink(entry: &Value) -> Option<String> {
    let url = entry["webpage_url"]
        .as_str()
        .or_else(|| entry["url"].as_str())?;
    let path = url
        .split_once("//soundcloud.com/")
        .or_else(|| url.split_once("//www.soundcloud.com/"))?
        .1;
    let path = path.split(['?', '#']).next()?.trim_end_matches('/');
    let mut parts = path.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(user), Some(slug), None) if !user.is_empty() && !slug.is_empty() => {
            Some(format!("{user}/{slug}"))
        }
        _ => None,
    }
}

/// The largest square artwork SoundCloud offers for the track.
fn artwork(entry: &Value) -> String {
    entry["thumbnails"]
        .as_array()
        .and_then(|thumbnails| {
            thumbnails
                .iter()
                .filter(|thumb| thumb["url"].is_string())
                .max_by_key(|thumb| thumb["width"].as_u64().unwrap_or(0))
                .and_then(|thumb| thumb["url"].as_str())
        })
        .or_else(|| entry["thumbnail"].as_str())
        .unwrap_or("")
        .to_string()
}

fn as_track(entry: &Value) -> Option<Value> {
    let id = permalink(entry)?;
    let name = entry["title"].as_str()?;
    // Tracks without a duration are previews or uploads still processing.
    let duration_ms = (entry["duration"].as_f64()? * 1000.0).round() as u64;
    if duration_ms == 0 {
        return None;
    }
    let artist = entry["uploader"]
        .as_str()
        .or_else(|| entry["uploader_id"].as_str())
        .unwrap_or("SoundCloud");
    Some(json!({
        "id": id,
        "name": name,
        "provider": "soundcloud",
        "uri": format!("soundcloud:track:{id}"),
        "durationMs": duration_ms,
        "artists": [{ "id": "", "name": artist }],
        "album": {
            "id": id,
            "name": "SoundCloud",
            "images": [{ "url": artwork(entry), "width": 500, "height": 500 }],
        },
    }))
}

/// SoundCloud's search, in result order. `page` walks further into it: yt-dlp
/// has no continuation token, so a page is fetched by asking for that many
/// results and keeping the last slice.
#[tauri::command]
pub async fn search_soundcloud(
    app: AppHandle,
    query: String,
    page: Option<usize>,
) -> Result<Value, String> {
    let query = query.trim().to_owned();
    if query.is_empty() || query.len() > 500 {
        return Err("Invalid search".into());
    }
    let page = page.unwrap_or(0).min(MAX_PAGE);
    let wanted = (page + 1) * PAGE_SIZE;

    let mut command = tokio::process::Command::new(crate::youtube_audio::helper(&app, "yt-dlp")?);
    command
        .args([
            "--ignore-config",
            "--no-plugin-dirs",
            "--no-warnings",
            "--flat-playlist",
            "--dump-json",
            "--socket-timeout",
            "10",
            "--retries",
            "1",
        ])
        .arg("--")
        // yt-dlp reads this as a search, never as a URL or an option.
        .arg(format!("scsearch{wanted}:{query}"))
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(SEARCH_TIMEOUT, command.output())
        .await
        .map_err(|_| "SoundCloud search timed out. Try again.")?
        .map_err(|_| "Audio helper could not start")?;
    if !output.status.success() {
        return Err("SoundCloud search failed. Try again.".into());
    }

    // One JSON object per line, in result order.
    let tracks: Vec<Value> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|entry| as_track(&entry))
        .skip(page * PAGE_SIZE)
        .collect();
    let more = tracks.len() >= PAGE_SIZE && page < MAX_PAGE;
    Ok(json!({ "tracks": tracks, "page": page, "hasMore": more }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permalink_keeps_only_user_and_slug() {
        let entry = json!({ "webpage_url": "https://soundcloud.com/some-user/some-track?in=x" });
        assert_eq!(permalink(&entry).as_deref(), Some("some-user/some-track"));
    }

    #[test]
    fn permalink_rejects_sets_and_profiles() {
        for url in [
            "https://soundcloud.com/some-user",
            "https://soundcloud.com/some-user/sets/a-playlist",
            "https://example.com/some-user/some-track",
        ] {
            assert_eq!(permalink(&json!({ "webpage_url": url })), None, "{url}");
        }
    }

    #[test]
    fn tracks_without_a_duration_are_dropped() {
        let entry = json!({
            "webpage_url": "https://soundcloud.com/u/t",
            "title": "Still processing",
            "duration": 0.0,
        });
        assert_eq!(as_track(&entry), None);
    }

    #[test]
    fn a_full_entry_becomes_a_unified_track() {
        let entry = json!({
            "webpage_url": "https://soundcloud.com/u/t",
            "title": "Song",
            "duration": 120.5,
            "uploader": "Artist",
            "thumbnails": [
                { "url": "small.jpg", "width": 20 },
                { "url": "large.jpg", "width": 500 },
            ],
        });
        let track = as_track(&entry).expect("track");
        assert_eq!(track["uri"], "soundcloud:track:u/t");
        assert_eq!(track["durationMs"], 120500);
        assert_eq!(track["artists"][0]["name"], "Artist");
        assert_eq!(track["album"]["images"][0]["url"], "large.jpg");
    }
}
