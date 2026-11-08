# Relay

A fast Windows desktop app that puts all your Gmail and Microsoft (Outlook.com,
work, school) inboxes into one unified inbox.

**Stack:** [Tauri 2](https://tauri.app) (Rust backend + system WebView2) with a
React + TypeScript UI built by Vite, styled with [Tailwind CSS v4](https://tailwindcss.com)
and standard [shadcn/ui](https://ui.shadcn.com) components (Radix base, "Nova" preset).
The app is a small native binary with low memory use. All network and storage
work happens in Rust, and the UI only reads from a local SQLite cache, so it stays
instant even offline.

## What works (first pass)

- Add any number of Gmail and Microsoft accounts (OAuth 2.0 + PKCE in your browser)
- Unified inbox across all accounts, sorted by date, with per-account color
- Views: all inboxes, by group (Personal / Work / School, editable), or per account
- Filters: All / Unread / Starred, plus instant search over loaded mail
- Read mail: HTML rendered in a locked-down sandbox (no scripts, remote
  images blocked until you allow them, links open in your browser), with inline images
- Actions sync back to the provider: mark read/unread, star (Gmail) / flag (Outlook),
  archive, delete (to Trash / Deleted Items)
- Compose, reply, reply all, and forward from the right account
- Download attachments to your Downloads folder
- Background sync every 2 minutes (configurable). Gmail uses incremental history sync.
- Keyboard shortcuts: `j`/`k` next/previous, `e` archive, `#` delete, `r` reply,
  `a` reply all, `f` forward, `c` compose, `u` toggle read, `s` star, `/` search

## Getting started

Prerequisites (Windows): Node.js 20+, Rust (stable, MSVC) and the
Visual Studio C++ Build Tools. WebView2 ships with Windows 11.

```bash
npm install
npm run app        # build + launch the desktop app (hot-reloads the UI)
```

Then follow **[docs/SETUP.md](docs/SETUP.md)** to create the Google and Microsoft
OAuth app registrations and paste their IDs into Settings.

Other scripts:

```bash
npm run dev        # UI only, in a browser, with sample data (no backend)
npm run package    # release build + Windows installer in src-tauri/target/release/bundle
cd src-tauri && cargo test   # backend unit tests
```

## Project layout

```
src/                     React UI
  App.tsx                state, actions, keyboard shortcuts, app shell (Sidebar + Resizable panes)
  components/
    ui/                  shadcn/ui components (generated; add more with `npx shadcn@latest add <name>`)
    app-sidebar.tsx      inboxes, groups, accounts, add account
    mail-list.tsx        search, All/Unread/Starred tabs, message cards
    mail-reader.tsx      toolbar, header, attachments
    email-frame.tsx      sandboxed HTML email view (no scripts, remote images opt-in)
    compose-dialog.tsx   new / reply / reply all / forward
    settings-dialog.tsx  connections, accounts, appearance (light/dark/system)
  api.ts                 typed wrappers around Tauri commands
  mock.ts                sample-data backend used by `npm run dev` in a browser
src-tauri/src/           Rust backend
  commands.rs            commands the UI invokes
  oauth.rs               loopback OAuth + PKCE, token refresh
  gmail.rs / graph.rs    Gmail API and Microsoft Graph clients
  sync.rs                background sync engine
  db.rs                  SQLite cache
  crypt.rs               DPAPI encryption for refresh tokens
  mime.rs                address parsing, outgoing message building, HTML→text
```

## Known limitations (next passes)

- Inbox only (no folder/label browsing, Sent, or Drafts yet)
- Keeps the newest N messages per account (default 100). Search covers loaded mail only.
- Sends plain text. No attachments on outgoing mail yet. Gmail forwards don't
  carry the original attachments (Outlook forwards do).
- No conversation threading in the list. Each message is its own row.
- No desktop notifications for new mail yet
- Polling sync (desktop apps can't receive provider push without a server)
