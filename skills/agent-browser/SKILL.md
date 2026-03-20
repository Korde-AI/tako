---
name: agent-browser
description: >
  Full-featured headless browser for web automation, scraping, and testing. Use this skill
  whenever the user wants to browse a website, interact with web pages, fill forms, click buttons,
  take screenshots, scrape content, test web flows, or do anything that requires a real browser.
  Prefer this over web_fetch for JavaScript-heavy sites, SPAs, login flows, or any task requiring
  interaction. Uses agent-browser (Playwright-backed CLI) via exec tool.
---

# Agent Browser

Tako uses `agent-browser` — a purpose-built headless browser CLI for AI agents backed by Playwright/Chromium.

## Core Workflow (always follow this)

```
1. agent-browser open <url>          # navigate
2. agent-browser snapshot -i         # get interactive elements + refs
3. agent-browser click @e2           # interact using refs
4. agent-browser snapshot -i         # re-snapshot if page changed
```

Always get a snapshot first before interacting — refs (`@e1`, `@e2`, ...) are deterministic handles to elements from the latest snapshot. Never guess CSS selectors if you can use refs.

## Essential Commands

### Navigate & Read
```bash
agent-browser open <url>             # navigate (aliases: goto, navigate)
agent-browser snapshot               # full accessibility tree
agent-browser snapshot -i            # interactive elements only (best for AI)
agent-browser snapshot -i -c -d 5    # compact, max depth 5
agent-browser snapshot -s "#main"    # scope to CSS selector
agent-browser get text @e1           # get text of element by ref
agent-browser get title              # get page title
agent-browser get url                # get current URL
agent-browser screenshot page.png    # screenshot (full page: --full)
agent-browser screenshot --annotate  # annotated with numbered element labels
```

### Interact
```bash
agent-browser click @e2              # click by ref
agent-browser fill @e3 "text"        # clear and fill input by ref
agent-browser type @e3 "text"        # type into input by ref
agent-browser hover @e4              # hover by ref
agent-browser press Enter            # press key
agent-browser scroll down 500        # scroll (up/down/left/right, px)
agent-browser select @e5 "option"    # select dropdown
agent-browser check @e6              # check checkbox
```

### Wait
```bash
agent-browser wait 2000              # wait ms
agent-browser wait "#selector"       # wait for element to be visible
agent-browser wait --text "Welcome"  # wait for text to appear
agent-browser wait --load networkidle # wait for network idle
```

### Find by Semantics (when no ref available)
```bash
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@example.com"
```

### Navigation
```bash
agent-browser back
agent-browser forward
agent-browser reload
```

### JSON output (for structured parsing)
```bash
agent-browser snapshot -i --json
agent-browser get text @e1 --json
agent-browser is visible @e2 --json
```

## Annotated Screenshots

Use `--annotate` to get a screenshot with numbered labels — each label `[N]` maps to ref `@eN`:

```bash
agent-browser screenshot --annotate
# Output: Screenshot saved to /tmp/screenshot-xxx.png
#   [1] @e1 button "Submit"
#   [2] @e2 link "Home"
#   [3] @e3 textbox "Email"

# Then interact by ref:
agent-browser click @e1
```

This is especially useful for visual/multimodal reasoning or when the accessibility tree is missing info.

## Sessions (multiple isolated browsers)

```bash
agent-browser --session agent1 open site-a.com
agent-browser --session agent2 open site-b.com
agent-browser session list
```

## Auth Persistence

```bash
# Persistent profile (survives restart)
agent-browser --profile ~/.browser-profile open https://app.example.com

# Session name (auto-saves cookies + localStorage)
agent-browser --session-name myapp open https://app.example.com
```

## Security Features

```bash
# Restrict to allowed domains only
agent-browser --allowed-domains "example.com,*.example.com" open example.com

# Prevent context flooding
agent-browser --max-output 10000 snapshot

# Wrap page output in safety delimiters (prevents prompt injection)
agent-browser --content-boundaries snapshot
```

## Network & Tabs

```bash
agent-browser network route "*/api/*" --abort   # block requests
agent-browser tab new https://other.com         # open new tab
agent-browser tab 2                             # switch to tab 2
agent-browser tab close                         # close current tab
```

## Setup

First-time setup (download Chromium):
```bash
npx agent-browser install
```

Check it's working:
```bash
npx agent-browser open https://example.com && npx agent-browser snapshot -i
```

## Tips for AI Agents

- **Always use refs** from `snapshot` output — they're stable and deterministic
- **Re-snapshot after interactions** — page state changes after clicks/fills
- **Use `-i` flag** on snapshot to reduce noise — only shows interactive elements
- **Use `--json`** when you need to parse output programmatically
- **Use `--content-boundaries`** when scraping untrusted pages to avoid prompt injection
- **Use `wait`** before interacting with dynamic content (SPAs, loaders)
- For login flows: fill form fields, submit, then `wait --load networkidle`

## When to Use web_fetch Instead

Use `web_fetch` for:
- Simple static HTML pages (no JS needed)
- API calls (JSON endpoints)
- Downloading files

Use `agent-browser` for:
- SPAs / React / Next.js / Vue apps
- Login flows and authenticated pages
- Form interactions
- Any page requiring JavaScript
- Visual scraping or screenshot capture
