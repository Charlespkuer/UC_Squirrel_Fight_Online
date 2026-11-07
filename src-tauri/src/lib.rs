// Online embeds its client assets. Account state is owned by the remote API;
// there is no local save server, filesystem command, or offline export bridge.
mod client_update;
mod device_identity;

#[tauri::command]
fn online_device_identity() -> Result<device_identity::DeviceIdentity, String> {
    device_identity::read()
}

/// 主人专用：下载本服最新 EXE，交给临时 cmd 等本进程退出后覆盖并重启。
/// 前端只在 /api/owner/status 返回 owner:true 时才挂这个按钮。
#[tauri::command]
async fn online_sync_client(url: String, version: String) -> Result<(), String> {
    let result = tauri::async_runtime::spawn_blocking(move || client_update::apply(&url, &version)).await;
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => Err(err),
        Err(err) => Err(format!("同步线程失败：{}", err)),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    client_update::cleanup();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![online_device_identity, online_sync_client])
        .run(tauri::generate_context!())
        .expect("failed to run Squirrel Fight Online");
}
