import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertToUnifiedTrack, createSpotifyProvider } from "../../providers/spotify";
import { isSelfPlayed, resolverRef, type UnifiedTrack } from "../../providers/types";
import { fetchCurrentlyPlaying, transferPlayback } from "../../ui/spotifyClient";
import { stopAIQueue } from "../aiQueueService";
import { jellyfinStreamUrl } from "../jellyfin";
import type { LocalPlaylist, PlaylistChange, PlaylistEntry } from "../localLibrary";
import { toOutputVolume } from "../outputVolume";
import { readSettings } from "../settingLib";
import {
  activateSpotifyWebPlayback,
  getSpotifyLocalPlayback,
  isSpotifyWebPlaybackReady,
  subscribeSpotifyLocalPlayback,
} from "../spotifyWebPlayback";
import { getSpotifyWebPlaybackDeviceId } from "../spotifyWebPlaybackDevice";
import { prefetchAudio } from "../youtube";
import { type PlaybackSession, usePlaybackSession } from "./sessionStore";
import { continueWithRadio, skipToNext } from "./spotifyAutoplay";

export type PlaybackCommand =
  | { action: "track"; track: UnifiedTrack; positionMs?: number }
  | { action: "playlist"; playlist: LocalPlaylist; entryId: string; shuffle?: boolean }
  | { action: "playing"; playing: boolean }
  | { action: "seek"; positionMs: number }
  | { action: "volume"; volume: number }
  | { action: "shuffle"; enabled: boolean }
  | { action: "next" | "previous" | "state" | "stop" };

type AudioStream = { streamId: string | null; url: string };
type SpotifyProgress = {
  positionMs: number;
  durationMs: number;
  playing: boolean;
  sampledAt: number;
};

const MAIN = getCurrentWindow().label === "main";
/** Commands that replace whatever is playing or still loading. */
const SUPERSEDING = new Set<PlaybackCommand["action"]>([
  "track",
  "playlist",
  "stop",
  "next",
  "previous",
]);
let initialized: Promise<void> | null = null;
let audio: HTMLAudioElement | null = null;
/**
 * The registered stream to hand back when the song ends. Jellyfin plays from
 * its own server with nothing registered, so `playingLocally` — not this — is
 * what says whether the audio element is the one making sound.
 */
let streamId: string | null = null;
let playingLocally = false;
let serial = Promise.resolve();
let generation = 0;
/**
 * Ends the wait on YouTube's resolver once a newer command takes over. Every
 * later command used to queue behind a slow resolve, which looked like a hang.
 */
let supersede: (() => void) | null = null;
let history: string[] = [];
let heard = new Set<string>();
/** The shuffle pick for "next", chosen early so its audio can load ahead. */
let planned: string | null = null;
let ended = false;
let retry = false;
/** The last reading of the Spotify song playing, to tell its end from a pause. */
let spotifyProgress: SpotifyProgress | null = null;
const state = () => usePlaybackSession.getState();
/** Narrow helper: a track Orion streams through its own audio element. */
const selfPlayed = (track: UnifiedTrack | null | undefined): track is UnifiedTrack =>
  !!track && isSelfPlayed(track.provider);
const spotify = createSpotifyProvider();

/** How often a routine position update reaches the store and the other windows. */
const PROGRESS_EVERY_MS = 1000;
/** How close to its end a Spotify song must have got for a stop to mean "finished". */
const END_SLACK_MS = 2500;
/** Without the SDK, Spotify says nothing when a song ends; it is asked this often. */
const REMOTE_POLL_MS = 2500;
let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
let lastBroadcast = 0;

function broadcast() {
  broadcastTimer = undefined;
  lastBroadcast = performance.now();
  // Without the playlist: it can hold thousands of songs, and sending all of
  // it to every window on every tick jammed the webview transport.
  const { playlist: _playlist, ...light } = state();
  void emit("playback-session-state", light);
}

