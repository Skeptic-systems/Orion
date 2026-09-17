//! A user's own Jellyfin server as a music source.
//!
//! Sign-in is Jellyfin's own username and password: `/Users/AuthenticateByName`
//! trades them for an access token, and the password is never stored — only
//! the server URL, the token and the user id go into the credential store,
//! next to the Spotify ones. An API key works just as well for anyone who
//! would rather issue one in the Jellyfin dashboard.
//!
//! Audio does not go through the yt-dlp resolver: a Jellyfin item has a stable
//! stream URL on the user's own server, which the webview plays directly.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;


const CREDENTIAL_KEY: &str = "jellyfin_session";
const TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);
/// Jellyfin identifies clients by this; it shows up in the server's dashboard
/// as an authorised device the user can revoke.
const CLIENT: &str = "Orion";
const DEVICE: &str = "Orion Desktop";
const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Page size for searches and playlist reads.
const PAGE: usize = 100;

#[derive(Clone, Deserialize, Serialize)]
struct Session {
    /// Normalised: scheme, host, optional port and base path, no trailing slash.
    server: String,
    token: String,
    user_id: String,
    user_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JellyfinStatus {
    connected: bool,
    server: Option<String>,
    user_name: Option<String>,
}

fn load() -> Option<Session> {
    crate::credential_store::get(CREDENTIAL_KEY)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

fn store(session: &Session) -> Result<(), String> {
    let text = serde_json::to_string(session).map_err(|err| err.to_string())?;
    crate::credential_store::set(CREDENTIAL_KEY, &text)
}

fn session() -> Result<Session, String> {
    load().ok_or_else(|| "Connect a Jellyfin server under Settings → Connections first".into())
}

/// Accepts what a user would paste — `jelly.example.com`, a full URL, a base
/// path — and returns the origin Orion will call. Anything that is not a plain
/// http(s) host is refused rather than half-guessed.
fn normalize_server(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Enter your Jellyfin server address".into());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    let url = reqwest::Url::parse(&with_scheme).map_err(|_| "That is not a valid address")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The server address must start with http:// or https://".into());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("That address has no host".into());
    }
    let mut origin = format!(
        "{}://{}",
        url.scheme(),
        url.host_str().unwrap_or_default()
    );
    if let Some(port) = url.port() {
        origin.push_str(&format!(":{port}"));
    }
    // Jellyfin is often served under a path, e.g. behind a reverse proxy.
    let path = url.path().trim_end_matches('/');
    if !path.is_empty() {
        origin.push_str(path);
    }
    Ok(origin)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|err| err.to_string())
}

/// Jellyfin's authorisation header. Without a token it still has to be sent:
/// that is how the server recognises the client on the sign-in call.
fn authorization(token: Option<&str>) -> String {
    let mut header = format!(
        "MediaBrowser Client=\"{CLIENT}\", Device=\"{DEVICE}\", DeviceId=\"orion-desktop\", Version=\"{VERSION}\""
    );
    if let Some(token) = token {
        header.push_str(&format!(", Token=\"{token}\""));
    }
    header
}

async fn get(session: &Session, path: &str, query: &[(&str, String)]) -> Result<Value, String> {
    let response = client()?
        .get(format!("{}/{path}", session.server))
        .header("Authorization", authorization(Some(&session.token)))
        .header("Accept", "application/json")
        .query(query)
        .send()
        .await
        .map_err(|_| "Your Jellyfin server could not be reached")?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Your Jellyfin session expired. Sign in again under Connections.".into());
    }
    if !response.status().is_success() {
        return Err(format!("Jellyfin answered {}", response.status()));
    }
    response
        .json()
        .await
        .map_err(|_| "Jellyfin returned an invalid response".into())
}

#[tauri::command]
pub async fn jellyfin_status() -> JellyfinStatus {
    match load() {
        Some(session) => JellyfinStatus {
            connected: true,
            server: Some(session.server),
            user_name: Some(session.user_name),
        },
        None => JellyfinStatus {
            connected: false,
            server: None,
            user_name: None,
        },
    }
}

