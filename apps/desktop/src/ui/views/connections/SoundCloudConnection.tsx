import { CircleNotch, SignOut, SoundcloudLogo } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { soundCloudSignIn, soundCloudSignOut } from "../../../lib/soundcloud";

const BRAND = "#FF5500";

/**
 * The optional SoundCloud account. Search and playback work signed out; the
 * session only adds Go+ and private tracks, so this card never blocks anything.
 */
export default function SoundCloudConnection() {
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<{ signedIn: boolean }>("soundcloud_status")
      .then((status) => setSignedIn(status.signedIn))
      .catch(() => {});
    const unlisten = listen<{ signedIn: boolean }>("soundcloud-sign-in", (event) => {
      setBusy(false);
      setSignedIn(event.payload.signedIn);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const signIn = async () => {
    setBusy(true);
    try {
      // Opens the sign-in window; the result arrives as `soundcloud-sign-in`.
      await soundCloudSignIn();
    } catch (error) {
      console.error("SoundCloud sign-in failed:", error);
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await soundCloudSignOut();
      setSignedIn(false);
    } catch (error) {
      console.error("SoundCloud sign-out failed:", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="settings-connection-row flex items-center justify-between gap-4 p-4 rounded-xl border"
      style={{
        background: "var(--settings-card-bg)",
        borderColor: signedIn ? `${BRAND}50` : "rgba(255, 255, 255, 0.1)",
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: BRAND }}
        >
          <SoundcloudLogo size={24} weight="fill" color="#fff" />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="font-medium">SoundCloud</span>
          <span className="text-xs" style={{ color: "var(--settings-text-muted)" }}>
            {signedIn
              ? "Search SoundCloud and play its audio, including Go+ and private tracks."
              : "Optional. Search and playback work as a guest; signing in adds Go+ and private tracks."}
          </span>
        </div>
      </div>
      {signedIn ? (
        <button
          type="button"
          onClick={signOut}
          disabled={busy}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/20 transition-all duration-200 cursor-pointer flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? (
            <CircleNotch size={16} weight="bold" className="animate-spin" />
          ) : (
            <SignOut size={16} />
          )}
          <span className="text-sm">Sign out</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={signIn}
          disabled={busy}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-white font-medium hover:opacity-90 transition-all duration-200 cursor-pointer flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: BRAND }}
        >
          {busy ? (
            <CircleNotch size={16} weight="bold" className="animate-spin" />
          ) : (
            <SoundcloudLogo size={16} weight="fill" />
          )}
          <span className="text-sm">Sign in</span>
        </button>
      )}
    </div>
  );
}
