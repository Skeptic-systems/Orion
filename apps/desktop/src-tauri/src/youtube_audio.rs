//! Audio-only playback for the services Orion streams itself: YouTube and
//! SoundCloud. The bundled yt-dlp resolves a track's audio stream — with the
//! service's session from Connections when there is one — and a loopback
//! proxy hands it to the webview's <audio> element.
//!
//! Jellyfin does not come through here: its server hands out a direct URL.
//!
//! Resolving takes seconds, so songs the user is likely to play are resolved
//! ahead of time, and the first half megabyte of their audio is fetched too:
//! the proxy answers the player's first request from memory and streams the
//! rest behind it, so a prefetched song starts at once.

use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::get,
    Router,
};
use futures_util::{StreamExt, TryStreamExt};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, OnceCell};

const RESOLVE_TIMEOUT: Duration = Duration::from_secs(45);
/// Streams kept registered: the one playing and the few the webview is leaving.
const MAX_STREAMS: usize = 4;
/// Reading cookies goes through WebView2's UI thread, and the session only
/// changes on sign-in or sign-out, which both clear this.
const SESSION_TTL: Duration = Duration::from_secs(600);
/// googlevideo URLs state their own expiry; one is reused until shortly before.
const EXPIRY_MARGIN: Duration = Duration::from_secs(600);
const MAX_REUSE: Duration = Duration::from_secs(3 * 3600);
const REUSE_WITHOUT_EXPIRY: Duration = Duration::from_secs(1800);
/// Prefetches resolving at once, each a yt-dlp and a deno process.
const PREFETCH_WORKERS: usize = 2;
/// Waiting prefetches; older ones fall off when newer, likelier songs arrive.
const MAX_QUEUED: usize = 8;
/// Audio fetched ahead for a prefetched song, about half a minute of it.
const HEAD_BYTES: u64 = 512 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_HEADS: usize = 16;

/// The first bytes of a stream, held in memory.
struct Head {
    bytes: Bytes,
    total: u64,
    content_type: Option<String>,
}

#[derive(Clone)]
struct Stream {
    url: String,
    headers: Vec<(String, String)>,
    head: Option<Arc<Head>>,
}

#[derive(Clone)]
struct Resolved {
    stream: Stream,
    fresh_until: Instant,
}

/// One resolve per video, shared by everyone who asks for it meanwhile.
type Slot = Arc<OnceCell<Result<Resolved, String>>>;

#[derive(Default)]
struct Registry {
    streams: HashMap<String, Stream>,
    order: VecDeque<String>,
}

struct Server {
    port: u16,
    registry: Arc<Mutex<Registry>>,
}

static SERVER: OnceCell<Server> = OnceCell::const_new();
static GENERATION: AtomicU64 = AtomicU64::new(0);
static RESOLVED: LazyLock<Mutex<HashMap<String, (u64, Slot)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static HEADS: LazyLock<std::sync::Mutex<HashMap<String, (Instant, Arc<Head>)>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));
/// One cached session per service. The inner `Option` is the session itself:
/// `None` there means nobody is signed in and yt-dlp runs anonymously.
type CachedSession = Option<(Instant, Option<String>)>;
static SESSIONS: std::sync::Mutex<[CachedSession; 2]> = std::sync::Mutex::new([None, None]);
static QUEUE: std::sync::Mutex<VecDeque<String>> = std::sync::Mutex::new(VecDeque::new());
static WORKERS: AtomicUsize = AtomicUsize::new(0);
static PROXY: OnceLock<reqwest::Client> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    stream_id: String,
    url: String,
}

/// A service Orion resolves audio from. Everything below is keyed by
/// `"<source>:<id>"` so one cache, one queue and one proxy serve both.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    YouTube,
    SoundCloud,
}

struct TrackRef {
    source: Source,
    id: String,
}

impl TrackRef {
    /// `youtube:<11-char id>` or `soundcloud:<user>/<slug>`. Anything else is
    /// refused here rather than reaching yt-dlp's argument list.
    fn parse(reference: &str) -> Option<Self> {
        let (source, id) = reference.split_once(':')?;
        let source = match source {
            "youtube" => Source::YouTube,
            "soundcloud" => Source::SoundCloud,
            _ => return None,
        };
        valid_id(source, id).then(|| Self { source, id: id.to_owned() })
    }