/// Signs in with the user's own Jellyfin credentials. The password is used for
/// this one call and never written anywhere.
#[tauri::command]
pub async fn jellyfin_connect(
    server: String,
    username: String,
    password: String,
) -> Result<JellyfinStatus, String> {
    let server = normalize_server(&server)?;
    if username.trim().is_empty() {
        return Err("Enter your Jellyfin username".into());
    }
    let response = client()?
        .post(format!("{server}/Users/AuthenticateByName"))
        .header("Authorization", authorization(None))
        .header("Content-Type", "application/json")
        .json(&json!({ "Username": username.trim(), "Pw": password }))
        .send()
        .await
        .map_err(|_| "Your Jellyfin server could not be reached. Check the address.")?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Jellyfin rejected that username or password".into());
    }
    if !response.status().is_success() {
        return Err(format!("Jellyfin answered {}", response.status()));
    }
    let data: Value = response
        .json()
        .await
        .map_err(|_| "Jellyfin returned an invalid response")?;
    let token = data["AccessToken"]
        .as_str()
        .ok_or("Jellyfin did not return an access token")?;
    let user_id = data["User"]["Id"]
        .as_str()
        .ok_or("Jellyfin did not return a user")?;
    let session = Session {
        server,
        token: token.to_owned(),
        user_id: user_id.to_owned(),
        user_name: data["User"]["Name"].as_str().unwrap_or(&username).to_owned(),
    };
    store(&session)?;
    Ok(JellyfinStatus {
        connected: true,
        server: Some(session.server),
        user_name: Some(session.user_name),
    })
}

/// Signs in with an API key issued in the Jellyfin dashboard instead of a
/// password. The key authenticates as the server, so the user to browse as is
/// looked up by name.
#[tauri::command]
pub async fn jellyfin_connect_with_key(
    server: String,
    username: String,
    api_key: String,
) -> Result<JellyfinStatus, String> {
    let server = normalize_server(&server)?;
    let key = api_key.trim().to_owned();
    if key.is_empty() {
        return Err("Enter your Jellyfin API key".into());
    }
    // A throwaway session, only to resolve the user the key should act as.
    let probe = Session {
        server: server.clone(),
        token: key.clone(),
        user_id: String::new(),
        user_name: String::new(),
    };
    let users = get(&probe, "Users", &[]).await?;
    let wanted = username.trim();
    let user = users
        .as_array()
        .ok_or("Jellyfin returned an invalid user list")?
        .iter()
        .find(|user| {
            wanted.is_empty()
                || user["Name"]
                    .as_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(wanted))
        })
        .ok_or("No Jellyfin user by that name")?;
    let session = Session {
        server,
        token: key,
        user_id: user["Id"]
            .as_str()
            .ok_or("Jellyfin user has no id")?
            .to_owned(),
        user_name: user["Name"].as_str().unwrap_or("Jellyfin").to_owned(),
    };
    store(&session)?;
    Ok(JellyfinStatus {
        connected: true,
        server: Some(session.server),
        user_name: Some(session.user_name),
    })
}

#[tauri::command]
pub async fn jellyfin_disconnect() -> Result<(), String> {
    match crate::credential_store::delete(CREDENTIAL_KEY) {
        // Already gone is the state the caller wanted.
        Err(_) | Ok(()) => Ok(()),
    }
}

/// The access token as a query parameter, for the URLs the webview fetches
/// itself — an <img> or an <audio> cannot send an Authorization header.
///
/// Both spellings go in. Jellyfin renamed the parameter to `ApiKey`, and the
/// legacy `api_key` is no longer accepted on `/Audio/…/universal`: that lone
/// 401 is what made every Jellyfin song fail to load. Older servers still only
/// know `api_key`, so sending both keeps either kind of server happy.
fn query_auth(session: &Session) -> String {
    format!("ApiKey={}&api_key={}", session.token, session.token)
}

