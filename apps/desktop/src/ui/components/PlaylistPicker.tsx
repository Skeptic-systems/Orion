import { Plus, SpinnerGap, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { addTrackToPlaylist, fetchAllPlaylists } from "../../lib/localLibrary";
import { isSelfPlayed, type UnifiedPlaylist, type UnifiedTrack } from "../../providers/types";
import ProviderBadge from "./ProviderBadge";

export default function PlaylistPicker({
  track,
  onClose,
}: {
  track: UnifiedTrack;
  onClose: () => void;
}) {
  const local = isSelfPlayed(track.provider);
  const dialog = useRef<HTMLDialogElement>(null);
  const [playlists, setPlaylists] = useState<UnifiedPlaylist[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    let alive = true;
    // A self-played track only lands in Orion's local copy of the playlist, so
    // any playlist can take it — writability only matters to Spotify.
    fetchAllPlaylists()
      .then((all) => {
        if (alive) setPlaylists(all.filter((p) => local || p.writable));
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [local]);
  async function add(playlist: UnifiedPlaylist) {
    if (busy) return;
    setBusy(playlist.id);
    setError(null);
    try {
      await addTrackToPlaylist(track, playlist.id);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: only catches backdrop clicks; Escape closes it through onCancel
    <dialog
      ref={dialog}
      className="library-dialog"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="library-dialog-header">
        <div>
          <h2>Add to playlist</h2>
          <p>{track.name}</p>
          {local && <p>Saved in Orion only, not synced to Spotify</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" title="Close">
          <X size={20} />
        </button>
      </div>
      {error && (
        <p className="library-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <SpinnerGap className="animate-spin" size={24} />
      ) : playlists.length === 0 ? (
        <p>No available playlists</p>
      ) : (
        <div className="library-picker-list">
          {playlists.map((p) => (
            <button type="button" key={p.id} onClick={() => void add(p)} disabled={busy !== null}>
              {p.images[0]?.url && <img src={p.images[0].url} alt="" />}
              <span>{p.name}</span>
              {busy === p.id ? (
                <SpinnerGap className="animate-spin" size={18} />
              ) : local ? (
                <ProviderBadge provider={track.provider} size={18} />
              ) : (
                <Plus size={18} />
              )}
            </button>
          ))}
        </div>
      )}
    </dialog>
  );
}
