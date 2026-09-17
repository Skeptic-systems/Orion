import {
  ArrowLineDown,
  ArrowLineUp,
  ArrowSquareOut,
  Copy,
  DotsSixVertical,
  DotsThree,
  Heart,
  ListPlus,
  MagnifyingGlass,
  Play,
  Plus,
  Queue,
  Trash,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { usePlaybackSession } from "../../lib/playback/sessionStore";
import { prefetchAudio } from "../../lib/youtube";
import { PROVIDER_NAMES, resolverRef, type UnifiedTrack } from "../../providers/types";
import { addToQueue, saveTrackToLibrary } from "../spotifyClient";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import PlaylistPicker from "./PlaylistPicker";
import ProviderBadge, { trackUrl } from "./ProviderBadge";
import { useTrackRows } from "./useTrackRows";

/** Dwell on a YouTube row before its audio starts loading in the background. */
const PREFETCH_DELAY_MS = 80;
const NOTICE_MS = 2200;

type Props = {
  tracks: UnifiedTrack[];
  /** Stable row identities, for lists that can hold the same song twice. */
  keys?: string[];
  currentKey?: string | null;
  disabled?: boolean;
  /** An add-to-playlist button on every row; the menu offers it either way. */
  showAdd?: boolean;
  onPlay: (track: UnifiedTrack, index: number) => void;
  /** Turns on drag-and-drop reordering. */
  onReorder?: (from: number, to: number) => void;
  onRemove?: (index: number) => void;
  canRemove?: (track: UnifiedTrack) => boolean;
  onSearch?: (query: string) => void;
};

type OpenMenu = { index: number; x: number; y: number };

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function LibraryTrackList({
  tracks,
  keys,
  currentKey,
  disabled = false,
  showAdd = false,
  onPlay,
  onReorder,
  onRemove,
  canRemove,
  onSearch,
}: Props) {
  const [adding, setAdding] = useState<UnifiedTrack | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const prefetchTimer = useRef<number | undefined>(undefined);
  const sortable = Boolean(onReorder) && !disabled;
  const { listRef, indices, drag, rowStyle, listHeight, onPointerDown, onClickCapture } =
    useTrackRows(tracks.length, sortable ? onReorder : undefined);
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(
    () => () => {
      window.clearTimeout(noticeTimer.current);
      window.clearTimeout(prefetchTimer.current);
    },
    []
  );

  const flash = (message: string) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  };

  const run = (task: Promise<unknown>, done?: string) => {
    task.then(
      () => {
        if (done) flash(done);
      },
      (error) => flash(describe(error))
    );
  };

  const openMenuAtPointer = (event: MouseEvent, index: number) => {
    event.preventDefault();
    setMenu({ index, x: event.clientX, y: event.clientY });
  };

  const openMenuAtButton = (button: HTMLElement, index: number) => {
    const box = button.getBoundingClientRect();
    setMenu({ index, x: box.left, y: box.bottom + 4 });
  };

  const menuItems = (track: UnifiedTrack, index: number): MenuItem[] => {
    const spotify = track.provider === "spotify";
    const artist = track.artists[0]?.name;
    const playing: MenuItem[] = [
      {
        label: "Play",
        icon: <Play size={16} weight="fill" />,
        onSelect: () => onPlay(track, index),
      },
    ];
    // A playlist Orion plays itself ignores Spotify's queue.
    if (spotify && !usePlaybackSession.getState().local) {
      playing.push({
        label: "Add to queue",
        icon: <Queue size={16} />,
        onSelect: () => run(addToQueue(track.uri), "Added to queue"),
      });
    }
    const library: MenuItem[] = [
      { label: "Add to playlist…", icon: <ListPlus size={16} />, onSelect: () => setAdding(track) },
    ];
    if (spotify) {
      library.push({
        label: "Save to Liked Songs",
        icon: <Heart size={16} />,
        onSelect: () => run(saveTrackToLibrary(track.id), "Saved to Liked Songs"),
      });
    }
    const arranging: MenuItem[] = [];
    if (onReorder && tracks.length > 1) {
      arranging.push(
        {
          label: "Move to top",
          icon: <ArrowLineUp size={16} />,
          disabled: disabled || index === 0,
          onSelect: () => onReorder(index, 0),
        },
        {
          label: "Move to bottom",
          icon: <ArrowLineDown size={16} />,
          disabled: disabled || index === tracks.length - 1,
          onSelect: () => onReorder(index, tracks.length - 1),
        }
      );
    }
    if (onRemove && canRemove?.(track)) {
      arranging.push({
        label: "Remove from this playlist",
        icon: <Trash size={16} />,
        danger: true,
        disabled,
        onSelect: () => onRemove(index),
      });
    }
    const elsewhere: MenuItem[] = [];
    if (onSearch && artist) {
      elsewhere.push({
        label: `Search “${artist}”`,
        icon: <MagnifyingGlass size={16} />,
        onSelect: () => onSearch(artist),
      });
    }
    // A Jellyfin track only exists on the user's own server: there is no page
    // to open and no link worth copying.
    const url = trackUrl(track);
    if (url) {
      elsewhere.push(
        {
          label: `Open in ${PROVIDER_NAMES[track.provider]}`,
          icon: <ArrowSquareOut size={16} />,
          onSelect: () => run(openUrl(url)),
        },
        {
          label: "Copy link",
          icon: <Copy size={16} />,
          onSelect: () => run(navigator.clipboard.writeText(url), "Link copied"),
        }
      );
    }
    return [playing, library, arranging, elsewhere]
      .filter((section) => section.length > 0)
      .flatMap((section, position): MenuItem[] =>
        position === 0 ? section : ["separator", ...section]
      );
  };

  const menuTrack = menu ? tracks[menu.index] : undefined;

  return (
    <>
      <ol
        ref={listRef}
        className={`library-tracks${sortable ? " is-sortable" : ""}${drag ? " is-sorting" : ""}`}
        style={{ height: listHeight }}
        onClickCapture={onClickCapture}
        onDragStart={(event) => event.preventDefault()}
      >
        {indices.map((index) => {
          const track = tracks[index];
          const key = keys?.[index] ?? track.uri;
          // Only the self-played providers resolve a stream ahead of a click.
          const ref = resolverRef(track);
          const classes = [
            currentKey && key === currentKey ? "is-current" : "",
            menu?.index === index ? "has-menu" : "",
            drag?.from === index ? "is-dragging" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li
              key={key}
              className={classes || undefined}
              style={rowStyle(index)}
              data-row={index}
              aria-posinset={index + 1}
              aria-setsize={tracks.length}
              onPointerDown={(event) => {
                // The press starts the load; the click only follows a moment later.
                if (ref && event.button === 0) prefetchAudio(ref);
                if (sortable) onPointerDown(event, index);
              }}
              onContextMenu={(event) => openMenuAtPointer(event, index)}
              onPointerEnter={
                ref
                  ? () => {
                      window.clearTimeout(prefetchTimer.current);
                      prefetchTimer.current = window.setTimeout(
                        () => prefetchAudio(ref),
                        PREFETCH_DELAY_MS
                      );
                    }
                  : undefined
              }
              onPointerLeave={ref ? () => window.clearTimeout(prefetchTimer.current) : undefined}
            >
              {sortable && (
                <span className="library-grip" aria-hidden="true">
                  <DotsSixVertical size={16} weight="bold" />
                </span>
              )}
              <button
                type="button"
                className="library-track-play"
                onClick={() => onPlay(track, index)}
                disabled={disabled}
              >
                <span className="library-art">
                  {track.album.images[0]?.url ? (
                    <img src={track.album.images[0].url} alt="" loading="lazy" draggable={false} />
                  ) : (
                    <Play size={20} />
                  )}
                </span>
                <span className="library-track-name">
                  <strong>{track.name}</strong>
                  <small>{track.artists.map((a) => a.name).join(", ")}</small>
                </span>
              </button>
              <ProviderBadge provider={track.provider} />
              <span className="library-duration">{formatDuration(track.durationMs)}</span>
              {showAdd && (
                <button
                  type="button"
                  data-no-drag
                  onClick={() => setAdding(track)}
                  aria-label={`Add ${track.name} to playlist`}
                  title="Add to playlist"
                >
                  <Plus size={18} />
                </button>
              )}
              <button
                type="button"
                className="library-more"
                data-no-drag
                aria-haspopup="menu"
                aria-label={`More options for ${track.name}`}
                title="More options"
                onClick={(event) => openMenuAtButton(event.currentTarget, index)}
              >
                <DotsThree size={20} weight="bold" />
              </button>
            </li>
          );
        })}
      </ol>
      {menu && menuTrack && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Options for ${menuTrack.name}`}
          items={menuItems(menuTrack, menu.index)}
          onClose={closeMenu}
        />
      )}
      {adding && <PlaylistPicker track={adding} onClose={() => setAdding(null)} />}
      {notice && <output className="library-toast">{notice}</output>}
    </>
  );
}
