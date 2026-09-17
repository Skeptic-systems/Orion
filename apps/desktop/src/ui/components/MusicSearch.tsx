import {
  ClockCounterClockwise,
  HardDrives,
  MagnifyingGlass,
  SoundcloudLogo,
  SpinnerGap,
  SpotifyLogo,
  X,
  YoutubeLogo,
} from "@phosphor-icons/react";
import { memo, useEffect, useRef, useState } from "react";
import { searchJellyfin, useJellyfinStatus } from "../../lib/jellyfin";
import { playbackCommand } from "../../lib/playback/session";
import { searchSoundCloud } from "../../lib/soundcloud";
import { prefetchAudio, searchYouTube, useYouTubeConnection } from "../../lib/youtube";
import { createSpotifyProvider } from "../../providers/spotify";
import {
  type MusicProviderType,
  PROVIDER_NAMES,
  resolverRef,
  type UnifiedTrack,
} from "../../providers/types";
import JellyfinBrowse from "./JellyfinBrowse";
import LibraryTrackList from "./LibraryTrackList";

type Props = {
  initialQuery?: string;
  history?: string[];
  onRemember?: (query: string) => void;
  onForget?: (query: string) => void;
};

/** Results whose audio starts loading as soon as a search returns. */
const PREFETCH_RESULTS = 5;

const SOURCES = [
  { type: "spotify", Icon: SpotifyLogo },
  { type: "youtube", Icon: YoutubeLogo },
  { type: "soundcloud", Icon: SoundcloudLogo },
  { type: "jellyfin", Icon: HardDrives },
] as const satisfies readonly { type: MusicProviderType; Icon: unknown }[];

/**
 * A page of results, plus whatever the provider needs to fetch the next one.
 * Spotify answers in one page; YouTube pages by continuation token, SoundCloud
 * and Jellyfin by offset.
 */
type Page = { tracks: UnifiedTrack[]; cursor: string | number | null };

function searchPage(
  source: MusicProviderType,
  query: string,
  cursor: string | number | null
): Promise<Page> {
  switch (source) {
    case "youtube":
      return searchYouTube(query, typeof cursor === "string" ? cursor : null).then((result) => ({
        tracks: result.tracks,
        cursor: result.continuation,
      }));
    case "soundcloud": {
      const page = typeof cursor === "number" ? cursor : 0;
      return searchSoundCloud(query, page).then((result) => ({
        tracks: result.tracks,
        cursor: result.hasMore ? page + 1 : null,
      }));
    }
    case "jellyfin": {
      const offset = typeof cursor === "number" ? cursor : 0;
      return searchJellyfin(query, offset).then((result) => ({
        tracks: result.tracks,
        cursor: result.hasMore ? offset + result.tracks.length : null,
      }));
    }
    case "spotify":
      return createSpotifyProvider()
        .searchTracks(query, 30)
        .then((tracks) => ({ tracks, cursor: null }));
  }
}

function sourceHint(
  source: MusicProviderType,
  state: { youtubeConnected: boolean; jellyfin: boolean }
): string {
  if (source === "youtube" && !state.youtubeConnected) {
    return "Searching as a guest. Sign in under Settings → Connections for higher rates.";
  }
  if (source === "soundcloud") {
    return "Searching as a guest. Sign in under Settings → Connections for Go+ and private tracks.";
  }
  if (source === "jellyfin" && !state.jellyfin) {
    return "Connect your Jellyfin server under Settings → Connections";
  }
  return PROVIDER_NAMES[source];
}

// Memoised: the shell re-renders with every playback report.
export default memo(MusicSearch);

