import { ArrowLeft, MusicNotes, Play, SpinnerGap } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import {
  type JellyfinCollection,
  jellyfinAlbums,
  jellyfinCollectionTracks,
  jellyfinPlaylists,
} from "../../lib/jellyfin";
import { playbackCommand } from "../../lib/playback/session";
import type { UnifiedTrack } from "../../providers/types";
import LibraryTrackList from "./LibraryTrackList";

type Tab = "albums" | "playlists";

/**
 * The Jellyfin library, browsed rather than searched: a grid of albums and
 * playlists, and the songs of whichever one is open. It takes the place of the
 * recent-search list while the Jellyfin tab has an empty query.
 */
export default function JellyfinBrowse() {
  const [tab, setTab] = useState<Tab>("albums");
  const [items, setItems] = useState<JellyfinCollection[]>([]);
  const [open, setOpen] = useState<JellyfinCollection | null>(null);
  const [tracks, setTracks] = useState<UnifiedTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const load = tab === "albums" ? jellyfinAlbums() : jellyfinPlaylists();
    load
      .then((page) => {
        if (alive) setItems(page.items);
      })
      .catch((err) => {
        if (alive) setError(String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tab]);

  // Opening a collection replaces the grid with its songs.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setTracks([]);
    jellyfinCollectionTracks(open)
      .then((page) => {
        if (alive) setTracks(page.tracks);
      })
      .catch((err) => {
        if (alive) setError(String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const play = useCallback((track: UnifiedTrack) => {
    void playbackCommand({ action: "track", track }).catch((err) => setError(String(err)));
  }, []);

  return (
    <section className="jellyfin-browse">
      {error && (
        <p role="alert" className="library-error">
          {error}
        </p>
      )}

      {open ? (
        <>
          <div className="jellyfin-browse-header">
            <button
              type="button"
              className="desktop-back-button"
              onClick={() => setOpen(null)}
              aria-label="Back to library"
            >
              <ArrowLeft size={18} weight="bold" />
            </button>
            {open.image ? <img src={open.image} alt="" /> : <MusicNotes size={26} />}
            <div>
              <h2>{open.name}</h2>
              <p>{open.subtitle || `${open.trackCount} tracks`}</p>
            </div>
            <button
              type="button"
              className="desktop-play-button"
              disabled={tracks.length === 0}
              onClick={() => tracks[0] && play(tracks[0])}
              aria-label={`Play ${open.name}`}
            >
              <Play size={18} weight="fill" />
            </button>
          </div>
          <LibraryTrackList tracks={tracks} showAdd onPlay={play} />
          {!loading && tracks.length === 0 && <p className="library-empty">No songs here</p>}
        </>
      ) : (
        <>
          <fieldset className="library-source-tabs" aria-label="Jellyfin library">
            {(["albums", "playlists"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={tab === option}
                onClick={() => setTab(option)}
              >
                {option === "albums" ? "Albums" : "Playlists"}
              </button>
            ))}
          </fieldset>
          {/* The playlist grid the rest of the app uses, so every skin already
              knows how to draw these cards. */}
          <div className="desktop-playlist-grid">
            {items.map((item) => (
              <button key={item.id} type="button" onClick={() => setOpen(item)}>
                <div>
                  {item.image ? (
                    <img src={item.image} alt="" loading="lazy" />
                  ) : (
                    <MusicNotes size={42} />
                  )}
                </div>
                <strong>{item.name}</strong>
                <small>{item.subtitle || `${item.trackCount} tracks`}</small>
              </button>
            ))}
          </div>
          {!loading && items.length === 0 && (
            <p className="library-empty">
              {tab === "albums" ? "No albums on your server" : "No playlists on your server"}
            </p>
          )}
        </>
      )}

      {loading && <SpinnerGap size={22} className="animate-spin" />}
    </section>
  );
}
