import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { readSettings, writeSettings } from "./settingLib";

/**
 * A ten-band graphic equaliser on Orion's own player.
 *
 * It runs entirely in the renderer: the <audio> element feeds a Web Audio
 * graph of biquad filters, so every provider Orion streams itself — YouTube,
 * SoundCloud, Jellyfin — goes through it.
 *
 * Spotify does not, and cannot. Its Web Playback SDK decodes inside a
 * cross-origin iframe under Widevine, and protected media is barred from
 * Web Audio by design: `createMediaElementSource` on it yields silence, not
 * sound to filter. Nothing short of a system-wide output driver would reach it.
 *
 * Latency: biquads are IIR and run inside the render quantum, so the chain
 * adds no buffering of its own — no lookahead, no delay line, nothing that
 * accumulates. What playback costs is the audio context's own output latency,
 * which the element paid anyway; `latencyHint: "interactive"` keeps it at the
 * device minimum.
 */

/** ISO octave centres. The ends are shelves, so 31 Hz and 16 kHz keep working. */
export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const MAX_GAIN_DB = 12;
export const MAX_PREAMP_DB = 12;
/** One octave apart: this is the Q at which neighbouring bands sum flat. */
const BAND_Q = 1.41;
/** Slewed rather than stepped, so dragging a slider does not click. */
const RAMP_SECONDS = 0.04;

export type EqualizerState = {
  enabled: boolean;
  preset: string;
  preamp: number;
  bands: number[];
};

export type Preset = { id: string; label: string; preamp: number; bands: number[] };

/**
 * Preamps are negative wherever bands are boosted: without the headroom a
 * bass-heavy track clips, and clipping is far more audible than the few dB.
 */
export const PRESETS: Preset[] = [
  { id: "flat", label: "Flat", preamp: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: "bass", label: "Bass boost", preamp: -3, bands: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: "basscut", label: "Less bass", preamp: 0, bands: [-6, -5, -4, -2, 0, 0, 0, 0, 0, 0] },
  { id: "treble", label: "Treble boost", preamp: -3, bands: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  { id: "loudness", label: "Loudness", preamp: -4, bands: [6, 5, 2, 0, -2, -1, 1, 3, 5, 6] },
  { id: "vocal", label: "Vocal", preamp: -1, bands: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1] },
  { id: "rock", label: "Rock", preamp: -3, bands: [5, 4, 2, -1, -2, 0, 2, 4, 5, 5] },
  { id: "electronic", label: "Electronic", preamp: -3, bands: [5, 4, 1, 0, -2, 2, 1, 1, 4, 5] },
  { id: "acoustic", label: "Acoustic", preamp: -2, bands: [4, 4, 2, 1, 2, 2, 3, 3, 2, 1] },
  { id: "podcast", label: "Speech", preamp: -1, bands: [-4, -3, 0, 2, 4, 4, 3, 1, -1, -2] },
];

export const CUSTOM_PRESET = "custom";

const FLAT: EqualizerState = {
  enabled: false,
  preset: "flat",
  preamp: 0,
  bands: [...PRESETS[0].bands],
};

type Store = EqualizerState & {
  setEnabled: (enabled: boolean) => void;
  setPreset: (id: string) => void;
  setBand: (index: number, gainDb: number) => void;
  setPreamp: (db: number) => void;
  reset: () => void;
};

const clamp = (value: number, limit: number) =>
  Math.max(-limit, Math.min(limit, Number.isFinite(value) ? value : 0));

/** Anything read back from disk, made safe for the graph. */
function sanitize(state: Partial<EqualizerState> | null | undefined): EqualizerState {
  const bands = BANDS.map((_, index) => clamp(state?.bands?.[index] ?? 0, MAX_GAIN_DB));
  return {
    enabled: state?.enabled ?? false,
    preset: state?.preset ?? CUSTOM_PRESET,
    preamp: clamp(state?.preamp ?? 0, MAX_PREAMP_DB),
    bands,
  };
}

export const useEqualizer = create<Store>((set, get) => ({
  ...FLAT,
  setEnabled: (enabled) => set(persist({ ...current(get()), enabled })),
  setPreset: (id) => {
    const preset = PRESETS.find((option) => option.id === id);
    if (!preset) return;
    set(
      persist({
        ...current(get()),
        preset: preset.id,
        preamp: preset.preamp,
        bands: [...preset.bands],
      })
    );
  },
  setBand: (index, gainDb) => {
    const bands = [...get().bands];
    bands[index] = clamp(gainDb, MAX_GAIN_DB);
    // Once a band is dragged it is no longer the preset it came from.
    set(persist({ ...current(get()), preset: CUSTOM_PRESET, bands }));
  },
  setPreamp: (db) => set(persist({ ...current(get()), preamp: clamp(db, MAX_PREAMP_DB) })),
  reset: () => set(persist({ ...FLAT, enabled: get().enabled })),
}));

