import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { UnifiedTrack } from "../providers/types";

export type SoundCloudResults = { tracks: UnifiedTrack[]; page: number; hasMore: boolean };

/**
 * SoundCloud's search. It works signed out; an account only adds Go+ and
 * private tracks, so nothing here is gated on one.
 */
export function searchSoundCloud(query: string, page = 0): Promise<SoundCloudResults> {
  return invoke("search_soundcloud", { query, page });
}

export function soundCloudSignIn(): Promise<void> {
  return invoke("soundcloud_sign_in");
}

export function soundCloudSignOut(): Promise<void> {
  return invoke("soundcloud_sign_out");
}

/** Whether a SoundCloud account is signed in; purely informational. */
export function useSoundCloudConnection() {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let alive = true;
    let revision = 0;
    const off = listen<{ signedIn: boolean }>("soundcloud-sign-in", ({ payload }) => {
      revision++;
      if (alive) setConnected(payload.signedIn);
    });
    void off
      .then(async () => {
        const before = revision;
        const status = await invoke<{ signedIn: boolean }>("soundcloud_status");
        if (alive && revision === before) setConnected(status.signedIn);
      })
      .catch(() => {});
    return () => {
      alive = false;
      void off.then((dispose) => dispose());
    };
  }, []);
  return connected;
}
