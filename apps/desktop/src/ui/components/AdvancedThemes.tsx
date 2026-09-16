import { Check, ImageSquare, Trash, UploadSimple } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { writeSettings } from "../../lib/settingLib";
import {
  removeThemeBackground,
  uploadThemeBackground,
  useThemeBackground,
} from "../../lib/themeBackground";
import { ADVANCED_THEME_PREFIX, ADVANCED_THEMES } from "../../loader/advancedThemes";

type AdvancedThemesProps = {
  currentTheme: string;
  onApply: (theme: string) => void;
};

/** The advanced theme picker and the background image they share. */
export default function AdvancedThemes({ currentTheme, onApply }: AdvancedThemesProps) {
  const background = useThemeBackground();
  const [dim, setDim] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const shownDim = dim ?? background.dim;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await uploadThemeBackground(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await removeThemeBackground();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="border-t border-white/10 my-2" />
      <div className="flex items-center justify-between">
        <div className="font-medium">Advanced Themes</div>
        <span className="text-xs text-[--settings-text-muted]">Restyle the whole desktop app</span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {ADVANCED_THEMES.map((theme) => {
          const value = `${ADVANCED_THEME_PREFIX}${theme.id}`;
          const selected = currentTheme === value;
          return (
            <button
              key={theme.id}
              type="button"
              onClick={() => onApply(value)}
              aria-pressed={selected}
              className="flex flex-col gap-2 p-2 rounded-xl border text-left transition-all duration-200 ease-in-out cursor-pointer hover:scale-[1.02] active:scale-[0.98]"
              style={{
                background: selected ? "var(--settings-item-active)" : "var(--settings-panel-bg)",
                borderColor: selected ? "var(--settings-accent)" : "rgba(255, 255, 255, 0.1)",
              }}
            >
              <span className={`skin-preview skin-preview--${theme.id}`} aria-hidden="true">
                <i className="skin-preview-side" />
                <i className="skin-preview-main">
                  <b />
                  <b />
                  <b />
                </i>
                <i className="skin-preview-bar" />
              </span>
              <span className="flex items-center justify-between gap-2 px-1">
                <span className="font-medium">{theme.label}</span>
                {selected && <Check size={14} weight="bold" color="var(--settings-accent)" />}
              </span>
              <span className="px-1 pb-1 text-xs text-[--settings-text-muted]">
                {theme.description}
              </span>
            </button>
          );
        })}
      </div>

      <div
        className="p-4 rounded-xl border"
        style={{
          background: "var(--settings-card-bg)",
          borderColor: "var(--settings-card-border)",
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <ImageSquare size={18} weight="fill" />
            <div>
              <div className="font-medium">Background image</div>
              <p className="text-xs text-[--settings-text-muted] mt-1">
                Replaces the scenery of every advanced theme with your own picture.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {background.url && (
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="p-2 rounded-lg hover:bg-red-500/30 transition-colors cursor-pointer disabled:opacity-50"
                title="Remove background image"
                aria-label="Remove background image"
              >
                <Trash size={16} />
              </button>
            )}
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 transition-colors cursor-pointer hover:bg-white/10 disabled:opacity-50"
            >
              <UploadSimple size={16} weight="bold" />
              {background.url ? "Replace" : "Upload"}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
              hidden
              onChange={(event) => {
                void upload(event.target.files?.[0]);
                // Choosing the same file again should upload it again.
                event.target.value = "";
              }}
            />
          </div>
        </div>

        {error && (
          <p className="text-xs mt-3 text-red-400" role="alert">
            {error}
          </p>
        )}

        {background.url && (
          <div className="mt-4 pt-4 border-t border-white/10 flex items-center gap-4">
            <div
              className="w-24 aspect-video rounded-lg bg-cover bg-center flex-shrink-0 border border-white/10"
              style={{ backgroundImage: `url("${background.url}")` }}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-[--settings-text-muted]">Fade</div>
                <span className="text-xs text-[--settings-text-muted] tabular-nums">
                  {shownDim}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={80}
                step={5}
                value={shownDim}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setDim(next);
                  // Previewed on the shell directly and saved once the slider
                  // is let go: every write goes through Rust to every window.
                  document
                    .querySelector<HTMLElement>(".desktop-shell")
                    ?.style.setProperty("--skin-image-dim", String(next / 100));
                }}
                onPointerUp={() =>
                  dim !== null && void writeSettings({ theme_background_dim: dim })
                }
                onKeyUp={() => dim !== null && void writeSettings({ theme_background_dim: dim })}
                className="window-opacity-slider w-full h-2 rounded-full appearance-none cursor-pointer"
                style={{
                  background: `linear-gradient(90deg, var(--settings-accent) 0%, var(--settings-accent) ${
                    (shownDim / 80) * 100
                  }%, rgba(255, 255, 255, 0.16) ${(shownDim / 80) * 100}%, rgba(255, 255, 255, 0.16) 100%)`,
                }}
                aria-label="Background image fade"
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