    fn page_url(&self) -> String {
        match self.source {
            Source::YouTube => format!("https://www.youtube.com/watch?v={}", self.id),
            Source::SoundCloud => format!("https://soundcloud.com/{}", self.id),
        }
    }

    /// SoundCloud also serves HLS, which the webview's <audio> cannot play, so
    /// a progressive stream is asked for first and HLS only as a last resort.
    fn format(&self) -> &'static str {
        match self.source {
            Source::YouTube => "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
            Source::SoundCloud => "http_mp3_128/bestaudio[protocol^=http]/bestaudio",
        }
    }
}

fn valid_id(source: Source, id: &str) -> bool {
    match source {
        Source::YouTube => {
            id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        }
        // "user/track-slug", the permalink path and nothing more: no scheme,
        // no query, no traversal, so it cannot address anything but a track.
        Source::SoundCloud => {
            let mut parts = id.split('/');
            let (Some(user), Some(slug), None) = (parts.next(), parts.next(), parts.next()) else {
                return false;
            };
            [user, slug].iter().all(|part| {
                !part.is_empty()
                    && part.len() <= 120
                    && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
        }
    }
}

/// Where a resolved stream may point, per service. Checked once, on the URL
/// yt-dlp returned, before it is ever registered with the proxy.
fn allowed_for(source: Source, url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    match source {
        Source::YouTube => url.scheme() == "https" && host.ends_with(".googlevideo.com"),
        // SoundCloud's media CDN. Plain http appears on some progressive URLs.
        Source::SoundCloud => {
            matches!(url.scheme(), "https" | "http") && host.ends_with(".sndcdn.com")
        }
    }
}

/// The union of the above, for the proxy's redirect policy: a stream is tied
/// to its service at resolve time, so following a redirect only has to stay
/// inside the set of CDNs this app talks to at all.
fn allowed_url(url: &reqwest::Url) -> bool {
    allowed_for(Source::YouTube, url) || allowed_for(Source::SoundCloud, url)
}

/// How long a resolved URL may be handed out again.
fn reuse_window(url: &str, now_unix: u64) -> Duration {
    let expires = reqwest::Url::parse(url).ok().and_then(|url| {
        url.query_pairs()
            .find(|(key, _)| key == "expire")
            .and_then(|(_, value)| value.parse::<u64>().ok())
    });
    match expires {
        Some(at) => Duration::from_secs(at.saturating_sub(now_unix))
            .saturating_sub(EXPIRY_MARGIN)
            .min(MAX_REUSE),
        None => REUSE_WITHOUT_EXPIRY,
    }
}

/// `bytes=start-` or `bytes=start-end`; anything fancier goes straight upstream.
fn parse_range(value: &str) -> Option<(u64, Option<u64>)> {
    let spec = value.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let start = start.trim().parse().ok()?;
    let end = end.trim();
    let end = if end.is_empty() {
        None
    } else {
        Some(end.parse().ok()?)
    };
    Some((start, end))
}

/// One client for every request, so seeking reuses the open connection.
fn proxy_client() -> Result<&'static reqwest::Client, StatusCode> {
    if let Some(client) = PROXY.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < 4 && allowed_url(attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(PROXY.get_or_init(|| client))
}

fn upstream(stream: &Stream, range: Option<String>) -> Result<reqwest::RequestBuilder, StatusCode> {
    let mut request = proxy_client()?.get(&stream.url);
    for (key, value) in &stream.headers {
        request = request.header(key, value);
    }
    if let Some(range) = range {
        request = request.header("range", range);
    }
    Ok(request)
}

/// Answers a request from the start of the file: the held bytes at once, the
/// rest streamed from YouTube behind them.
fn serve_head(stream: &Stream, head: &Head, end: u64, partial: bool) -> Result<Response, StatusCode> {
    let length = end + 1;
    let held = head.bytes.len() as u64;
    let first = head.bytes.slice(..held.min(length) as usize);
    let body = if length <= held {
        Body::from(first)
    } else {
        let request = upstream(stream, Some(format!("bytes={held}-{end}")))?;
        let rest = futures_util::stream::once(async move {
            let response = request.send().await.map_err(std::io::Error::other)?;
            if response.status() != StatusCode::PARTIAL_CONTENT {
                return Err(std::io::Error::other("YouTube refused the rest of the stream"));
            }
            Ok(response.bytes_stream().map_err(std::io::Error::other))
        })
        .try_flatten();
        Body::from_stream(
            futures_util::stream::once(async move { Ok::<_, std::io::Error>(first) }).chain(rest),
        )
    };
    let mut response = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header("cache-control", "no-store")
        .header("accept-ranges", "bytes")
        .header("content-length", length);
    if partial {
        response = response.header("content-range", format!("bytes 0-{end}/{}", head.total));
    }
    if let Some(content_type) = &head.content_type {
        response = response.header("content-type", content_type);
    }
    response.body(body).map_err(|_| StatusCode::BAD_GATEWAY)
}

async fn audio(
    Path(token): Path<String>,
    State(registry): State<Arc<Mutex<Registry>>>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let stream = registry
        .lock()
        .await
        .streams
        .get(&token)
        .cloned()
        .ok_or(StatusCode::NOT_FOUND)?;
    let range = headers.get("range").and_then(|value| value.to_str().ok());
    let parsed = range.map(parse_range);
    if let Some(head) = &stream.head {
        let requested_end = match parsed {
            None => Some(None),
            Some(Some((0, end))) => Some(end),
            _ => None,
        };
        if let Some(end) = requested_end {
            let last = head.total - 1;
            return serve_head(&stream, head, end.map_or(last, |end| end.min(last)), range.is_some());
        }
    }
    let mut request = upstream(&stream, None)?;
    for key in ["range", "if-range"] {
        if let Some(value) = headers.get(key) {
            request = request.header(key, value);
        }
    }
    let upstream = request.send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut response = Response::builder()
        .status(upstream.status())
        .header("cache-control", "no-store");
    for key in ["content-type", "content-length", "content-range", "accept-ranges"] {
        if let Some(value) = upstream.headers().get(key) {
            response = response.header(key, value);
        }
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .map_err(|_| StatusCode::BAD_GATEWAY)
}

async fn server() -> Result<&'static Server, String> {
    SERVER
        .get_or_try_init(|| async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .map_err(|e| e.to_string())?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let registry = Arc::new(Mutex::new(Registry::default()));
            let router = Router::new()
                .route("/audio/{token}", get(audio))
                .with_state(registry.clone());
            tauri::async_runtime::spawn(async move {
                let _ = axum::serve(listener, router).await;
            });
            Ok(Server { port, registry })
        })
        .await
}

/// A bundled helper's path, for the other modules that drive yt-dlp.
pub(crate) fn helper(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    binary(app, name)
}

fn binary(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let arch = std::env::consts::ARCH;
    let root = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    } else {
        app.path().resource_dir().map_err(|e| e.to_string())?
    };
    // Each helper sits in its own folder. yt-dlp is its unpacked build: the
    // single-file one extracted itself on every start, a second per song.
    let path = root
        .join("resources")
        .join("audio")
        .join(format!("{platform}-{arch}"))
        .join(name)
        .join(format!("{name}{extension}"));
    if path.is_file() {
        Ok(path)
    } else {
        Err("Audio helper is missing. Run pnpm --filter desktop audio:prepare or reinstall Orion.".into())
    }
}