fn image_url(session: &Session, item: &Value) -> String {
    // Songs without their own cover inherit the album's.
    let (id, tag) = match item["ImageTags"]["Primary"].as_str() {
        Some(tag) => (item["Id"].as_str().unwrap_or_default(), tag),
        None => match item["AlbumPrimaryImageTag"].as_str() {
            Some(tag) => (item["AlbumId"].as_str().unwrap_or_default(), tag),
            None => return String::new(),
        },
    };
    if id.is_empty() {
        return String::new();
    }
    format!(
        "{}/Items/{id}/Images/Primary?maxHeight=500&tag={tag}&{}",
        session.server,
        query_auth(session)
    )
}

/// Whoever Jellyfin credits for the item. A file with no artist tag still has
/// an album artist more often than not, so the names are taken from whichever
/// of these the server filled in.
fn artist_names(item: &Value) -> Vec<Value> {
    for key in ["Artists", "AlbumArtists", "ArtistItems"] {
        let Some(entries) = item[key].as_array() else { continue };
        let names: Vec<Value> = entries
            .iter()
            // "Artists" holds plain strings, the other two hold objects.
            .filter_map(|entry| entry.as_str().or_else(|| entry["Name"].as_str()))
            .filter(|name| !name.trim().is_empty())
            .map(|name| json!({ "id": "", "name": name }))
            .collect();
        if !names.is_empty() {
            return names;
        }
    }
    match item["AlbumArtist"].as_str().filter(|name| !name.trim().is_empty()) {
        Some(name) => vec![json!({ "id": "", "name": name })],
        None => Vec::new(),
    }
}

/// A Jellyfin audio item as the UnifiedTrack the rest of Orion speaks.
fn as_track(session: &Session, item: &Value) -> Option<Value> {
    let id = item["Id"].as_str()?;
    if !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return None;
    }
    let name = item["Name"].as_str()?;
    // Jellyfin counts in ticks of 100 nanoseconds.
    let duration_ms = item["RunTimeTicks"].as_u64().unwrap_or(0) / 10_000;
    let artists = artist_names(item);
    Some(json!({
        "id": id,
        "name": name,
        "provider": "jellyfin",
        "uri": format!("jellyfin:track:{id}"),
        "durationMs": duration_ms,
        // Left as they come, gaps and all: `fill_from_albums` still has to
        // look them up on the parent album, and `Unknown artist` would hide
        // which tracks actually need that.
        "artists": artists,
        "album": {
            "id": item["AlbumId"].as_str().unwrap_or(id),
            "name": item["Album"].as_str().unwrap_or(""),
            "images": [{ "url": image_url(session, item), "width": 500, "height": 500 }],
        },
    }))
}

/// Many music files carry no artist or album tag of their own while the album
/// they sit in is tagged properly — Jellyfin then answers with `Artists: []`
/// and `Album: null` on every song. The parent albums are fetched in one
/// request and their details filled into the tracks that lack them.
async fn fill_from_albums(session: &Session, tracks: &mut [Value]) {
    let missing: Vec<String> = tracks
        .iter()
        .filter(|track| needs_album(track))
        .filter_map(|track| track["album"]["id"].as_str().map(str::to_owned))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    if missing.is_empty() {
        return;
    }

    let Ok(data) = get(
        session,
        "Items",
        &[
            ("userId", session.user_id.clone()),
            ("ids", missing.join(",")),
        ],
    )
    .await
    else {
        // A failed lookup only costs the nicer labels, never the tracks.
        return;
    };
    let albums: std::collections::HashMap<&str, &Value> = data["Items"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|album| Some((album["Id"].as_str()?, album)))
        .collect();

    for track in tracks.iter_mut().filter(|track| needs_album(track)) {
        let Some(album) = track["album"]["id"].as_str().and_then(|id| albums.get(id)) else {
            continue;
        };
        if track["artists"].as_array().is_some_and(Vec::is_empty) {
            track["artists"] = json!(artist_names(album));
        }
        if track["album"]["name"].as_str().is_none_or(str::is_empty) {
            track["album"]["name"] = json!(album["Name"].as_str().unwrap_or("Jellyfin"));
        }
        if track["album"]["images"][0]["url"]
            .as_str()
            .is_none_or(str::is_empty)
        {
            track["album"]["images"][0]["url"] = json!(image_url(session, album));
        }
    }
}

