pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_zoom(1.25);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![wait_for_oauth_callback, show_in_folder])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Opens the system file manager with the given file selected (cross-platform).
#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let normalized = path.replace('/', "\\");
        std::process::Command::new("explorer")
            .args(["/select,", &normalized])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        // Open the parent folder; most Linux file managers don't support file selection
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Binds a one-shot local HTTP server on port 14523, waits for Discord's
/// OAuth redirect, sends a "you can close this tab" page, and returns the
/// request path (e.g. "/?code=XXX") to the frontend.
#[tauri::command]
async fn wait_for_oauth_callback() -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:14523").await.map_err(|e| e.to_string())?;
    let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;

    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buf[..n]).to_string();

    let html = concat!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n",
        "<!DOCTYPE html><html><body style='font-family:sans-serif;text-align:center;margin-top:80px'>",
        "<h2>Authorization complete!</h2>",
        "<p>You can close this tab and return to Slippi Ranked Stats.</p>",
        "</body></html>"
    );
    let _ = stream.write_all(html.as_bytes()).await;

    let first_line = request.lines().next().unwrap_or("").to_string();
    let path = first_line.split_whitespace().nth(1).unwrap_or("").to_string();
    Ok(path)
}