pub(crate) async fn invalidate_session() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    forget_session();
    if let Ok(mut queue) = QUEUE.lock() {
        queue.clear();
    }
    if let Ok(mut heads) = HEADS.lock() {
        heads.clear();
    }
    RESOLVED.lock().await.clear();
    if let Some(server) = SERVER.get() {
        *server.registry.lock().await = Registry::default();
    }
}

/// Drops the cached cookies, so the next resolve reads the current session.
pub(crate) fn forget_session() {
    if let Ok(mut sessions) = SESSIONS.lock() {
        *sessions = [None, None];
    }
}

fn session_slot(source: Source) -> usize {
    match source {
        Source::YouTube => 0,
        Source::SoundCloud => 1,
    }
}

async fn session(app: &AppHandle, source: Source) -> Result<Option<String>, String> {
    let slot = session_slot(source);
    let cached = SESSIONS.lock().ok().and_then(|sessions| {
        sessions[slot]
            .as_ref()
            .filter(|(at, _)| at.elapsed() < SESSION_TTL)
            .map(|(_, text)| text.clone())
    });
    if let Some(text) = cached {
        return Ok(text);
    }
    let text = match source {
        Source::YouTube => crate::music_video::audio_session(app).await?,
        Source::SoundCloud => crate::soundcloud::audio_session(app).await?,
    };
    if let Ok(mut sessions) = SESSIONS.lock() {
        sessions[slot] = Some((Instant::now(), text.clone()));
    }
    Ok(text)
}