fn needs_album(track: &Value) -> bool {
    track["artists"].as_array().is_some_and(Vec::is_empty)
        || track["album"]["name"].as_str().is_none_or(str::is_empty)
        || track["album"]["images"][0]["url"]
            .as_str()
            .is_none_or(str::is_empty)
}

/// The last word on a track with nothing to show, once the album was asked too.
fn label_gaps(track: &mut Value) {
    if track["artists"].as_array().is_some_and(Vec::is_empty) {
        track["artists"] = json!([{ "id": "", "name": "Unknown artist" }]);
    }
    if track["album"]["name"].as_str().is_none_or(str::is_empty) {
        track["album"]["name"] = json!("Jellyfin");
    }
}

/// Real `ItemFields` values. Name, Artists, Album, RunTimeTicks and ImageTags
/// are base properties Jellyfin always returns; asking for them here would be
/// an unknown enum value, which stricter servers answer with a 400.
const TRACK_FIELDS: &str = "AudioInfo,ParentId";

#[tauri::command]
pub async fn search_jellyfin(query: String, offset: Option<usize>) -> Result<Value, String> {
    let session = session()?;
    let query = query.trim().to_owned();
    if query.is_empty() || query.len() > 500 {
        return Err("Invalid search".into());
    }
    let offset = offset.unwrap_or(0);
    let data = get(
        &session,
        "Items",
        &[
            ("userId", session.user_id.clone()),
            ("searchTerm", query),
            ("includeItemTypes", "Audio".into()),
            ("recursive", "true".into()),
            ("limit", PAGE.to_string()),
            ("startIndex", offset.to_string()),
            ("fields", TRACK_FIELDS.into()),
        ],
    )
    .await?;
    Ok(page(&session, &data, offset).await)
}

/// The user's Jellyfin playlists.
#[tauri::command]
pub async fn jellyfin_playlists() -> Result<Value, String> {
    let session = session()?;
    let data = get(
        &session,
        "Items",
        &[
            ("userId", session.user_id.clone()),
            ("includeItemTypes", "Playlist".into()),
            ("recursive", "true".into()),
            ("limit", "200".into()),
            ("fields", "ChildCount".into()),
        ],
    )
    .await?;
    Ok(collection(&session, &data, 0, true))
}

/// Albums and playlists share one shape, so one grid renders both.
fn collection(session: &Session, data: &Value, offset: usize, playlist: bool) -> Value {
    let items: Vec<Value> = data["Items"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|item| {
            let id = item["Id"].as_str()?;
            let subtitle = artist_names(item)
                .iter()
                .filter_map(|artist| artist["name"].as_str().map(str::to_owned))
                .collect::<Vec<_>>()
                .join(", ");
            Some(json!({
                "id": id,
                "name": item["Name"].as_str()?,
                "kind": if playlist { "playlist" } else { "album" },
                "subtitle": subtitle,
                "trackCount": item["ChildCount"].as_u64().unwrap_or(0),
                "image": image_url(session, item),
            }))
        })
        .collect();
    let total = data["TotalRecordCount"]
        .as_u64()
        .unwrap_or((offset + items.len()) as u64);
    json!({
        "items": items,
        "total": total,
        "offset": offset,
        "hasMore": (offset + items.len()) < total as usize && !items.is_empty(),
    })
}

/// The account's music albums, newest first — the grid the user browses.
#[tauri::command]
pub async fn jellyfin_albums(offset: Option<usize>) -> Result<Value, String> {
    let session = session()?;
    let offset = offset.unwrap_or(0);
    let data = get(
        &session,
        "Items",
        &[
            ("userId", session.user_id.clone()),
            ("includeItemTypes", "MusicAlbum".into()),
            ("recursive", "true".into()),
            ("sortBy", "SortName".into()),
            ("sortOrder", "Ascending".into()),
            ("limit", PAGE.to_string()),
            ("startIndex", offset.to_string()),
            ("fields", "ChildCount".into()),
        ],
    )
    .await?;
    Ok(collection(&session, &data, offset, false))
}

