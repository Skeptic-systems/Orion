export type MusicProviderType = "spotify" | "youtube" | "soundcloud" | "jellyfin";

/**
 * Providers Orion plays itself, through its own <audio> element, rather than
 * handing the track to Spotify. They share one code path in `session.ts`, one
 * local-playlist store, and one rule: when their material runs out, the
 * Spotify radio continues from there.
 */
export const SELF_PLAYED_PROVIDERS = ["youtube", "soundcloud", "jellyfin"] as const;

export type SelfPlayedProvider = (typeof SELF_PLAYED_PROVIDERS)[number];

export function isSelfPlayed(provider: MusicProviderType): provider is SelfPlayedProvider {
  return (SELF_PLAYED_PROVIDERS as readonly string[]).includes(provider);
}

/** What each provider calls itself in the interface. */
export const PROVIDER_NAMES: Record<MusicProviderType, string> = {
  spotify: "Spotify",
  youtube: "YouTube",
  soundcloud: "SoundCloud",
  jellyfin: "Jellyfin",
};

export interface UnifiedArtist {
  id: string;
  name: string;
}

export interface UnifiedAlbumImage {
  url: string;
  height: number;
  width: number;
}

export interface UnifiedAlbum {
  id: string;
  name: string;
  images: UnifiedAlbumImage[];
}

export interface UnifiedTrack {
  playlistKey?: string;
  id: string;
  name: string;
  durationMs: number;
  artists: UnifiedArtist[];
  album: UnifiedAlbum;
  uri: string;
  provider: MusicProviderType;
}

export interface PlaybackState {
  isPlaying: boolean;
  progressMs: number;
  track: UnifiedTrack | null;
}

export interface SearchResult {
  tracks: UnifiedTrack[];
  total: number;
}

export interface UnifiedPlaylistOwner {
  id: string;
  name: string;
}

export interface UnifiedPlaylist {
  writable?: boolean;
  id: string;
  name: string;
  description: string | null;
  images: UnifiedAlbumImage[];
  trackCount: number;
  owner: UnifiedPlaylistOwner;
}

export interface PlaylistsResult {
  playlists: UnifiedPlaylist[];
  total: number;
  currentUserId?: string;
}

export interface PlaylistTracksResult {
  tracks: UnifiedTrack[];
  total: number;
}

export interface ProviderCapabilities {
  hasPlaylists: boolean;
  hasQueue: boolean;
  hasExternalPlayback: boolean;
  hasLikedSongs: boolean;
  /** Provider exposes other playback targets the user can switch between. */
  hasConnectDevices: boolean;
}

export interface UnifiedUserProfile {
  id: string;
  name: string;
  imageUrl: string | null;
  provider: MusicProviderType;
  subtitle?: string;
}

export interface MusicProvider {
  readonly type: MusicProviderType;

  isAuthenticated(): Promise<boolean>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  getCurrentTrack(): Promise<UnifiedTrack | null>;
  getPlaybackState(): Promise<PlaybackState | null>;
  getUserProfile(): Promise<UnifiedUserProfile>;

  play(): Promise<void>;
  pause(): Promise<void>;
  nextTrack(): Promise<void>;
  previousTrack(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setVolume(volumePercent: number): Promise<void>;

  searchTracks(query: string, limit: number): Promise<UnifiedTrack[]>;
  playTrack(uri: string, startPositionMs?: number): Promise<void>;
  addToQueue(uri: string): Promise<void>;

  getRecentlyPlayed(limit: number): Promise<UnifiedTrack[]>;

  getCapabilities(): ProviderCapabilities;
  getUserPlaylists(limit: number, offset: number): Promise<PlaylistsResult>;
  getPlaylistTracks(
    playlistId: string,
    limit: number,
    offset: number
  ): Promise<PlaylistTracksResult>;
  addToPlaylist(playlistId: string, trackUri: string): Promise<void>;
  playPlaylistFromIndex?(playlistId: string, trackIndex: number, trackUri?: string): Promise<void>;
}

export interface ProviderAuthState {
  isAuthenticated: boolean;
  isConnecting: boolean;
  error: string | null;
}

export function createUri(provider: MusicProviderType, id: string): string {
  switch (provider) {
    case "spotify":
      return `spotify:track:${id}`;
    case "youtube":
      return `youtube:video:${id}`;
    case "soundcloud":
      return `soundcloud:track:${id}`;
    case "jellyfin":
      return `jellyfin:track:${id}`;
  }
}

/**
 * The id shapes are checked here and again in Rust: a SoundCloud id is the
 * permalink path, a Jellyfin id the server's item id, and neither may carry a
 * slash, a scheme or a query that could address something other than a track.
 */
export function parseUri(uri: string): { provider: MusicProviderType; id: string } | null {
  if (/^youtube:video:[\w-]{11}$/.test(uri)) return { provider: "youtube", id: uri.slice(14) };
  if (/^soundcloud:track:[\w-]+\/[\w-]+$/.test(uri)) {
    return { provider: "soundcloud", id: uri.slice(17) };
  }
  if (/^jellyfin:track:[\w-]+$/.test(uri)) return { provider: "jellyfin", id: uri.slice(15) };
  if (uri.startsWith("spotify:track:")) {
    return { provider: "spotify", id: uri.replace("spotify:track:", "") };
  }
  return null;
}

/**
 * How the Rust resolver refers to a track: `"<source>:<id>"`. Jellyfin is not
 * in there — its server hands out a stream URL directly.
 */
export function resolverRef(track: { provider: MusicProviderType; id: string }): string | null {
  return track.provider === "youtube" || track.provider === "soundcloud"
    ? `${track.provider}:${track.id}`
    : null;
}

export function getProviderFromUri(uri: string): MusicProviderType | null {
  const parsed = parseUri(uri);
  return parsed?.provider ?? null;
}