async fn resolve(app: AppHandle, reference: String) -> Result<Resolved, String> {
    let track = TrackRef::parse(&reference).ok_or("Unknown track")?;
    let session = session(&app, track.source).await?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    // Without a sign-in there is no cookie file and yt-dlp resolves anonymously.
    let cookies = match session {
        Some(text) => {
            let directory = cache.join("audio-session");
            std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let mut file = tempfile::NamedTempFile::new_in(&directory)
                .map_err(|_| "Cannot create audio session")?;
            file.write_all(text.as_bytes())
                .map_err(|_| "Cannot prepare audio session")?;
            Some(file)
        }
        None => None,
    };
    let mut command = tokio::process::Command::new(binary(&app, "yt-dlp")?);
    command
        .args([
            "--ignore-config",
            "--no-plugin-dirs",
            "--no-playlist",
            "--skip-download",
            "--dump-single-json",
            "--no-warnings",
            "--socket-timeout",
            "15",
            "--retries",
            "1",
        ])
        .arg("--format")
        .arg(track.format())
        // Manifests and translated subtitles are never used here.
        .arg("--extractor-args")
        .arg("youtube:skip=dash,hls,translated_subs")
        // Keeps YouTube's player script and solved challenges between songs.
        .arg("--cache-dir")
        .arg(cache.join("yt-dlp"))
        .arg("--js-runtimes")
        .arg(format!("deno:{}", binary(&app, "deno")?.display()));
    if let Some(file) = &cookies {
        command.arg("--cookies").arg(file.path());
    }
    command
        .arg("--")
        .arg(track.page_url())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(RESOLVE_TIMEOUT, command.output())
        .await
        .map_err(|_| "Audio resolving timed out. Try again.")?
        .map_err(|_| "Audio helper could not start")?;
    // Resolver stderr can contain account or signed URL details; never forward it.
    if !output.status.success() {
        return Err(match track.source {
            Source::YouTube => "YouTube could not provide this audio. The video may be unavailable, or it needs a YouTube sign-in under Connections.",
            Source::SoundCloud => "SoundCloud could not provide this audio. The track may be private or unavailable for streaming.",
        }
        .into());
    }
    let data: Value = serde_json::from_slice(&output.stdout).map_err(|_| "Invalid audio response")?;
    let url = data["url"]
        .as_str()
        .ok_or("No playable audio format available")?;
    if !reqwest::Url::parse(url).is_ok_and(|url| allowed_for(track.source, &url)) {
        return Err("Unsupported audio stream".into());
    }
    let headers = ["User-Agent", "Referer", "Origin"]
        .iter()
        .filter_map(|key| {
            data["http_headers"][key]
                .as_str()
                .map(|value| (key.to_string(), value.to_string()))
        })
        .collect();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    Ok(Resolved {
        fresh_until: Instant::now() + reuse_window(url, now),
        stream: Stream {
            url: url.into(),
            headers,
            head: None,
        },
    })
}

/// The track's stream: cached while its URL is fresh, otherwise resolved once
/// no matter how many callers wait for it.
async fn resolved(app: &AppHandle, reference: &str, fresh: bool) -> Result<Stream, String> {
    let generation = GENERATION.load(Ordering::SeqCst);
    let slot = {
        let mut cache = RESOLVED.lock().await;
        let now = Instant::now();
        cache.retain(|_, (made, slot)| {
            *made == generation
                && match slot.get() {
                    Some(Ok(resolved)) => resolved.fresh_until > now,
                    Some(Err(_)) => false,
                    None => true,
                }
        });
        if fresh {
            cache.remove(reference);
        }
        cache
            .entry(reference.to_owned())
            .or_insert_with(|| (generation, Arc::new(OnceCell::new())))
            .1
            .clone()
    };
    let result = slot
        .get_or_init(|| resolve(app.clone(), reference.to_owned()))
        .await
        .clone();
    if generation != GENERATION.load(Ordering::SeqCst) {
        return Err("The signed-in session changed".into());
    }
    result.map(|resolved| resolved.stream)
}

