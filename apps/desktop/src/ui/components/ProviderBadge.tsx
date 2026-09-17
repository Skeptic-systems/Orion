import { HardDrives, SoundcloudLogo, SpotifyLogo, YoutubeLogo } from "@phosphor-icons/react";
import { type MusicProviderType, PROVIDER_NAMES, type UnifiedTrack } from "../../providers/types";

const ICONS = {
  spotify: SpotifyLogo,
  youtube: YoutubeLogo,
  soundcloud: SoundcloudLogo,
  // Jellyfin has no mark in the icon set, and it is the user's own server
  // rather than a service: a drive reads truer than a borrowed logo.
  jellyfin: HardDrives,
} as const satisfies Record<MusicProviderType, unknown>;

/** The little source mark on a track row. */
export default function ProviderBadge({
  provider,
  size = 19,
}: {
  provider: MusicProviderType;
  size?: number;
}) {
  const Icon = ICONS[provider];
  return (
    <span className={`library-source is-${provider}`} title={PROVIDER_NAMES[provider]}>
      <Icon size={size} weight="fill" />
    </span>
  );
}

/**
 * Where "Open in <service>" goes. Jellyfin tracks live on the user's own
 * server, which has no shareable per-track page, so they have none.
 */
export function trackUrl(track: UnifiedTrack): string | null {
  switch (track.provider) {
    case "spotify":
      return `https://open.spotify.com/track/${track.id}`;
    case "youtube":
      return `https://www.youtube.com/watch?v=${track.id}`;
    case "soundcloud":
      return `https://soundcloud.com/${track.id}`;
    case "jellyfin":
      return null;
  }
}