const current = (state: Store): EqualizerState => ({
  enabled: state.enabled,
  preset: state.preset,
  preamp: state.preamp,
  bands: state.bands,
});

let saveTimer: ReturnType<typeof setTimeout> | undefined;

const CHANGED_EVENT = "equalizer-changed";
const WINDOW = getCurrentWindow().label;

/**
 * Applies to the live graph at once, tells the other windows, and lets the
 * settings file catch up after.
 *
 * The graph lives in the main window, next to the player. The mini player runs
 * the same settings screen without one, so the change has to travel: the event
 * carries it there immediately, rather than waiting on the debounced write.
 */
function persist(state: EqualizerState): EqualizerState {
  apply(state);
  void emit(CHANGED_EVENT, { from: WINDOW, state }).catch(() => {});
  clearTimeout(saveTimer);
  // Dragging a slider fires continuously; the file is written once it settles.
  saveTimer = setTimeout(() => {
    void writeSettings({ equalizer: state }).catch(() => {});
  }, 400);
  return state;
}

let loaded: Promise<void> | null = null;

/** Restores the saved curve and follows the other windows. Runs once. */
export function loadEqualizer(): Promise<void> {
  loaded ??= (async () => {
    // Tauri delivers an emit back to its sender too; ours is already applied.
    await listen<{ from: string; state: EqualizerState }>(CHANGED_EVENT, ({ payload }) => {
      if (payload.from === WINDOW) return;
      const state = sanitize(payload.state);
      useEqualizer.setState(state);
      apply(state);
    }).catch(() => {});
    const settings = await readSettings().catch(() => null);
    if (settings?.equalizer) useEqualizer.setState(sanitize(settings.equalizer));
    apply(current(useEqualizer.getState()));
  })();
  return loaded;
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

type Graph = {
  context: AudioContext;
  filters: BiquadFilterNode[];
  preamp: GainNode;
};

let graph: Graph | null = null;
let attached: HTMLMediaElement | null = null;

/**
 * Routes the player through the equaliser. Call once, with the element that
 * plays Orion's own audio, before anything is loaded into it.
 *
 * A media element may only ever be handed to one source node, and from then on
 * its sound comes out of the graph rather than the element — so if this fails,
 * it fails before touching the element and playback continues unfiltered.
 */
export function attachEqualizer(element: HTMLMediaElement): boolean {
  if (attached === element) return true;
  if (attached) return false;
  try {
    const context = new AudioContext({ latencyHint: "interactive" });
    const source = context.createMediaElementSource(element);
    const preamp = context.createGain();
    const filters = BANDS.map((frequency, index) => {
      const filter = context.createBiquadFilter();
      // Shelves at the ends: a peak at 31 Hz or 16 kHz leaves everything
      // beyond it untouched, which is not what the outer sliders should mean.
      filter.type = index === 0 ? "lowshelf" : index === BANDS.length - 1 ? "highshelf" : "peaking";
      filter.frequency.value = frequency;
      filter.Q.value = BAND_Q;
      filter.gain.value = 0;
      return filter;
    });

    const last = filters.reduce<AudioNode>((node, filter) => node.connect(filter), source);
    last.connect(preamp).connect(context.destination);

    graph = { context, filters, preamp };
    attached = element;
    apply(current(useEqualizer.getState()));
    return true;
  } catch (error) {
    // No context, or the element was already claimed. Playback is untouched.
    console.error("Equalizer unavailable, playing unfiltered:", error);
    graph = null;
    return false;
  }
}

/**
 * Whether the equaliser can be used from this window. Only the main window
 * holds the graph; everywhere else the controls are still live, because the
 * change is forwarded to the window that does.
 */
export function equalizerAvailable(): boolean {
  return graph !== null || WINDOW !== "main";
}

/**
 * Browsers start an audio context suspended until a gesture, and a suspended
 * context means a silent player. Playback calls this before it starts a track.
 */
export function resumeEqualizer(): void {
  if (graph?.context.state === "suspended") void graph.context.resume().catch(() => {});
}

function apply(state: EqualizerState): void {
  if (!graph) return;
  const { context, filters, preamp } = graph;
  const at = context.currentTime;
  filters.forEach((filter, index) => {
    const gain = state.enabled ? (state.bands[index] ?? 0) : 0;
    filter.gain.setTargetAtTime(gain, at, RAMP_SECONDS);
  });
  const level = state.enabled ? 10 ** (state.preamp / 20) : 1;
  preamp.gain.setTargetAtTime(level, at, RAMP_SECONDS);
}