/** `progress` marks a routine position update, which other windows get batched. */
function publish(update: Partial<PlaybackSession>, progress = false) {
  usePlaybackSession.setState(update);
  if (!MAIN) return;
  if (!progress) {
    clearTimeout(broadcastTimer);
    broadcast();
  } else if (broadcastTimer === undefined) {
    const wait = Math.max(0, PROGRESS_EVERY_MS - (performance.now() - lastBroadcast));
    broadcastTimer = setTimeout(broadcast, wait);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function takeOver() {
  generation++;
  supersede?.();
  supersede = null;
}

async function releaseAudio() {
  playingLocally = false;
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  const id = streamId;
  streamId = null;
  if (id) void invoke("release_audio", { streamId: id }).catch(() => {});
}

async function pauseSpotify() {
  const current = await spotify.getPlaybackState().catch(() => null);
  if (current?.isPlaying) await spotify.pause().catch(() => {});
}

/** The entry "next" would play: in order, or the shuffle pick made ahead of time. */
function upcoming(): PlaylistEntry | undefined {
  const current = state();
  const entries = current.playlist?.entries ?? [];
  if (!current.local || entries.length === 0) return undefined;
  if (!current.shuffle) {
    return entries[entries.findIndex((entry) => entry.entryId === current.entryId) + 1];
  }
  const usable = (id: string | null) =>
    id !== null &&
    id !== current.entryId &&
    !heard.has(id) &&
    entries.some((entry) => entry.entryId === id);
  if (!usable(planned)) {
    const options = entries.filter(
      (entry) => entry.entryId !== current.entryId && !heard.has(entry.entryId)
    );
    planned = options[Math.floor(Math.random() * options.length)]?.entryId ?? null;
  }
  return entries.find((entry) => entry.entryId === planned);
}

function prefetchUpcoming() {
  const next = upcoming();
  const ref = next && resolverRef(next.track);
  if (ref) prefetchAudio(ref);
}

/**
 * A playable URL for a track Orion streams itself.
 *
 * YouTube and SoundCloud go through the Rust resolver and its loopback proxy,
 * which hands back a `streamId` to release afterwards. Jellyfin is the user's
 * own server: it answers with a stable URL the webview fetches directly, so
 * there is nothing to register and nothing to release.
 */
async function localStream(
  track: UnifiedTrack,
  fresh: boolean
): Promise<{ streamId: string | null; url: string }> {
  const ref = resolverRef(track);
  if (ref) return invoke<AudioStream>("resolve_audio", { track: ref, fresh });
  if (track.provider === "jellyfin") {
    return { streamId: null, url: await jellyfinStreamUrl(track.id) };
  }
  throw new Error(`Orion cannot play ${track.provider} tracks`);
}

async function playEntry(track: UnifiedTrack, positionMs = 0, fresh = false) {
  const run = generation;
  spotifyProgress = null;
  publish({
    loading: true,
    error: null,
    playback: { track, progressMs: positionMs, isPlaying: false },
  });
  ended = false;
  retry = false;
  try {
    await releaseAudio();
    if (isSelfPlayed(track.provider)) {
      const player = audio;
      if (!player) throw new Error("The player is not ready yet");
      const superseded = new Promise<null>((resolve) => {
        supersede = () => resolve(null);
      });
      // Spotify is paused alongside and never waited for: its two round trips
      // used to come on top of the resolve.
      void pauseSpotify();
      const stream = await Promise.race([localStream(track, fresh), superseded]);
      if (!stream || run !== generation) {
        // A resolve that lands after a newer command took over still holds a
        // registered stream; it is handed back rather than left to age out.
        if (stream?.streamId) {
          void invoke("release_audio", { streamId: stream.streamId }).catch(() => {});
        }
        return;
      }
      streamId = stream.streamId;
      playingLocally = true;
      player.src = stream.url;
      player.currentTime = positionMs / 1000;
      await player.play();
      if (run !== generation) {
        await releaseAudio();
        return;
      }
    } else {
      await spotify.playTrack(track.uri, positionMs);
    }
    if (run === generation) {
      publish({ loading: false, playback: { track, progressMs: positionMs, isPlaying: true } });
      prefetchUpcoming();
    }
  } catch (error) {
    if (run !== generation) return;
    publish({
      loading: false,
      error: errorMessage(error),
      playback: { track, progressMs: positionMs, isPlaying: false },
    });
    throw error;
  }
}

/**
 * Moves on once the Spotify song stopped at its end. Each song plays as its own
 * one-track context, so Spotify just stops there. The SDK only reports changes,
 * not progress: the last reading is usually from the song's start, so the
 * position is extrapolated from it.
 */
function followSpotify(next: SpotifyProgress | null) {
  const prev = spotifyProgress;
  spotifyProgress = next;
  if (ended || !prev?.playing || next?.playing) return;
  const elapsed = (next?.sampledAt ?? Date.now()) - prev.sampledAt;
  if (prev.positionMs + elapsed < prev.durationMs - END_SLACK_MS) return;
  ended = true;
  void enqueue({ action: "next" });
}

async function pollRemoteSpotify() {
  const track = state().playback?.track;
  const idle = () =>
    !state().local || state().loading || ended || state().playback?.track !== track;
  if (idle() || track?.provider !== "spotify") return;
  if (isSpotifyWebPlaybackReady() && getSpotifyLocalPlayback()) return;
  const data = await fetchCurrentlyPlaying().catch(() => undefined);
  // A failed read says nothing, and by now another song may have started.
  if (data === undefined || idle()) return;
  // Someone started something else on another device; that is not an end.
  if (data?.item && data.item.id !== track.id) return;
  followSpotify(
    data?.item
      ? {
          positionMs: data.progress_ms ?? 0,
          durationMs: data.item.duration_ms,
          playing: data.is_playing,
          sampledAt: Date.now(),
        }
      : null
  );
}

/**
 * The end of a session Orion drives itself: a playlist played through, or the
 * single track from search that was all there was. Spotify does not stop there
 * and neither does Orion — the radio continues from what just played, whatever
 * provider it came from.
 *
 * Handing over means giving up local playback: the radio runs on Spotify, and
 * `spotifyAutoplay` only watches playback that Orion does not own. Keeping
 * `local` true here is what used to make the radio stop after one round.
 */
async function runOut(seed: UnifiedTrack | null) {
  const run = generation;
  // The track is over either way, so the stream goes first: building the radio
  // takes a moment, and holding a finished stream open only risks overlap.
  await releaseAudio();
  if (seed && (await continueWithRadio(seed).catch(() => false))) {
    if (run !== generation) return;
    publish({
      local: false,
      playlist: null,
      playlistId: null,
      entryId: null,
      playback: null,
      loading: false,
      error: null,
    });
    return;
  }
  if (run !== generation) return;
  // No radio to be had — Spotify disconnected, or nothing related found.
  // Park on the last track rather than pretending something is playing.
  const current = state();
  if (current.playback?.track?.provider === "spotify") await spotify.pause().catch(() => {});
  else audio?.pause();
  publish({
    loading: false,
    playback: current.playback ? { ...current.playback, isPlaying: false } : null,
  });
}

async function advance(previous: boolean) {
  const current = state();
  if (!current.local) {
    if (previous) await spotify.previousTrack();
    else await skipToNext();
    return;
  }
  if (previous && (current.playback?.progressMs ?? 0) > 3000) {
    if (selfPlayed(current.playback?.track) && audio) audio.currentTime = 0;
    else await spotify.seek(0);
    return;
  }
  const entries = current.playlist?.entries ?? [];
  let entry: PlaylistEntry | undefined;
  if (previous) {
    if (current.shuffle) {
      const id = history.pop();
      entry = entries.find((e) => e.entryId === id);
    } else {
      entry = entries[entries.findIndex((e) => e.entryId === current.entryId) - 1];
    }
  } else {
    if (current.shuffle && current.entryId) heard.add(current.entryId);
    entry = upcoming();
    planned = null;
  }
  if (!entry) {
    // Running out backwards is not running out: "previous" on the first song
    // restarts it, the way Spotify does. Only the forward end starts a radio.
    if (previous) {
      if (selfPlayed(current.playback?.track) && audio) audio.currentTime = 0;
      else await spotify.seek(0);
      return;
    }
    await runOut(current.playback?.track ?? null);
    return;
  }
  if (!previous && current.entryId) history.push(current.entryId);
  publish({ entryId: entry.entryId });
  await playEntry(entry.track);
}

async function execute(command: PlaybackCommand) {
  switch (command.action) {
    case "state":
      publish({});
      return;
    case "track": {
      stopAIQueue();
      publish({ local: true, playlist: null, playlistId: null, entryId: null });
      await playEntry(command.track, command.positionMs);
      if (command.track.provider === "spotify") publish({ local: false, playback: null });
      return;
    }
    case "playlist": {
      const entry = command.playlist.entries.find((e) => e.entryId === command.entryId);
      if (!entry) throw new Error("Playlist entry no longer exists");
      // Only a *mixed* playlist needs Spotify playing inside Orion: the two
      // halves have to hand over to each other on the same device. A playlist
      // of only self-played tracks needs no Spotify at all.
      const entries = command.playlist.entries;
      const mixed =
        entries.some((e) => selfPlayed(e.track)) &&
        entries.some((e) => e.track.provider === "spotify");
      if (mixed) {
        const id = getSpotifyWebPlaybackDeviceId();
        if (!id || !isSpotifyWebPlaybackReady())
          throw new Error(
            "Mixed playlists need Spotify playback in Orion. Connect Spotify Premium and select Orion as the device."
          );
        await activateSpotifyWebPlayback();
        await transferPlayback(id, false);
      }
      stopAIQueue();
      history = [];
      heard = new Set();
      planned = null;
      publish({
        local: true,
        playlist: command.playlist,
        playlistId: command.playlist.playlistId,
        entryId: entry.entryId,
        shuffle: command.shuffle ?? false,
      });
      await playEntry(entry.track);
      return;
    }
    case "next":
      await advance(false);
      return;
    case "previous":
      await advance(true);
      return;
    case "stop":
      await releaseAudio();
      publish({
        local: false,
        playlist: null,
        playlistId: null,
        entryId: null,
        playback: null,
        error: null,
        loading: false,
      });
      return;
    case "volume":
      if (audio) audio.volume = Math.max(0, Math.min(1, toOutputVolume(command.volume) / 100));
      if (!selfPlayed(state().playback?.track)) await spotify.setVolume(command.volume);
      return;
    case "shuffle":
      publish({ shuffle: command.enabled });
      heard = new Set();
      planned = null;
      prefetchUpcoming();
      return;
    case "seek":
      if (state().local && selfPlayed(state().playback?.track) && audio)
        audio.currentTime = Math.max(0, command.positionMs) / 1000;
      else await spotify.seek(command.positionMs);
      return;
    case "playing": {
      const current = state();
      const track = current.playback?.track;
      if (current.local && selfPlayed(track)) {
        if (!command.playing) audio?.pause();
        else if (!playingLocally || current.error) {
          await playEntry(track, current.playback?.progressMs ?? 0);
          return;
        } else await audio?.play();
      } else if (command.playing) await spotify.play();
      else await spotify.pause();
      const playback = state().playback;
      if (current.local && playback)
        publish({ loading: false, playback: { ...playback, isPlaying: command.playing } });
    }
  }
}

function enqueue(command: PlaybackCommand): Promise<void> {
  const pausingLoad = command.action === "playing" && !command.playing && state().loading;
  if (SUPERSEDING.has(command.action) || pausingLoad) takeOver();
  // Nothing to wait for: a volume drag must not queue behind a song still loading.
  if (command.action === "volume" || command.action === "state") return execute(command);
  const result = serial.then(() => execute(command));
  serial = result.catch((error) => {
    publish({ loading: false, error: errorMessage(error) });
  });
  return result;
}

export function initializePlaybackSession(): Promise<void> {
  initialized ??= (async () => {
    if (!MAIN) {
      await listen<PlaybackSession>("playback-session-state", ({ payload }) =>
        usePlaybackSession.setState(payload)
      );
      await emitTo("main", "playback-session-command", { command: { action: "state" } });
      return;
    }
    const player = new Audio();
    audio = player;
    player.preload = "auto";
    // The bar runs its own clock between reports, so the position needs one
    // report a second; timeupdate fires four times as often.
    let reportedAt = 0;
    const syncAudio = (event: Event) => {
      const current = state();
      const playback = current.playback;
      if (!playingLocally || !playback || !selfPlayed(playback.track)) return;
      const isPlaying = !player.paused && !player.ended;
      const routine = event.type === "timeupdate" && isPlaying === playback.isPlaying;
      if (routine && performance.now() - reportedAt < PROGRESS_EVERY_MS) return;
      reportedAt = performance.now();
      publish(
        { playback: { ...playback, progressMs: player.currentTime * 1000, isPlaying } },
        routine
      );
    };
    for (const event of ["timeupdate", "play", "pause", "seeked"])
      player.addEventListener(event, syncAudio);
    player.addEventListener("ended", () => {
      if (!ended) {
        ended = true;
        void enqueue({ action: "next" });
      }
    });
    player.addEventListener("error", () => {
      if (!playingLocally || state().loading) return;
      const current = state().playback;
      if (!current?.track || retry) {
        publish({
          error: "YouTube audio is unavailable. Try again.",
          playback: current ? { ...current, isPlaying: false } : null,
        });
        return;
      }
      retry = true;
      const track = current.track;
      // A cached stream URL can expire mid-song; the retry resolves a new one.
      const result = serial.then(async () => {
        await playEntry(track, current.progressMs, true);
        retry = true;
      });
      serial = result.catch(() => {});
    });
    await listen<{ id?: string; from?: string; command: PlaybackCommand }>(
      "playback-session-command",
      ({ payload }) => {
        void enqueue(payload.command).then(
          () =>
            payload.id && payload.from
              ? emitTo(payload.from, "playback-session-result", { id: payload.id })
              : undefined,
          (error) =>
            payload.id && payload.from
              ? emitTo(payload.from, "playback-session-result", {
                  id: payload.id,
                  error: errorMessage(error),
                })
              : undefined
        );
      }
    );
    // The event only says what changed; the playing playlist is read back.
    await listen<PlaylistChange>("local-playlist-changed", ({ payload }) => {
      const current = state().playlist;
      if (
        current?.playlistId !== payload.playlistId ||
        current.accountId !== payload.accountId ||
        current.revision >= payload.revision
      )
        return;
      void invoke<LocalPlaylist>("read_local_playlist", {
        accountId: payload.accountId,
        playlistId: payload.playlistId,
      })
        .then((playlist) => {
          if (state().playlist?.playlistId === playlist.playlistId) publish({ playlist });
        })
        .catch(() => {});
    });
    subscribeSpotifyLocalPlayback((sample) => {
      const current = state();
      if (
        !current.local ||
        current.loading ||
        current.playback?.track?.provider !== "spotify" ||
        !sample?.track
      )
        return;
      if (sample.track.id !== current.playback.track.id) return;
      const previous = current.playback;
      followSpotify({
        positionMs: sample.positionMs,
        durationMs: sample.durationMs,
        playing: !sample.paused,
        sampledAt: sample.sampledAt,
      });
      publish(
        {
          playback: {
            track: convertToUnifiedTrack(sample.track),
            progressMs: sample.positionMs,
            isPlaying: !sample.paused,
          },
        },
        previous.isPlaying === !sample.paused
      );
    });
    setInterval(() => void pollRemoteSpotify(), REMOTE_POLL_MS);
    const settings = await readSettings();
    player.volume = Math.max(0, Math.min(1, toOutputVolume(settings.spotify_volume ?? 50) / 100));
  })();
  return initialized;
}

export async function playbackCommand(command: PlaybackCommand): Promise<void> {
  await initializePlaybackSession();
  if (MAIN) return enqueue(command);
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let dispose: (() => void) | undefined;
    const timer = setTimeout(() => {
      dispose?.();
      reject(new Error("The main player did not respond"));
    }, 60000);
    void listen<{ id: string; error?: string }>("playback-session-result", ({ payload }) => {
      if (payload.id !== id) return;
      clearTimeout(timer);
      dispose?.();
      if (payload.error) reject(new Error(payload.error));
      else resolve();
    })
      .then((off) => {
        dispose = off;
        return emitTo("main", "playback-session-command", {
          id,
          from: getCurrentWindow().label,
          command,
        });
      })
      .catch((error) => {
        clearTimeout(timer);
        dispose?.();
        reject(error);
      });
  });
}
