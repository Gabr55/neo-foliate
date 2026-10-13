use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use md5::{Digest, Md5};
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

// Foliate hashes at most this many bytes when a book has no identifier.
// Keep the same value so identifiers stay compatible with Foliate.
const IDENTIFIER_BYTES: u64 = 10_000_000;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // NEO_FOLIATE_DATA_DIR points the app at a separate library, e.g. for testing
    let dir = match std::env::var_os("NEO_FOLIATE_DATA_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => app.path().app_data_dir().map_err(err)?,
    };
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn sub_dir(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join(name);
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn key_to_file(key: &str, ext: &str) -> String {
    format!("{}.{}", urlencoding::encode(key), ext)
}

fn book_path(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    Ok(sub_dir(app, "books")?.join(key_to_file(key, "json")))
}

fn cover_path(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    Ok(sub_dir(app, "covers")?.join(key_to_file(key, "img")))
}

fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, contents).map_err(err)?;
    fs::rename(&tmp, path).map_err(err)
}

// Same layout as Foliate's `uri-store.json`: { "uris": [[key, path], ...] }
fn uri_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("uri-store.json"))
}

fn read_uris(app: &AppHandle) -> Result<Vec<(String, String)>, String> {
    let value = read_json(&uri_store_path(app)?).unwrap_or(Value::Null);
    Ok(value
        .get("uris")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|pair| {
                    let k = pair.get(0)?.as_str()?.to_string();
                    let v = pair.get(1)?.as_str()?.to_string();
                    Some((k, v))
                })
                .collect()
        })
        .unwrap_or_default())
}

fn write_uris(app: &AppHandle, uris: &[(String, String)]) -> Result<(), String> {
    let json = serde_json::json!({ "uris": uris });
    write_atomic(&uri_store_path(app)?, json.to_string().as_bytes())
}

#[tauri::command]
fn read_book(path: String) -> Result<Response, String> {
    fs::read(&path).map(Response::new).map_err(err)
}

#[tauri::command]
fn book_identifier(path: String) -> Result<String, String> {
    let file = fs::File::open(&path).map_err(err)?;
    let mut bytes = Vec::new();
    file.take(IDENTIFIER_BYTES)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    let hash = Md5::digest(&bytes);
    let hex: String = hash.iter().map(|b| format!("{:02x}", b)).collect();
    Ok(format!("foliate:{hex}"))
}

#[tauri::command]
fn data_get(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    Ok(read_json(&book_path(&app, &key)?))
}

#[tauri::command]
fn data_set(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    let text = serde_json::to_string(&value).map_err(err)?;
    write_atomic(&book_path(&app, &key)?, text.as_bytes())?;
    let _ = app.emit("library-changed", &key);
    Ok(())
}

#[tauri::command]
fn data_delete(app: AppHandle, key: String) -> Result<(), String> {
    let _ = fs::remove_file(book_path(&app, &key)?);
    let _ = fs::remove_file(cover_path(&app, &key)?);
    let uris: Vec<_> = read_uris(&app)?
        .into_iter()
        .filter(|(k, _)| k != &key)
        .collect();
    write_uris(&app, &uris)?;
    let _ = app.emit("library-changed", &key);
    Ok(())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("settings.json"))
}

#[tauri::command]
fn settings_get(app: AppHandle) -> Result<Option<Value>, String> {
    Ok(read_json(&settings_path(&app)?))
}

#[tauri::command]
fn settings_set(app: AppHandle, value: Value, source: String) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&value).map_err(err)?;
    write_atomic(&settings_path(&app)?, text.as_bytes())?;
    // `source` lets the window that saved ignore its own change
    let _ = app.emit("settings-changed", serde_json::json!({ "source": source, "value": value }));
    Ok(())
}

#[tauri::command]
fn uri_set(app: AppHandle, key: String, path: String) -> Result<(), String> {
    let mut uris: Vec<_> = read_uris(&app)?
        .into_iter()
        .filter(|(k, _)| k != &key)
        .collect();
    uris.push((key, path));
    write_uris(&app, &uris)
}

