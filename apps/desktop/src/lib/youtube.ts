import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { UnifiedTrack } from "../providers/types";

export type YouTubeResults = { tracks: UnifiedTrack[]; continuation: string | null };
export function searchYouTube(
  query: string,
  continuation: string | null = null
): Promise<YouTubeResults> {
  return invoke("search_youtube", { query, continuation });
}
/**
 * Queues tracks to load in the background, the first most urgently, so playing
 * one later starts at once. Takes resolver refs (`"<source>:<id>"`), so
 * YouTube and SoundCloud share the one queue.
 */
export function prefetchAudio(refs: string | string[]): void {
  const list = typeof refs === "string" ? [refs] : refs;
  if (list.length === 0) return;
  void invoke("prefetch_audio", { tracks: list }).catch(() => {});
}
export function useYouTubeConnection() {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let alive = true;
    let revision = 0;
    const off = listen<{ signedIn: boolean }>("youtube-web-sign-in", ({ payload }) => {
      revision++;
      if (alive) setConnected(payload.signedIn);
    });
    void off
      .then(async () => {
        const before = revision;
        const status = await invoke<{ signedIn: boolean }>("youtube_web_status");
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
