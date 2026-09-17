import { ArrowCounterClockwise, Info } from "@phosphor-icons/react";
import { useEffect } from "react";
import {
  BANDS,
  CUSTOM_PRESET,
  equalizerAvailable,
  loadEqualizer,
  MAX_GAIN_DB,
  MAX_PREAMP_DB,
  PRESETS,
  useEqualizer,
} from "../../lib/equalizer";

/** "31" and "16k" rather than "31 Hz" and "16000 Hz": the axis stays readable. */
function label(frequency: number): string {
  return frequency >= 1000 ? `${frequency / 1000}k` : String(frequency);
}

export default function EqualizerSettings() {
  const eq = useEqualizer();
  useEffect(() => {
    void loadEqualizer();
  }, []);

  const available = equalizerAvailable();
  const active = eq.enabled && available;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="font-medium">Equalizer</div>
          <p className="text-xs" style={{ color: "var(--settings-text-muted)" }}>
            Ten bands over YouTube, SoundCloud and Jellyfin.
          </p>
        </div>
        <label className="settings-switch flex items-center gap-2 cursor-pointer flex-shrink-0">
          <input
            type="checkbox"
            checked={eq.enabled}
            disabled={!available}
            onChange={(event) => eq.setEnabled(event.target.checked)}
          />
          <span className="text-sm">{eq.enabled ? "On" : "Off"}</span>
        </label>
      </div>

      {/* Spotify decodes inside its own DRM-protected iframe, which no page
          script may read. Better said plainly than left to surprise. */}
      <p
        className="flex items-start gap-2 text-xs p-3 rounded-lg"
        style={{ background: "var(--settings-card-bg)", color: "var(--settings-text-muted)" }}
      >
        <Info size={16} className="flex-shrink-0 mt-0.5" />
        <span>
          {available
            ? "Spotify is not affected: its player decodes protected audio in a sandbox that no equalizer in the app can reach."
            : "The audio engine could not start, so the equalizer is unavailable this session. Playback is unaffected."}
        </span>
      </p>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => eq.setPreset(preset.id)}
            aria-pressed={eq.preset === preset.id}
            disabled={!active}
            className="px-3 py-1.5 rounded-full border text-xs transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              borderColor:
                eq.preset === preset.id ? "var(--settings-accent)" : "rgba(255,255,255,0.12)",
              color: eq.preset === preset.id ? "var(--settings-accent)" : "var(--settings-text)",
            }}
          >
            {preset.label}
          </button>
        ))}
        {eq.preset === CUSTOM_PRESET && (
          <span
            className="px-3 py-1.5 rounded-full border text-xs"
            style={{ borderColor: "var(--settings-accent)", color: "var(--settings-accent)" }}
          >
            Custom
          </span>
        )}
      </div>

      <div className="equalizer-bands" aria-hidden={!active}>
        {BANDS.map((frequency, index) => (
          <div key={frequency} className="equalizer-band">
            <span className="equalizer-value">
              {(eq.bands[index] ?? 0) > 0 ? "+" : ""}
              {(eq.bands[index] ?? 0).toFixed(0)}
            </span>
            <input
              type="range"
              // Vertical sliders: the shape of the curve is the whole point.
              className="equalizer-slider"
              min={-MAX_GAIN_DB}
              max={MAX_GAIN_DB}
              step={1}
              value={eq.bands[index] ?? 0}
              disabled={!active}
              onChange={(event) => eq.setBand(index, Number(event.target.value))}
              aria-label={`${frequency} hertz`}
              aria-valuetext={`${eq.bands[index] ?? 0} decibels at ${frequency} hertz`}
            />
            <span className="equalizer-freq">{label(frequency)}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <span
          className="text-xs w-16 flex-shrink-0"
          style={{ color: "var(--settings-text-muted)" }}
        >
          Preamp
        </span>
        <input
          type="range"
          className="flex-1"
          min={-MAX_PREAMP_DB}
          max={MAX_PREAMP_DB}
          step={1}
          value={eq.preamp}
          disabled={!active}
          onChange={(event) => eq.setPreamp(Number(event.target.value))}
          aria-label="Preamp"
        />
        <span className="text-xs w-12 text-right tabular-nums">
          {eq.preamp > 0 ? "+" : ""}
          {eq.preamp} dB
        </span>
        <button
          type="button"
          onClick={eq.reset}
          disabled={!active}
          title="Reset to flat"
          aria-label="Reset to flat"
          className="p-2 rounded-lg hover:bg-white/10 transition-colors duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ArrowCounterClockwise size={16} />
        </button>
      </div>

      <p className="text-xs" style={{ color: "var(--settings-text-muted)" }}>
        Boosting bands can clip loud tracks. The presets lower the preamp to make room; if your own
        curve distorts, pull the preamp down a few decibels.
      </p>
    </div>
  );
}
