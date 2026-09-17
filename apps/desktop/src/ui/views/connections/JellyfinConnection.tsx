import { CircleNotch, HardDrives, SignOut } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import {
  jellyfinConnect,
  jellyfinConnectWithKey,
  jellyfinDisconnect,
  useJellyfinStatus,
} from "../../../lib/jellyfin";

const BRAND = "#AA5CC3";

type Method = "password" | "apiKey";

/**
 * The user's own Jellyfin server. Username and password is the normal way in —
 * the password is traded for an access token on the server and never stored.
 * An API key from the Jellyfin dashboard works for anyone who prefers one.
 */
export default function JellyfinConnection() {
  const status = useJellyfinStatus();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<Method>("password");
  const [server, setServer] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (method === "password") await jellyfinConnect(server, username, secret);
      else await jellyfinConnectWithKey(server, username, secret);
      // Nothing from the form is worth keeping once the token is stored.
      setOpen(false);
      setServer("");
      setUsername("");
      setSecret("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await jellyfinDisconnect();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="settings-connection-row flex flex-col gap-3 p-4 rounded-xl border"
      style={{
        background: "var(--settings-card-bg)",
        borderColor: status.connected ? `${BRAND}50` : "rgba(255, 255, 255, 0.1)",
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: BRAND }}
          >
            <HardDrives size={24} weight="fill" color="#fff" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="font-medium">Jellyfin</span>
            <span className="text-xs truncate" style={{ color: "var(--settings-text-muted)" }}>
              {status.connected
                ? `${status.userName} on ${status.server}`
                : "Optional. Play your own library and add its songs to any playlist."}
            </span>
          </div>
        </div>
        {status.connected ? (
          <button
            type="button"
            onClick={disconnect}
            disabled={busy}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/20 transition-all duration-200 cursor-pointer flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? (
              <CircleNotch size={16} weight="bold" className="animate-spin" />
            ) : (
              <SignOut size={16} />
            )}
            <span className="text-sm">Disconnect</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-white font-medium hover:opacity-90 transition-all duration-200 cursor-pointer flex-shrink-0"
            style={{ background: BRAND }}
          >
            <HardDrives size={16} weight="fill" />
            <span className="text-sm">{open ? "Cancel" : "Connect"}</span>
          </button>
        )}
      </div>

      {!status.connected && open && (
        <form className="flex flex-col gap-2" onSubmit={connect}>
          <div className="flex gap-2 text-xs">
            {(["password", "apiKey"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMethod(option)}
                aria-pressed={method === option}
                className="px-2 py-1 rounded-md border transition-colors duration-150 cursor-pointer"
                style={{
                  borderColor: method === option ? BRAND : "rgba(255,255,255,0.12)",
                  color: method === option ? BRAND : "var(--settings-text-muted)",
                }}
              >
                {option === "password" ? "Username & password" : "API key"}
              </button>
            ))}
          </div>
          <input
            className="settings-input px-3 py-2 rounded-lg border border-white/10 bg-black/20 text-sm"
            value={server}
            onChange={(event) => setServer(event.target.value)}
            placeholder="Server, e.g. jellyfin.example.com or 192.168.1.10:8096"
            aria-label="Jellyfin server address"
            autoComplete="off"
            required
          />
          <input
            className="settings-input px-3 py-2 rounded-lg border border-white/10 bg-black/20 text-sm"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder={method === "password" ? "Username" : "Username to browse as"}
            aria-label="Jellyfin username"
            autoComplete="off"
            required={method === "password"}
          />
          <input
            className="settings-input px-3 py-2 rounded-lg border border-white/10 bg-black/20 text-sm"
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={method === "password" ? "Password" : "API key"}
            aria-label={method === "password" ? "Jellyfin password" : "Jellyfin API key"}
            autoComplete="off"
            required={method === "apiKey"}
          />
          {error && (
            <p className="text-xs text-red-400" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-white font-medium hover:opacity-90 transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: BRAND }}
          >
            {busy && <CircleNotch size={16} weight="bold" className="animate-spin" />}
            <span className="text-sm">{busy ? "Connecting…" : "Connect"}</span>
          </button>
          <p className="text-xs" style={{ color: "var(--settings-text-muted)" }}>
            Orion stores the access token your server issues, never your password.
          </p>
        </form>
      )}
    </div>
  );
}