function MusicSearch({ initialQuery = "", history = [], onRemember, onForget }: Props) {
  const youtubeConnected = useYouTubeConnection();
  const jellyfin = useJellyfinStatus();
  const [source, setSource] = useState<MusicProviderType>("spotify");
  const [query, setQuery] = useState(initialQuery);
  const [tracks, setTracks] = useState<UnifiedTrack[]>([]);
  const [cursor, setCursor] = useState<string | number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  // With nothing typed, Jellyfin shows the library itself rather than the
  // recent searches: it is the one source the user browses by cover.
  const browsingJellyfin = source === "jellyfin" && !query.trim();
  const showHistory = !browsingJellyfin && !query.trim() && history.length > 0;
  // Jellyfin is the one source that needs setting up before it can answer.
  useEffect(() => {
    if (source === "jellyfin" && !jellyfin.connected) setSource("spotify");
  }, [source, jellyfin.connected]);
  useEffect(() => {
    const run = ++revision.current;
    setTracks([]);
    setCursor(null);
    setError(null);
    setLoading(false);
    if (!query.trim()) return;
    const timer = setTimeout(() => {
      setLoading(true);
      void searchPage(source, query.trim(), null)
        .then((result) => {
          if (run === revision.current) {
            setTracks(result.tracks);
            setCursor(result.cursor);
            // The top hits are the likeliest clicks; their audio starts loading now.
            prefetchAudio(
              result.tracks
                .slice(0, PREFETCH_RESULTS)
                .map(resolverRef)
                .filter((ref): ref is string => ref !== null)
            );
          }
        })
        .catch((e) => {
          if (run === revision.current) setError(String(e));
        })
        .finally(() => {
          if (run === revision.current) setLoading(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      revision.current++;
    };
  }, [query, source]);
  async function more() {
    if (cursor === null || loading) return;
    const run = revision.current;
    setLoading(true);
    try {
      const result = await searchPage(source, query.trim(), cursor);
      if (run === revision.current) {
        setTracks((old) => [
          ...old,
          ...result.tracks.filter((t) => !old.some((o) => o.uri === t.uri)),
        ]);
        setCursor(result.cursor);
      }
    } catch (e) {
      if (run === revision.current) setError(String(e));
    } finally {
      if (run === revision.current) setLoading(false);
    }
  }
  return (
    <section className="library-search">
      <div className="library-search-toolbar">
        <fieldset className="library-source-tabs" aria-label="Search source">
          {SOURCES.map(({ type, Icon }) => (
            <button
              key={type}
              type="button"
              className={`is-${type}`}
              aria-pressed={source === type}
              // Only Jellyfin can be unavailable: the others all search as a guest.
              disabled={type === "jellyfin" && !jellyfin.connected}
              title={sourceHint(type, { youtubeConnected, jellyfin: jellyfin.connected })}
              onClick={() => setSource(type)}
            >
              <Icon size={18} />
              {PROVIDER_NAMES[type]}
            </button>
          ))}
        </fieldset>
        <label className="library-search-input">
          <MagnifyingGlass size={20} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRemember?.(query);
            }}
            placeholder="Search"
            aria-label={`Search ${PROVIDER_NAMES[source]}`}
          />
          {loading && <SpinnerGap size={18} className="animate-spin" />}
        </label>
      </div>
      {error && (
        <p role="alert" className="library-error">
          {error}
        </p>
      )}
      {browsingJellyfin ? (
        <JellyfinBrowse />
      ) : showHistory ? (
        <div className="desktop-search-history">
          <div className="desktop-section-heading">
            <h2>Recent searches</h2>
          </div>
          <ul>
            {history.map((term) => (
              <li key={term}>
                <button type="button" onClick={() => setQuery(term)}>
                  <ClockCounterClockwise size={16} weight="bold" />
                  <span>{term}</span>
                </button>
                {onForget && (
                  <button
                    type="button"
                    className="desktop-search-history-remove"
                    onClick={() => onForget(term)}
                    aria-label={`Remove ${term} from recent searches`}
                  >
                    <X size={14} weight="bold" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <LibraryTrackList
            tracks={tracks}
            showAdd
            onSearch={setQuery}
            onPlay={(track) => {
              onRemember?.(query);
              void playbackCommand({ action: "track", track }).catch((e) => setError(String(e)));
            }}
          />
          {!loading && !tracks.length && (
            <p className="library-empty">{query.trim() ? "No results" : "Search music"}</p>
          )}
          {cursor !== null && (
            <button
              type="button"
              className="library-load-more"
              disabled={loading}
              onClick={() => void more()}
            >
              Load more
            </button>
          )}
        </>
      )}
    </section>
  );
}
