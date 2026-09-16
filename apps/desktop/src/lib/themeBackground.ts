import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { readSettings, SETTINGS_CHANGED_EVENT, type Settings, writeSettings } from "./settingLib";

/** Matches the limit in theme_background.rs, checked here to fail before the upload. */
const MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_DIM = 35;

export async function uploadThemeBackground(file: File): Promise<void> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > MAX_BYTES) throw new Error("The image is larger than 25 MB.");
  await invoke("save_theme_background", new Uint8Array(await file.arrayBuffer()));
  // A new token each time, so every window reloads the image.
  await writeSettings({ theme_background: String(Date.now()) });
}

export async function removeThemeBackground(): Promise<void> {
  await invoke("delete_theme_background");
  await writeSettings({ theme_background: null });
}

/** The uploaded background as an object URL, and how far it is dimmed. */
export function useThemeBackground(): { url: string | null; dim: number } {
  const [token, setToken] = useState<string | null>(null);
  const [dim, setDim] = useState(DEFAULT_DIM);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const apply = (settings: Settings) => {
      setToken(settings.theme_background ?? null);
      setDim(settings.theme_background_dim ?? DEFAULT_DIM);
    };
    readSettings()
      .then(apply)
      .catch(() => {});
    const unlisten = listen<Settings>(SETTINGS_CHANGED_EVENT, (event) => {
      if (event.payload) apply(event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  useEffect(() => {
    if (!token) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    // Raw bytes, not a data URL: a base64 copy of a large photo is a third
    // bigger and has to be parsed as a string first.
    invoke<ArrayBuffer | number[]>("load_theme_background")
      .then((bytes) => {
        const data = new Uint8Array(bytes);
        if (cancelled || data.byteLength === 0) return;
        // No type: the image decoder recognises the format from the bytes.
        objectUrl = URL.createObjectURL(new Blob([data]));
        setUrl(objectUrl);
      })
      .catch((error) => console.error("Failed to load the theme background:", error));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token]);

  return { url: token ? url : null, dim };
}
