/**
 * Tako 🐙 Ocean Theme
 *
 * Color palette inspired by the deep ocean — where octopi thrive.
 */

export const theme = {
  // ── Primary colors ──────────────────────────────────────────
  deepBlue: '#0d1b2a',      // Background / darkest
  navy: '#1b2838',           // Panel backgrounds
  ocean: '#1e3a5f',          // Borders, separators
  teal: '#0f969c',           // Primary accent
  cyan: '#00d4aa',           // Success, active states
  aqua: '#72efdd',           // Highlights

  // ── Accent colors ──────────────────────────────────────────
  coral: '#ff6b6b',          // Errors, warnings
  orange: '#ffa07a',         // Caution, tool calls
  purple: '#a855f7',         // Emphasis, thinking
  lavender: '#c084fc',       // Secondary emphasis
  gold: '#fbbf24',           // Important, stars

  // ── Text colors ─────────────────────────────────────────────
  textPrimary: '#e0f2fe',    // Main text (light blue-white)
  textSecondary: '#94a3b8',  // Dimmed text
  textMuted: '#64748b',      // Very dimmed
  textBright: '#f0f9ff',     // Bright white-blue

  // ── Semantic ────────────────────────────────────────────────
  userMsg: '#38bdf8',        // User message color (sky blue)
  agentMsg: '#00d4aa',       // Agent message color (cyan-green)
  toolCall: '#ffa07a',       // Tool call color (orange)
  toolResult: '#94a3b8',     // Tool result color (muted)
  thinking: '#a855f7',       // Thinking indicator (purple)
  error: '#ff6b6b',          // Error color (coral)
  success: '#00d4aa',        // Success color (cyan)
  warning: '#fbbf24',        // Warning color (gold)

  // ── Gradient stops for header ───────────────────────────────
  gradient: ['#0f969c', '#00d4aa', '#72efdd', '#38bdf8', '#a855f7'],

  // ── Pixel block separators ──────────────────────────────────
  border: {
    topLeft: '◼',
    topRight: '◼',
    bottomLeft: '◼',
    bottomRight: '◼',
    horizontal: '░',
    vertical: '▌',
    teeRight: '▐',
    teeLeft: '▌',
  },

  // ── Cute pixel art icons ─────────────────────────────────
  icons: {
    agent: '◉‿◉',           // Cute tako face — agent messages
    user: '◕‿◕',            // Small human face — user messages
    tool: '[:::]',          // Gear/cog — tool calls
    toolRun: '[⊛]',         // Running tool
    toolOk: '[✓]',          // Done tool
    toolErr: '[✗]',         // Error tool
    thinking: '◉_◉',        // Tako thinking face
    system: '[!]',          // System messages
    channel: '(~)',         // Channel/radio
    memory: '{m}',          // Memory
    wrench: '{t}',          // Tool profile
  },

  // ── Animated tako prompt frames (blinking/wiggling) ────────
  promptFrames: [
    '◉‿◉ >',               // Idle smile
    '◉◡◉ >',               // Blink
    '◉‿◉ >',               // Idle smile
    '◉◡◉ >',               // Blink
  ],

  // ── Thinking spinner frames (faster wiggle) ────────────────
  spinnerFrames: [
    '◉_◉ ~',
    '◉‿◉  ~',
    '◉_◉   ~',
    '◉‿◉  ~',
    '◉_◉ ~',
    '◉◡◉~',
    '◉_◉ ~',
    '◉‿◉  ~',
  ],
} as const;

export type Theme = typeof theme;
