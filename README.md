# Neo Foliate

A macOS and Windows port of **[Foliate](https://github.com/johnfactotum/foliate)**, the e-book reader by **[John Factotum](https://github.com/johnfactotum)**.

Foliate is a GTK app for Linux. Neo Foliate brings the same reading experience to macOS and Windows. It reuses Foliate's rendering engine, [foliate-js](https://github.com/johnfactotum/foliate-js), unchanged, and rebuilds the rest of the interface with [Tauri](https://tauri.app). All credit for the reader itself, the rendering engine, the themes and the overall design goes to the original author. This project only adapts them to other platforms.

> Neo Foliate is an independent port. John Factotum and the Foliate project do not endorse it. Please report bugs in this port here, not upstream.

## Features

- Formats: EPUB, MOBI, KF8 (AZW3), FB2, FBZ, CBZ and PDF (experimental)
- Library with covers, reading progress, search and sorting, plus drag & drop import
- Paginated or scrolled layout with up to 3 columns
- Font size, font family, line spacing, margins, max width, justification and hyphenation
- Foliate's themes (Sepia, Solarized, Gruvbox, Nord…) with light and dark variants, and inverted dark mode
- Table of contents, full-text search, history (back/forward)
- Highlights in 6 colors, underline, squiggly and strikethrough, and notes
- Bookmarks
- Export annotations to Markdown, HTML or JSON, and import them from JSON
- Footnote popups
- Read aloud with system voices, highlighting each word as it is read
- Wikipedia lookup and translation of selected text
- English and Russian interface
- File associations, so you can double-click a book to open it

### Compatible with Foliate data

Book data uses Foliate's JSON format (`lastLocation`, `progress`, `annotations`, `bookmarks`, `metadata`). Identifiers are computed the same way, so you can move annotations between Foliate and Neo Foliate: use *Export Annotations…* in one app and *Import Annotations…* in the other.

Data location (library, reading data and `settings.json`):

- macOS: `~/Library/Application Support/io.github.neofoliate.NeoFoliate/`
- Windows: `%APPDATA%\io.github.neofoliate.NeoFoliate\`

Updating or reinstalling the app keeps this folder.

## Keyboard shortcuts

| Action | macOS | Windows |
| --- | --- | --- |
| Next / previous page | → ← Space PgDn PgUp | → ← Space PgDn PgUp |
| Back / forward in history | ⌘[ ⌘] or ⌥← ⌥→ | Alt+← Alt+→ |
| Find in book | ⌘F | Ctrl+F |
| Toggle bookmark | ⌘D | Ctrl+D |
| Font size / zoom | ⌘+ ⌘− ⌘0 | Ctrl+ Ctrl− Ctrl+0 |
| Sidebar | F9 or ⇧⌘S | F9 or Ctrl+Shift+S |
| Fullscreen | ⌃⌘F | F11 |
| Book info | ⌘I | Ctrl+I |
| Library | ⌘L | Ctrl+L |

## Installing

Download the `.dmg` (macOS) or the `-setup.exe` (Windows) from [Releases](../../releases).

The builds are not signed with an Apple or Microsoft certificate yet:

- **macOS:** the first time, right-click the app, choose *Open* and confirm. If macOS says the app is damaged, run `xattr -dr com.apple.quarantine "/Applications/Neo Foliate.app"`.
- **Windows:** if SmartScreen appears, click *More info → Run anyway*.

## Building from source

Requirements: [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS. WebView2 is preinstalled on Windows 10/11.

```bash
git clone --recurse-submodules <repo-url>
cd neo-foliate
npm install
npm run dev      # run in development mode
npm run build    # build installers into src-tauri/target/release/bundle
```

To try a build without touching your real library, point it at another folder:

```bash
NEO_FOLIATE_DATA_DIR=/tmp/neo-foliate-test npm run dev
```

## Releases

GitHub Actions ([`.github/workflows/build.yml`](.github/workflows/build.yml)) builds on every push and pull request:

- **macOS:** a universal `.dmg` for Apple Silicon and Intel
- **Windows x64:** an NSIS `-setup.exe` and an `.msi`

The installers are attached to each run as artifacts. To publish a release, push a version tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The workflow sets that version in `package.json`, `tauri.conf.json` and `Cargo.toml`, builds both platforms, and publishes a GitHub release with the installers and `SHA256SUMS.txt`. To update the version locally, run `node scripts/set-version.mjs 0.2.0`.

## Project layout

```
app/                 web UI (plain ES modules, no bundler)
  foliate-js/        rendering engine (git submodule, MIT)
  engine/            patched foliate-js modules, loaded via an import map
                     (paginator.js: interruptible, smoother page turns)
  library.*          library window
  reader.*           reader window
  speech.js          read aloud via the Web Speech API
scripts/             release helpers
src-tauri/           Rust backend: file access, storage, windows, file associations
```

## Credits and license

- **Foliate** © John Factotum and contributors, GPL-3.0-or-later. Themes, reader styles, annotation export formats and the app icon come from Foliate.
- **foliate-js** © John Factotum, MIT License.
- **pdf.js** (bundled with foliate-js) © Mozilla, Apache-2.0.

Neo Foliate is a derivative work of Foliate and is distributed under the **GNU General Public License v3.0 or later**. See [LICENSE](LICENSE).

---

## По-русски

**Neo Foliate** — порт читалки [Foliate](https://github.com/johnfactotum/foliate) (автор — [John Factotum](https://github.com/johnfactotum)) на macOS и Windows. Движок отображения книг foliate-js используется без изменений, интерфейс переписан на Tauri. Поддерживаются EPUB, MOBI, AZW3, FB2, CBZ и PDF; есть библиотека, темы, заметки, закладки, поиск, чтение вслух и интерфейс на русском языке. Формат данных совместим с Foliate. Лицензия — GPL-3.0-or-later.
