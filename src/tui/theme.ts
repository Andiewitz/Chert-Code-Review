// Themes: named palettes plus the single reactive theme signal the whole TUI
// reads through COLORS(). Kept outside the component so every pane re-colors on
// a switch without prop drilling.

import { createSignal } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { join } from "node:path"
import { bestEffort } from "../best-effort"
import { configDir, readJson, writeJsonAtomic } from "../config"

export type ThemeName = "default" | "dark-contrast" | "whiteout" | "github"

export const THEME_LABELS: Record<ThemeName, string> = {
  default: "Default",
  "dark-contrast": "Dark Contrast",
  whiteout: "Whiteout",
  github: "GitHub",
}

export const THEME_DESCRIPTIONS: Record<ThemeName, string> = {
  default: "The default chert theme.",
  "dark-contrast": "Pure black background with maximum-contrast colors.",
  whiteout: "White background; blue instead of green, purple instead of red.",
  github: "GitHub's color palette.",
}

export interface ThemePalette {
  bg: string
  rule: string
  dim: string
  text: string
  bright: string
  selectedBg: string
  /** A raised surface for floating panels, a step above the page background. */
  panel: string
  accent: string
  purple: string
  purpleBright: string
  purpleDim: string
  danger: string
  add: string
}

export const THEMES: Record<ThemeName, ThemePalette> = {
  default: {
    bg: "#0f0d13",
    rule: "#2a2433",
    dim: "#7d7488",
    text: "#cfc8d8",
    bright: "#f6f2fb",
    selectedBg: "#241d33",
    panel: "#191320",
    accent: "#a78bfa",
    purple: "#a78bfa",
    purpleBright: "#d6c6ff",
    purpleDim: "#6d5bb0",
    danger: "#e5788a",
    add: "#7ec699",
  },
  "dark-contrast": {
    bg: "#000000",
    rule: "#555555",
    dim: "#aaaaaa",
    text: "#ffffff",
    bright: "#ffffff",
    selectedBg: "#222222",
    panel: "#101010",
    accent: "#00d4ff",
    purple: "#00d4ff",
    purpleBright: "#e0ffff",
    purpleDim: "#0088aa",
    danger: "#ff5555",
    add: "#50fa7b",
  },
  whiteout: {
    bg: "#ffffff",
    rule: "#d0d7de",
    dim: "#57606a",
    text: "#000000",
    bright: "#000000",
    selectedBg: "#eaeef2",
    panel: "#f6f8fa",
    accent: "#0969da",
    purple: "#0969da",
    purpleBright: "#0550ae",
    purpleDim: "#a5d6ff",
    danger: "#8250df",
    add: "#0969da",
  },
  github: {
    bg: "#0d1117",
    rule: "#30363d",
    dim: "#8b949e",
    text: "#c9d1d9",
    bright: "#f0f6fc",
    selectedBg: "#161b22",
    panel: "#0d1117",
    accent: "#58a6ff",
    purple: "#58a6ff",
    purpleBright: "#79c0ff",
    purpleDim: "#1f6feb",
    danger: "#f85149",
    add: "#3fb950",
  },
}

function loadThemeName(): ThemeName {
  const parsed = readJson<{ theme?: string }>(join(configDir(), "theme.json"))
  if (parsed && typeof parsed.theme === "string" && parsed.theme in THEMES) {
    return parsed.theme as ThemeName
  }
  return "default"
}

function saveThemeName(name: ThemeName): void {
  // A read-only config directory must not break the TUI.
  bestEffort("persist theme", () => writeJsonAtomic(join(configDir(), "theme.json"), { theme: name }))
}

const [themeName, setThemeNameSignal] = createSignal<ThemeName>(loadThemeName())
export function setTheme(name: ThemeName): void {
  setThemeNameSignal(name)
  saveThemeName(name)
}
function colors(): ThemePalette {
  return THEMES[themeName()]
}

/** The active palette. A getter so panes re-colour when the theme changes. */
export const COLORS = colors

// Terminal cells have no font size, so hierarchy comes from weight and tone:
// bold + bright for what the eye should land on, dim for everything else.
export const ATTR = {
  none: 0,
  bold: TextAttributes.BOLD,
  dim: TextAttributes.DIM,
}

export const WORDMARK = [
  " ██████╗██╗  ██╗███████╗██████╗ ████████╗",
  "██╔════╝██║  ██║██╔════╝██╔══██╗╚══██╔══╝",
  "██║     ███████║█████╗  ██████╔╝   ██║   ",
  "██║     ██╔══██║██╔══╝  ██╔══██╗   ██║   ",
  "╚██████╗██║  ██║███████╗██║  ██║   ██║   ",
  " ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝   ╚═╝   ",
]

export const WORDMARK_FG = ["#e2d6ff", "#d3c0ff", "#c4aeff", "#b39bfb", "#9f86f4", "#8367d8"]
