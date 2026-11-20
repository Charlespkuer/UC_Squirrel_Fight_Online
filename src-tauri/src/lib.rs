// Online embeds its client assets. Account state is owned by the remote API;
// there is no local save server, filesystem command, or offline export bridge.
mod client_update;
mod dev_build;
mod device_identity;
/* 轻壳（cargo `--features thin-shell`）：不嵌前端快照，页面直接读仓库里的 js/css/images。
 * 完整包不带这个 feature，仍然走 Tauri 自带的内嵌资源协议。 */
#[cfg(feature = "thin-shell")]
mod shell;

#[tauri::command]
fn online_device_identity() -> Result<device_identity::DeviceIdentity, String> {
    device_identity::read()
}

/// 用系统浏览器打开 http(s) 链接（iOS 下载 IPA、安卓/桌面打开下载页都走这里）。
/// 只接受 http(s)，避免前端把任意 URL scheme 交给系统。
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = url.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("只允许打开 http(s) 链接".to_string());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url.to_string(), None::<&str>)
        .map_err(|err| err.to_string())
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

/// 开发机专用：当前客户端是否就在仓库里（能本机重新打包）。
/// 设置页「开发者同步」用它决定要不要显示「一键打包并重启」。
#[tauri::command]
fn online_dev_status() -> dev_build::DevStatus {
    dev_build::status()
}

/// 开发机专用：本机重新打包客户端（前端快照 + EXE）并自动重启。
/// 只拉起 `tools/rebuild-online-client.cjs`；构建、替换与重启都在那个脚本里。
#[tauri::command]
fn online_dev_rebuild(app: tauri::AppHandle) -> Result<(), String> {
    dev_build::spawn(app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    client_update::cleanup();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            online_device_identity,
            open_external,
            online_sync_client,
            online_dev_status,
            online_dev_rebuild
        ]);
    /* 轻壳：用仓库目录里的文件接管 `tauri://`（页面来源仍是 http://tauri.localhost，
     * 所以 IPC、localStorage 与服务端 CORS 白名单都和完整包同一份）。 */
    #[cfg(feature = "thin-shell")]
    let builder = shell::register(builder);
    builder
        .run(tauri::generate_context!())
        .expect("failed to run Squirrel Fight Online");
}