fn cached_head(url: &str) -> Option<Arc<Head>> {
    HEADS.lock().ok()?.get(url).map(|(_, head)| head.clone())
}

fn remember_head(url: &str, head: Head) {
    let Ok(mut heads) = HEADS.lock() else { return };
    heads.insert(url.to_owned(), (Instant::now(), Arc::new(head)));
    while heads.len() > MAX_HEADS {
        let Some(oldest) = heads
            .iter()
            .min_by_key(|(_, (at, _))| *at)
            .map(|(url, _)| url.clone())
        else {
            break;
        };
        heads.remove(&oldest);
    }
}

async fn fetch_head(stream: &Stream) -> Option<Head> {
    let request = upstream(stream, Some(format!("bytes=0-{}", HEAD_BYTES - 1))).ok()?;
    let response = tokio::time::timeout(HEAD_TIMEOUT, request.send())
        .await
        .ok()?
        .ok()?;
    if response.status() != StatusCode::PARTIAL_CONTENT {
        return None;
    }
    let total = response
        .headers()
        .get("content-range")?
        .to_str()
        .ok()?
        .rsplit('/')
        .next()?
        .parse::<u64>()
        .ok()?;
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = tokio::time::timeout(HEAD_TIMEOUT, response.bytes())
        .await
        .ok()?
        .ok()?;
    (!bytes.is_empty() && bytes.len() as u64 <= total).then_some(Head {
        bytes,
        total,
        content_type,
    })
}

fn ensure_workers(app: &AppHandle) {
    loop {
        let running = WORKERS.load(Ordering::SeqCst);
        let waiting = QUEUE.lock().map(|queue| !queue.is_empty()).unwrap_or(false);
        if running >= PREFETCH_WORKERS || !waiting {
            return;
        }
        if WORKERS
            .compare_exchange(running, running + 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let app = app.clone();
            tauri::async_runtime::spawn(prefetch_worker(app));
        }
    }
}

async fn prefetch_worker(app: AppHandle) {
    loop {
        let next = QUEUE.lock().ok().and_then(|mut queue| queue.pop_front());
        let Some(reference) = next else { break };
        if let Ok(stream) = resolved(&app, &reference, false).await {
            if cached_head(&stream.url).is_none() {
                if let Some(head) = fetch_head(&stream).await {
                    remember_head(&stream.url, head);
                }
            }
        }
    }
    WORKERS.fetch_sub(1, Ordering::SeqCst);
    // A song queued while this worker was on its way out still gets its turn.
    ensure_workers(&app);
}

async fn register(mut stream: Stream) -> Result<AudioStream, String> {
    stream.head = cached_head(&stream.url);
    let server = server().await?;
    let stream_id = format!("{:032x}", rand::random::<u128>());
    let mut registry = server.registry.lock().await;
    registry.streams.insert(stream_id.clone(), stream);
    registry.order.push_back(stream_id.clone());
    while registry.order.len() > MAX_STREAMS {
        if let Some(oldest) = registry.order.pop_front() {
            registry.streams.remove(&oldest);
        }
    }
    Ok(AudioStream {
        url: format!("http://127.0.0.1:{}/audio/{stream_id}", server.port),
        stream_id,
    })
}

#[tauri::command]
pub async fn release_audio(stream_id: String) {
    if let Some(server) = SERVER.get() {
        let mut registry = server.registry.lock().await;
        registry.streams.remove(&stream_id);
        registry.order.retain(|id| id != &stream_id);
    }
}

/// `track` is `"<source>:<id>"`; `fresh` skips the cache, for a stream whose
/// URL stopped working.
#[tauri::command]
pub async fn resolve_audio(
    app: AppHandle,
    track: String,
    fresh: Option<bool>,
) -> Result<AudioStream, String> {
    if TrackRef::parse(&track).is_none() {
        return Err("Invalid track".into());
    }
    let stream = resolved(&app, &track, fresh.unwrap_or(false)).await?;
    register(stream).await
}

