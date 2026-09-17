import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import type { UnifiedTrack } from "../providers/types";

export type JellyfinStatus = {
  connected: boolean;
  server: string | null;
  userName: string | null;
};

export type JellyfinPage = {
  tracks: UnifiedTrack[];
  total: number;
  offset: number;
  hasMore: boolean;
};

export const JELLYFIN_STATUS_EVENT = "orion:jellyfin-status";

export function jellyfinStatus(): Promise<JellyfinStatus> {
  return invoke("jellyfin_status");
}

/** Signs in with the user's own Jellyfin username and password. */
export function jellyfinConnect(
  server: string,
  username: string,
  password: string
): Promise<JellyfinStatus> {
  return invoke<JellyfinStatus>("jellyfin_connect", { server, username, password }).then(announce);
}

/** Signs in with an API key from the Jellyfin dashboard instead. */
export function jellyfinConnectWithKey(
  server: string,
  username: string,
  apiKey: string
): Promise<JellyfinStatus> {
  return invoke<JellyfinStatus>("jellyfin_connect_with_key", { server, username, apiKey }).then(
    announce
  );
}

export function jellyfinDisconnect(): Promise<void> {
  return invoke<void>("jellyfin_disconnect").then(() => {
    announce({ connected: false, server: null, userName: null });
  });
}

export function searchJellyfin(query: string, offset = 0): Promise<JellyfinPage> {
  return invoke("search_jellyfin", { query, offset });
}

/** An album or a playlist, as the browse grid shows it. */
export type JellyfinCollection = {
  id: string;
  name: string;
  kind: "album" | "playlist";
  /** The album artists, already joined. Empty when the files carry no tags. */
  subtitle: string;
  trackCount: number;
  image: string;
};

export type JellyfinCollectionPage = {
  items: JellyfinCollection[];
  total: number;
  offset: number;
  hasMore: boolean;
};

export function jellyfinPlaylists(): Promise<JellyfinCollectionPage> {
  return invoke("jellyfin_playlists");
}

export function jellyfinAlbums(offset = 0): Promise<JellyfinCollectionPage> {
  return invoke("jellyfin_albums", { offset });
}

export function jellyfinPlaylistTracks(playlistId: string, offset = 0): Promise<JellyfinPage> {
  return invoke("jellyfin_playlist_tracks", { playlistId, offset });
}

export function jellyfinAlbumTracks(albumId: string): Promise<JellyfinPage> {
  return invoke("jellyfin_album_tracks", { albumId });
}

/** The songs of an album or a playlist, whichever it is. */
export function jellyfinCollectionTracks(collection: JellyfinCollection): Promise<JellyfinPage> {
  return collection.kind === "album"
    ? jellyfinAlbumTracks(collection.id)
    : jellyfinPlaylistTracks(collection.id);
}

/** The item's URL on the user's own server, for the <audio> element. */
export function jellyfinStreamUrl(itemId: string): Promise<string> {
  return invoke("jellyfin_stream_url", { itemId });
}

// Connecting happens in Settings while the search may be open in another view,
// and there is no Rust-side event for it: the window tells itself.
function announce(status: JellyfinStatus): JellyfinStatus {
  window.dispatchEvent(new CustomEvent(JELLYFIN_STATUS_EVENT, { detail: status }));
  return status;
}

export function useJellyfinStatus() {
  const [status, setStatus] = useState<JellyfinStatus>({
    connected: false,
    server: null,
    userName: null,
  });
  const refresh = useCallback(() => {
    void jellyfinStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const onChange = (event: Event) => setStatus((event as CustomEvent<JellyfinStatus>).detail);
    window.addEventListener(JELLYFIN_STATUS_EVENT, onChange);
    return () => window.removeEventListener(JELLYFIN_STATUS_EVENT, onChange);
  }, [refresh]);
  return status;
}