#[derive(Serialize)]
struct LibraryItem {
    key: String,
    data: Value,
    path: Option<String>,
    exists: bool,
    modified: u64,
}

#[tauri::command]
fn library_list(app: AppHandle) -> Result<Vec<LibraryItem>, String> {
    let uris = read_uris(&app)?;
    let mut items = Vec::new();
    for entry in fs::read_dir(sub_dir(&app, "books")?).map_err(err)? {
        let Ok(entry) = entry else { continue };
        let file_path = entry.path();
        if file_path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = file_path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(key) = urlencoding::decode(stem) else { continue };
        let key = key.into_owned();
        let Some(data) = read_json(&file_path) else { continue };
        let path = uris.iter().find(|(k, _)| k == &key).map(|(_, v)| v.clone());
        let exists = path.as_ref().is_some_and(|p| Path::new(p).exists());
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        items.push(LibraryItem { key, data, path, exists, modified });
    }
    Ok(items)
}

#[tauri::command]
fn cover_set(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let key = request
        .headers()
        .get("x-key")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing key")?;
    let key = urlencoding::decode(key).map_err(err)?.into_owned();
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw body".into());
    };
    write_atomic(&cover_path(&app, &key)?, bytes)
}

#[tauri::command]
fn cover_get(app: AppHandle, key: String) -> Result<Response, String> {
    Ok(Response::new(fs::read(cover_path(&app, &key)?).unwrap_or_default()))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(path, contents).map_err(err)
}

#[tauri::command]
fn open_reader(app: AppHandle, path: String) -> Result<(), String> {
    open_reader_window(&app, &path)
}

#[tauri::command]
fn show_library(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        win.show().map_err(err)?;
        return win.set_focus().map_err(err);
    }
    let builder = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .title("Neo Foliate")
        .inner_size(1000.0, 700.0)
        .min_inner_size(360.0, 300.0);
    with_platform_chrome(builder).build().map_err(err)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn with_platform_chrome<'a, R: tauri::Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
}

#[cfg(not(target_os = "macos"))]
fn with_platform_chrome<'a, R: tauri::Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
}

fn open_reader_window(app: &AppHandle, path: &str) -> Result<(), String> {
    // One window per file: focus it if it is already open
    let hash = Md5::digest(path.as_bytes());
    let label: String = std::iter::once("reader-".to_string())
        .chain(hash.iter().take(8).map(|b| format!("{:02x}", b)))
        .collect();
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.unminimize();
        return win.set_focus().map_err(err);
    }
    let title = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Neo Foliate")
        .to_string();
    let url = format!("reader.html?path={}", urlencoding::encode(path));
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(1000.0, 760.0)
        .min_inner_size(360.0, 300.0);
    with_platform_chrome(builder).build().map_err(err)?;
    Ok(())
}

fn open_paths_from_args(app: &AppHandle, args: &[String], cwd: Option<&str>) {
    for arg in args.iter().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        let mut path = PathBuf::from(arg);
        if path.is_relative() {
            if let Some(cwd) = cwd {
                path = Path::new(cwd).join(path);
            }
        }
        if path.is_file() {
            let _ = open_reader_window(app, &path.to_string_lossy());
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let before = app.webview_windows().len();
            open_paths_from_args(app, &args, Some(cwd.as_str()));
            if app.webview_windows().len() == before {
                let _ = show_library(app.clone());
            }
        }));
    }

    let app = builder
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_book,
            book_identifier,
            data_get,
            data_set,
            data_delete,
            uri_set,
            settings_get,
            settings_set,
            library_list,
            cover_set,
            cover_get,
            write_text_file,
            open_reader,
            show_library,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            show_library(handle.clone())?;
            let args: Vec<String> = std::env::args().collect();
            open_paths_from_args(&handle, &args, None);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the application");

    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &_event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    let _ = open_reader_window(_app, &path.to_string_lossy());
                }
            }
        }
    });
}
