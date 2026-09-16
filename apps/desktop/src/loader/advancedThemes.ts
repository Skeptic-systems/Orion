/**
 * Advanced themes restyle the desktop shell as a whole: layout, materials,
 * type and a backdrop, not just colours. Each one pairs a colour theme (in
 * themes/advanced, so the mini player and settings follow along) with a skin
 * in ui/skins.css, switched on through `data-skin` on the document element.
 */

export type AdvancedTheme = {
  id: string;
  label: string;
  description: string;
};

/** Stored in `settings.theme` as this prefix plus the id. */
export const ADVANCED_THEME_PREFIX = "advanced:";

export const ADVANCED_THEMES: AdvancedTheme[] = [
  {
    id: "liquid-glass",
    label: "Liquid Glass",
    description: "Floating panes of frosted glass over a vivid wallpaper.",
  },
  {
    id: "ambient",
    label: "Ambient",
    description: "Dark cards lit by the colours of the song that is playing.",
  },
  {
    id: "editorial",
    label: "Editorial",
    description: "Warm paper, ink rules and serif type, like a music magazine.",
  },
  {
    id: "neon",
    label: "Neon Drive",
    description: "A synthwave night with a glowing horizon grid.",
  },
];

export function advancedThemeLabel(theme: string): string | null {
  if (!theme.startsWith(ADVANCED_THEME_PREFIX)) return null;
  const id = theme.slice(ADVANCED_THEME_PREFIX.length);
  return ADVANCED_THEMES.find((entry) => entry.id === id)?.label ?? null;
}
