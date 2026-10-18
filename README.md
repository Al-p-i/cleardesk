# ClearDesk

A chat-first project workspace for [Obsidian](https://obsidian.md), powered by Claude.

Switch between your projects, talk to each one in a chat, and see its state at a glance: goal, key facts, open tasks, notes, facts and links. Everything is stored as plain markdown in your vault.

```
┌ Projects ─────────┐  ┌ Chat ─────────────────────────┐  ┌ Project ──────────┐
│ ● Desk            │  │ ▌Apartments   Updated 3h ago  │  │ Goal  Lease by …  │
│ ● Apartments  ☑ 4 │  │                               │  │ Budget  €1,400    │
│ ● Interview   ☑ 2 │  │  agency said deposit is 3x    │  │ Tasks · 4 open    │
│ ● Work: Atlas ☑ 7 │  │  ✦ Fact saved · Mitte  undo   │  │ ☐ Send payslips   │
│ + New project     │  │                               │  │ Notes  Facts Links│
│ Files (explorer)  │  │  /t  /n   Ask anything…  📎   │  │ 📌 Budget capped… │
└───────────────────┘  └───────────────────────────────┘  └───────────────────┘
```

## Features

- **Projects**: each project is a folder in your vault, with its own colour. Switch with a click or Ctrl+1…9; Ctrl+0 opens the default project (Desk). Mark projects as at risk, blocked, done or archived; done and archived ones fold away.
- **Chat as the main interface**: ask questions about the project. Claude answers with the project's tasks, notes, facts and files in mind, and streams its reply.
- **Quick capture**:
  - `/t call the agency fri`: a task, with the date understood
  - `/n kreuzberg is loud`: a note, auto-tagged
  - `/t` or `/n` alone opens a block: write several lines and close with `//`
- **Automatic filing**: facts you mention in passing are saved as AI facts, links you paste are saved with their page title, and every change gets a receipt with **undo**.
- **Project card**: your goal, plus key facts (budget, deadline, shortlist…) that Claude keeps up to date.
- **Notes feed**: your notes, AI facts and links in one list, with filters, topic tags, drag-to-reorder and pinning.
- **Attachments**: paste, drop or pick images, PDFs and text files; Claude reads them.
- **Web and Google**: Claude can search the web and read pasted links, including Google Docs, Sheets and Slides shared via link.
- **Documents**: ask for a comparison, plan or calculation and Claude writes it into the project folder, running real code for the maths.
- **File organising**: ask Claude to sort photos and files; it can list, create folders, and move or rename within the project folder only (never deleting, never overwriting, never touching `_project/`), with one-click undo.
- **Links that survive moves**: attachment links follow files that are moved or renamed in Obsidian; a fingerprint of every attached file lets ClearDesk find it again even after moves elsewhere, and a repair command (with preview) fixes older broken links.
- **Chat search** across one or all projects, with message times on hover.
- **Focused file explorer**: the explorer shows only the current project's folder (the whole vault on Desk). Toggle it with a command.
- Works on desktop and mobile; it only uses Obsidian's own APIs.

## Installation

ClearDesk isn't in the Obsidian community store yet.

1. Download `main.js`, `manifest.json` and `styles.css` from the latest [release](../../releases), or build them yourself (see below).
2. Put them in `<your vault>/.obsidian/plugins/cleardesk/`.
3. In Obsidian: **Settings → Community plugins**, turn on **ClearDesk** (refresh the list if it doesn't show).
4. **Settings → ClearDesk**: add your Anthropic API key (from [platform.claude.com](https://platform.claude.com)). `/t` and `/n` work without a key; chat needs one.

## Privacy and cost

- When you chat, the current project's content (goal, key facts, tasks, notes, recent chat, file names, and any attachments you send) goes to Anthropic's API. Nothing is sent anywhere else, except fetching titles of links you paste and Google exports of links you ask about.
- Your API key is stored in the vault's plugin data (`.obsidian/plugins/cleardesk/data.json`). Don't commit or share that file.
- API usage is billed by Anthropic. Chat uses Claude Opus 5.5 at low effort by default; `/t` and `/n` filing uses the much cheaper Claude Haiku 5.5. You can change both models in settings, and setting a spend limit on the Claude platform is a good idea.

## How it stores things

Every project is a normal folder. ClearDesk keeps its own files in a `_project/` subfolder, which is hidden in the file explorer by default:

```
APARTMENTS/
  _project/
    project.md        colour, goal, status, order, key facts (frontmatter)
    tasks.md          - [ ] Send payslips 🔗 [[source]] 📅 2026-10-20 ^t-k2j3a   (Obsidian Tasks format)
    notes.md          ### 2026-10-17 15:10 · note · Kreuzberg ^n-k3j2a  + text
    chat/2026-10.md   ### 2026-10-17 14:32 · me ^m-abc123  + message
  Attachments/        files you add in the chat
  …your documents
```

All of it is readable and editable in Obsidian. ClearDesk picks up edits you make there.

## Development

```bash
npm install
npm run build        # build/main.js, manifest.json, styles.css
npm test             # unit tests (formats, commands, search, …)
npm run test:ai      # fake-API tests of the Claude integration (no network, no cost)
npm run typecheck
```

To copy a build into a vault for testing, put the plugin folder path in `.deploy-target` (git-ignored), or set `CLEARDESK_PLUGIN_DIR`, then:

```bash
npm run deploy
```

Then reload ClearDesk in Obsidian (switch it off and on).

## License

[MIT](LICENSE)