/// Queues tracks to resolve ahead of time, the first one most urgently.
#[tauri::command]
pub async fn prefetch_audio(app: AppHandle, tracks: Vec<String>) {
    {
        let Ok(mut queue) = QUEUE.lock() else { return };
        for reference in tracks.into_iter().take(MAX_QUEUED).rev() {
            if TrackRef::parse(&reference).is_none() {
                continue;
            }
            queue.retain(|queued| queued != &reference);
            queue.push_front(reference);
        }
        queue.truncate(MAX_QUEUED);
    }
    ensure_workers(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_restricts_destinations() {
        for url in [
            "http://x.googlevideo.com/a",
            "https://googlevideo.com.evil.test",
            "https://127.0.0.1/",
        ] {
            assert!(!allowed_url(&url.parse().unwrap()));
        }
        assert!(allowed_url(
            &"https://rr1.googlevideo.com/videoplayback".parse().unwrap()
        ));
    }

    #[test]
    fn reuse_stops_before_the_url_expires() {
        let url = "https://rr1.googlevideo.com/videoplayback?expire=10000&id=x";
        assert_eq!(reuse_window(url, 10000 - 3600), Duration::from_secs(3000));
        assert_eq!(reuse_window(url, 9900), Duration::ZERO);
        assert_eq!(
            reuse_window("https://rr1.googlevideo.com/videoplayback", 0),
            REUSE_WITHOUT_EXPIRY
        );
    }

    #[test]
    fn video_ids_are_checked() {
        assert!(valid_id(Source::YouTube, "dQw4w9WgXcQ"));
        assert!(!valid_id(Source::YouTube, "dQw4w9WgXc"));
        assert!(!valid_id(Source::YouTube, "dQw4w9WgX/Q"));
    }

    #[test]
    fn soundcloud_ids_are_permalink_paths() {
        assert!(valid_id(Source::SoundCloud, "some-user/some-track"));
        assert!(valid_id(Source::SoundCloud, "user_1/track_2"));
        // A bare profile, a set, a traversal or a full URL are all refused.
        for id in [
            "some-user",
            "some-user/sets/a-playlist",
            "../../etc",
            "https://soundcloud.com/u/t",
            "u/t?x=1",
            "",
        ] {
            assert!(!valid_id(Source::SoundCloud, id), "{id:?} should be refused");
        }
    }

    #[test]
    fn track_refs_carry_their_source() {
        let youtube = TrackRef::parse("youtube:dQw4w9WgXcQ").expect("youtube ref");
        assert_eq!(youtube.page_url(), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        let soundcloud = TrackRef::parse("soundcloud:u/t").expect("soundcloud ref");
        assert_eq!(soundcloud.page_url(), "https://soundcloud.com/u/t");
        assert!(TrackRef::parse("jellyfin:abc").is_none());
        assert!(TrackRef::parse("dQw4w9WgXcQ").is_none());
    }

    #[test]
    fn a_stream_may_only_point_at_its_own_service() {
        let googlevideo = reqwest::Url::parse("https://rr1.googlevideo.com/x").unwrap();
        let sndcdn = reqwest::Url::parse("https://cf-media.sndcdn.com/x.mp3").unwrap();
        assert!(allowed_for(Source::YouTube, &googlevideo));
        assert!(!allowed_for(Source::YouTube, &sndcdn));
        assert!(allowed_for(Source::SoundCloud, &sndcdn));
        assert!(!allowed_for(Source::SoundCloud, &googlevideo));
        // The proxy's redirect policy accepts either, but nothing else.
        assert!(allowed_url(&googlevideo) && allowed_url(&sndcdn));
        assert!(!allowed_url(&reqwest::Url::parse("https://evil.example.com/x").unwrap()));
    }

    #[test]
    fn ranges_are_parsed() {
        assert_eq!(parse_range("bytes=0-"), Some((0, None)));
        assert_eq!(parse_range("bytes=0-1023"), Some((0, Some(1023))));
        assert_eq!(parse_range("bytes=500-"), Some((500, None)));
        assert_eq!(parse_range("bytes=0-1,5-9"), None);
        assert_eq!(parse_range("items=0-"), None);
    }
}