/// An album's songs, in album order.
#[tauri::command]
pub async fn jellyfin_album_tracks(album_id: String) -> Result<Value, String> {
    let session = session()?;
    let data = get(
        &session,
        "Items",
        &[
            ("userId", session.user_id.clone()),
            ("parentId", album_id),
            ("includeItemTypes", "Audio".into()),
            ("sortBy", "ParentIndexNumber,IndexNumber,SortName".into()),
            ("limit", PAGE.to_string()),
            ("fields", TRACK_FIELDS.into()),
        ],
    )
    .await?;
    Ok(page(&session, &data, 0).await)
}

#[tauri::command]
pub async fn jellyfin_playlist_tracks(
    playlist_id: String,
    offset: Option<usize>,
) -> Result<Value, String> {
    let session = session()?;
    let offset = offset.unwrap_or(0);
    let data = get(
        &session,
        &format!("Playlists/{playlist_id}/Items"),
        &[
            ("userId", session.user_id.clone()),
            ("limit", PAGE.to_string()),
            ("startIndex", offset.to_string()),
            ("fields", TRACK_FIELDS.into()),
        ],
    )
    .await?;
    Ok(page(&session, &data, offset).await)
}

async fn page(session: &Session, data: &Value, offset: usize) -> Value {
    let mut tracks: Vec<Value> = data["Items"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|item| as_track(session, item))
        .collect();
    fill_from_albums(session, &mut tracks).await;
    for track in &mut tracks {
        label_gaps(track);
    }
    let total = data["TotalRecordCount"]
        .as_u64()
        .unwrap_or((offset + tracks.len()) as u64);
    json!({
        "tracks": tracks,
        "total": total,
        "offset": offset,
        "hasMore": (offset + tracks.len()) < total as usize && !tracks.is_empty(),
    })
}

/// The item's stream URL on the user's own server. It carries the access token
/// as a query parameter because the <audio> element cannot send headers.
#[tauri::command]
pub async fn jellyfin_stream_url(item_id: String) -> Result<String, String> {
    let session = session()?;
    if item_id.is_empty() || !item_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("Invalid Jellyfin track".into());
    }
    Ok(stream_url(&session, &item_id))
}

