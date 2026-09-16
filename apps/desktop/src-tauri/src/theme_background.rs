use std::fs;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};

/// Large enough for a 5K photo, small enough that a stray video file is refused.
const MAX_BYTES: usize = 25 * 1024 * 1024;

/// One image for all advanced themes, stored as the uploaded bytes. The
/// webview sniffs the format itself, so no extension is kept.
fn background_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join("theme-background"))
}

/// Takes the image as the raw request body: a JSON array of numbers would be
/// several times the size of the file and slow to parse on both sides.
#[tauri::command]
pub fn save_theme_background(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the image as raw bytes".into());
    };
    if bytes.is_empty() {
        return Err("The image is empty".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err("The image is larger than 25 MB".into());
    }
    fs::write(background_path(&app)?, bytes).map_err(|err| err.to_string())
}

/// Empty when no image was uploaded.
#[tauri::command]
pub fn load_theme_background(app: AppHandle) -> Result<Response, String> {
    let path = background_path(&app)?;
    if !path.exists() {
        return Ok(Response::new(Vec::new()));
    }
    fs::read(path).map(Response::new).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn delete_theme_background(app: AppHandle) -> Result<(), String> {
    clear_theme_background(&app)
}

pub fn clear_theme_background(app: &AppHandle) -> Result<(), String> {
    let path = background_path(app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|err| err.to_string())?;
    }
    Ok(())
}
