# Neo Foliate

A macOS, Windows and Android port of **[Foliate](https://github.com/johnfactotum/foliate)**, the e-book reader by **[John Factotum](https://github.com/johnfactotum)**.

Foliate is a GTK app for Linux. Neo Foliate brings the same reading experience to macOS, Windows and Android. It reuses Foliate's rendering engine, [foliate-js](https://github.com/johnfactotum/foliate-js), unchanged, and rebuilds the rest of the interface with [Tauri](https://tauri.app). All credit for the reader itself, the rendering engine, the themes and the overall design goes to the original author. This project only adapts them to other platforms.

> Neo Foliate is an independent port. John Factotum and the Foliate project do not endorse it. Please report bugs in this port here, not upstream.

## Features

- Formats: EPUB, MOBI, KF8 (AZW3), FB2, FBZ and CBZ
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

### On Android

The interface follows phone conventions:

- Reading is full screen. Tap the left or right edge, or swipe, to turn pages. Tap the middle to show or hide the toolbars.
- Volume keys turn pages; you can switch this off in the appearance settings.
- Menus and settings open as bottom sheets. Contents, annotations and search slide in as a drawer.
- The system back button closes the open sheet or panel first, then returns from a book to the library.
- Touch and hold a book in the library for its menu. Select text with a long press to get the highlight, note, search and lookup actions.
- Open books from any file manager or browser (*Open with…* or *Share*). Imported books are copied into the app, so they keep working after the original file moves.
- Read aloud uses the system text-to-speech engine and highlights the word being spoken. If no voice is installed for the book's language, the app offers to open the speech settings.
- The screen stays on while you read, and the layout adapts to cutouts, gesture bars, tablets and landscape.

Android 8.0 or newer is required. The APK supports every CPU type (arm64, armv7, x86, x86_64).

### Compatible with Foliate data

Book data uses Foliate's JSON format (`lastLocation`, `progress`, `annotations`, `bookmarks`, `metadata`). Identifiers are computed the same way, so you can move annotations between Foliate and Neo Foliate: use *Export Annotations…* in one app and *Import Annotations…* in the other.

Data location (library, reading data and `settings.json`):

- macOS: `~/Library/Application Support/io.github.neofoliate.NeoFoliate/`
- Windows: `%APPDATA%\io.github.neofoliate.NeoFoliate\`
- Android: the app's private storage, which also holds the imported books

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

Download the `.dmg` (macOS), the `-setup.exe` (Windows) or the `.apk` (Android) from [Releases](../../releases).

The builds are not signed with an Apple or Microsoft certificate yet:

- **macOS:** the first time, right-click the app, choose *Open* and confirm. If macOS says the app is damaged, run `xattr -dr com.apple.quarantine "/Applications/Neo Foliate.app"`.
- **Windows:** if SmartScreen appears, click *More info → Run anyway*.
- **Android:** allow installing apps from your browser or file manager when Android asks.

## Building from source

Requirements: [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS. WebView2 is preinstalled on Windows 10/11.

```bash
git clone --recurse-submodules <repo-url>
cd neo-foliate
npm install
npm run dev      # run in development mode
npm run build    # build installers into src-tauri/target/release/bundle
```

### Android

Install JDK 17, the Android SDK and NDK (see the [Tauri prerequisites](https://tauri.app/start/prerequisites/#android)), and set `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME`. Then run:

```bash
npm run android:dev                                  # run on a connected device or emulator
npm run android:build -- --target aarch64 armv7 i686 x86_64   # universal release APK
```

The native side lives in `src-tauri/gen/android`. `MainActivity.kt` and `NeoBridge.kt` add the back button, volume keys, file intents, immersive mode and text-to-speech. To sign release builds locally, put a `keystore.properties` file there (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`); git ignores it.

### Testing

To try a build without touching your real library, point it at another folder:

```bash
NEO_FOLIATE_DATA_DIR=/tmp/neo-foliate-test npm run dev
```

## Releases

GitHub Actions ([`.github/workflows/build.yml`](.github/workflows/build.yml)) builds on every push and pull request:

- **macOS:** a universal `.dmg` for Apple Silicon and Intel
- **Windows x64:** an NSIS `-setup.exe` and an `.msi`
- **Android:** a universal `.apk` (arm64, armv7, x86, x86_64)

The installers are attached to each run as artifacts. To publish a release, push a version tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Android release builds are signed with a key stored in the repository's secrets. Every update must be signed with the same key: Android refuses to install an update signed with a different key, and the only way out is uninstalling, which loses the library. Keep a backup of the keystore. Add these secrets under *Settings → Secrets and variables → Actions*:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the keystore file, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password |

With the GitHub CLI logged in, `scripts/upload-android-secrets.sh path/to/keystore.properties` uploads all four.

Without these secrets, the Android job builds an unsigned APK, and tagged releases fail.

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
  android.js         bridge to the Android host (files, TTS, volume keys, insets)
  mobile.css         phone and tablet layout
src-tauri/           Rust backend: file access, storage, windows, file associations
  gen/android/       Android project (MainActivity.kt, NeoBridge.kt, manifest)
```

## Credits and license

- **Foliate** © John Factotum and contributors, GPL-3.0-or-later. Themes, reader styles, annotation export formats and the app icon come from Foliate.
- **foliate-js** © John Factotum, MIT License.
- **pdf.js** (bundled with foliate-js) © Mozilla, Apache-2.0.

Neo Foliate is a derivative work of Foliate and is distributed under the **GNU General Public License v3.0 or later**. See [LICENSE](LICENSE).

---

## По-русски

**Neo Foliate** — порт читалки [Foliate](https://github.com/johnfactotum/foliate) (автор — [John Factotum](https://github.com/johnfactotum)) на macOS, Windows и Android. Движок отображения книг foliate-js используется без изменений, интерфейс переписан на Tauri. Поддерживаются EPUB, MOBI, AZW3, FB2, CBZ и PDF; есть библиотека, темы, заметки, закладки, поиск, чтение вслух и интерфейс на русском языке. На Android — полноэкранное чтение с зонами касания и свайпами, листание кнопками громкости, нижние панели, открытие книг из других приложений. Формат данных совместим с Foliate. Лицензия — GPL-3.0-or-later.