/// `universal` streams the file untouched when its container is one the webview
/// can play, and transcodes when it is not.
///
/// The protocol is http rather than hls: a file that does need transcoding
/// would otherwise come back as an .m3u8 playlist, which an <audio> element
/// cannot load at all.
fn stream_url(session: &Session, item_id: &str) -> String {
    format!(
        "{}/Audio/{item_id}/universal?UserId={}&DeviceId=orion-desktop&{}\
         &Container=mp3,aac,m4a,flac,webma,webm,wav,ogg,opus\
         &TranscodingContainer=mp3&TranscodingProtocol=http&AudioCodec=mp3\
         &MaxStreamingBitrate=320000&EnableRedirection=true",
        session.server,
        session.user_id,
        query_auth(session)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An .m3u8 playlist is not something an <audio> element can load: asking
    /// Jellyfin for hls is what made every song fail with NotSupportedError.
    #[test]
    fn the_stream_url_asks_for_a_progressive_stream_never_hls() {
        let url = stream_url(&test_session(), "abc123");
        assert!(url.starts_with("https://jelly.example.com/Audio/abc123/universal?"));
        assert!(url.contains("TranscodingProtocol=http"));
        assert!(!url.contains("TranscodingProtocol=hls"));
        assert!(!url.contains("TranscodingContainer=ts"));
        // The <audio> element cannot send headers, so the token rides along.
        assert!(url.contains("ApiKey=t0ken"));
        assert!(url.contains("api_key=t0ken"));
        // A line continuation that lost its backslash would leave spaces here.
        assert!(!url.contains(' '));
    }

    #[test]
    fn server_addresses_are_normalised() {
        assert_eq!(normalize_server("jelly.example.com").unwrap(), "https://jelly.example.com");
        assert_eq!(normalize_server("http://10.0.0.5:8096/").unwrap(), "http://10.0.0.5:8096");
        assert_eq!(
            normalize_server("https://example.com/jellyfin/").unwrap(),
            "https://example.com/jellyfin"
        );
    }

    #[test]
    fn non_http_addresses_are_refused() {
        for input in ["", "   ", "ftp://example.com", "file:///etc/passwd"] {
            assert!(normalize_server(input).is_err(), "{input:?} should be refused");
        }
    }

    fn test_session() -> Session {
        Session {
            server: "https://jelly.example.com".into(),
            token: "t0ken".into(),
            user_id: "user".into(),
            user_name: "Jonas".into(),
        }
    }

    #[test]
    fn an_audio_item_becomes_a_unified_track() {
        let item = json!({
            "Id": "abc123",
            "Name": "Song",
            "Artists": ["Artist One", "Artist Two"],
            "Album": "Album",
            "AlbumId": "album1",
            "RunTimeTicks": 1_800_000_000u64,
            "ImageTags": { "Primary": "tag" },
        });
        let track = as_track(&test_session(), &item).expect("track");
        assert_eq!(track["uri"], "jellyfin:track:abc123");
        assert_eq!(track["durationMs"], 180_000);
        assert_eq!(track["artists"][1]["name"], "Artist Two");
        assert!(track["album"]["images"][0]["url"]
            .as_str()
            .unwrap()
            .contains("/Items/abc123/Images/Primary"));
    }

    #[test]
    fn a_song_without_a_cover_falls_back_to_the_album() {
        let item = json!({
            "Id": "abc123",
            "Name": "Song",
            "AlbumId": "album1",
            "RunTimeTicks": 0,
            "AlbumPrimaryImageTag": "albumtag",
        });
        let mut track = as_track(&test_session(), &item).expect("track");
        assert!(track["album"]["images"][0]["url"]
            .as_str()
            .unwrap()
            .contains("/Items/album1/Images/Primary"));
        // as_track leaves the gap; only label_gaps writes a placeholder, and
        // only after the parent album was asked.
        assert!(track["artists"].as_array().unwrap().is_empty());
        assert!(needs_album(&track));
        label_gaps(&mut track);
        assert_eq!(track["artists"][0]["name"], "Unknown artist");
        assert_eq!(track["album"]["name"], "Jellyfin");
    }

    /// The real case from a live server: the songs carry no tags at all, but
    /// the album they sit in does.
    #[test]
    fn a_track_with_no_tags_wants_its_album_looked_up() {
        let item = json!({
            "Id": "abc123",
            "Name": "Butterfly",
            "Artists": [],
            "Album": Value::Null,
            "AlbumId": "71db0443429a2040c6e44c31d6e22e52",
            "RunTimeTicks": 1_110_000_000u64,
        });
        let track = as_track(&test_session(), &item).expect("track");
        assert!(needs_album(&track));
        assert_eq!(track["album"]["id"], "71db0443429a2040c6e44c31d6e22e52");

        // A fully tagged track must not cost a lookup.
        let tagged = json!({
            "Id": "def456",
            "Name": "Song",
            "Artists": ["Artist"],
            "Album": "Album",
            "AlbumId": "album1",
            "RunTimeTicks": 1,
            "ImageTags": { "Primary": "tag" },
        });
        assert!(!needs_album(&as_track(&test_session(), &tagged).expect("track")));
    }

    #[test]
    fn artists_fall_back_through_every_tag_jellyfin_offers() {
        let plain = json!({ "Artists": ["A", "B"] });
        assert_eq!(artist_names(&plain).len(), 2);

        // Files with no track artist still usually carry an album artist.
        let album_artists = json!({ "Artists": [], "AlbumArtists": [{ "Name": "Album Artist" }] });
        assert_eq!(artist_names(&album_artists)[0]["name"], "Album Artist");

        let bare = json!({ "AlbumArtist": "Only This" });
        assert_eq!(artist_names(&bare)[0]["name"], "Only This");

        // Blank tags must not become a credited artist named " ".
        assert!(artist_names(&json!({ "Artists": ["", "  "] })).is_empty());
        assert!(artist_names(&json!({})).is_empty());
    }

    #[test]
    fn items_with_an_unusable_id_are_dropped() {
        let item = json!({ "Id": "../../etc", "Name": "x", "RunTimeTicks": 1 });
        assert_eq!(as_track(&test_session(), &item), None);
    }
}
