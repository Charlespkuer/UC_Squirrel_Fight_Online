//! 联机版「轻壳」——exe 里只有壳，页面直接读仓库里的 `js/ css/ images/`。
//!
//! 为什么要有它：完整包把 96 MiB 的前端快照编进 exe（约 67 MB），改一行 js 也要重新打包。
//! 轻壳由 `tools/build-online-app.cjs --shell` 单独编译（cargo `--features thin-shell`），
//! 接管 `tauri://` 协议、按请求从**仓库目录**读文件：改完刷新窗口（F5）就是新的，
//! 完整包仍照旧出到 `src-tauri/dist/` 给玩家。
//!
//! 为什么是「接管 tauri:// 协议」而不是单机版那种本地 HTTP 端口：
//!   · 页面来源仍是 `http://tauri.localhost` —— 与服务端 `ALLOW_ORIGIN` 白名单、令牌/设置
//!     所在的 localStorage、Tauri IPC（`__TAURI_INTERNALS__.invoke`）**全和完整包同一份**；
//!   · 换成 `127.0.0.1:<随机端口>` 就变成「远端来源」：CORS 白名单要改服务端、IPC 会被 ACL
//!     拒掉，设备指纹 / 主人同步 / 一键打包这些命令全得另开一套 HTTP 接口。
//!
//! 供哪些文件也照完整包的口径**白名单**（`build-online-app.cjs` 的 `allowed`）：
//! 只有 `js/ css/ images/ audio/ shared/` 与 `scripts/version.json`。
//! 仓库里的 `server/ src-tauri/ save/ .git/` 不会从这个协议里漏出去。
//!
//! 找不到仓库目录时（例如轻壳被单独拷走）才退回编译期嵌进来的 `empty/index.html` 提示页。

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use tauri::http::{header, Response, StatusCode};

/// 没找到游戏目录时显示的提示页：与 `empty/index.html` 同一份（编译期嵌入）。
const MISSING_PAGE: &str = include_str!("../empty/index.html");
/// 服务器地址（与 `tools/build-online-app.cjs` 用的是同一个文件）。
const API_JSON: &str = include_str!("../online-api.json");
/// 版本号取 `tauri.conf.json`，与完整包 / `app.config().version` 同口径。
const APP_JSON: &str = include_str!("../tauri.conf.json");

const TEXT: &str = "text/plain; charset=utf-8";
const HTML: &str = "text/html; charset=utf-8";
const JS: &str = "text/javascript; charset=utf-8";

/// 与 `build-online-app.cjs` 的 `allowed` 一致：完整包会打进 exe 的顶层目录。
const ALLOWED_DIRS: [&str; 5] = ["js/", "css/", "images/", "audio/", "shared/"];
/// 完整包另外会带上的单文件。
const ALLOWED_FILES: [&str; 1] = ["scripts/version.json"];

struct Ctx {
    /// 伺候哪个目录（仓库根目录，含 `scripts/index-online.html`）。
    root: PathBuf,
    /// `/online-config.js` 的内容：地址、降级地址、版本号、轻壳标记。启动时算一次。
    config: String,
}

/// 接管 `tauri://`（Windows 上是 `http://tauri.localhost`）。
///
/// Tauri 只有在没人注册 `tauri` 这个 scheme 时才会挂它自己的内嵌资源处理器
/// （`manager/webview.rs`），所以这里注册之后，页面里的每个请求都到 `serve()`。
pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    let root = find_root();
    match &root {
        Some(dir) => diag(&format!("游戏目录：{}", dir.display())),
        None => diag("没找到游戏目录（请把 exe 放回仓库根目录，或设 SSDZ_GAME_DIR）"),
    }
    let ctx = Arc::new(root.map(|root| Ctx { root, config: config_js() }));
    builder.register_uri_scheme_protocol("tauri", move |_context, request| serve(&ctx, request))
}

fn serve(ctx: &Option<Ctx>, request: tauri::http::Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = percent_decode(request.uri().path());
    let response = build(ctx, &path);
    /* 排查「改了文件但页面还是旧的」时最有用的一条：把每次请求的状态与字节数写进日志。 */
    diag(&format!("{} {} {}B", response.status().as_u16(), path, response.body().len()));
    response
}

fn build(ctx: &Option<Ctx>, path: &str) -> Response<Vec<u8>> {
    /* 地址栏是 `/`、`/index.html`、`/scripts/index-online.html` 都映射到真正的入口；
     * 页面里写的是 `<base href="/">` + `js/…`，所以 URL 必须是 `/` 这一层。 */
    let entry = matches!(path, "/" | "/index.html" | "/scripts/index-online.html");
    let ctx = match ctx {
        Some(ctx) => ctx,
        None if entry => return reply(StatusCode::OK, HTML, MISSING_PAGE.as_bytes().to_vec()),
        None => return reply(StatusCode::NOT_FOUND, TEXT, b"no game directory".to_vec()),
    };
    if path == "/online-config.js" {
        return reply(StatusCode::OK, JS, ctx.config.as_bytes().to_vec());
    }
    if entry {
        return match fs::read_to_string(ctx.root.join("scripts").join("index-online.html")) {
            Ok(text) => reply(StatusCode::OK, HTML, inject(&text).into_bytes()),
            Err(_) => reply(StatusCode::NOT_FOUND, TEXT, b"scripts/index-online.html not found".to_vec()),
        };
    }
    let rel = match assemble(path) {
        Some(rel) => rel,
        None => return reply(StatusCode::FORBIDDEN, TEXT, b"forbidden".to_vec()),
    };
    match fs::read(ctx.root.join(&rel)) {
        Ok(bytes) => reply(StatusCode::OK, mime_for(&rel), bytes),
        Err(_) => reply(StatusCode::NOT_FOUND, TEXT, b"not found".to_vec()),
    }
}

/// 把 URL 路径变成「允许相对路径」：白名单目录 + 一层层普通目录，挡掉 `..`、盘符、UNC、反斜杠。
fn assemble(path: &str) -> Option<PathBuf> {
    let rel = path.trim_start_matches('/');
    if rel.is_empty() || rel.contains(['\\', ':', '\0']) {
        return None;
    }
    if !Path::new(rel).components().all(|part| matches!(part, Component::Normal(_))) {
        return None;
    }
    if !ALLOWED_DIRS.iter().any(|prefix| rel.starts_with(prefix)) && !ALLOWED_FILES.contains(&rel) {
        return None;
    }
    Some(PathBuf::from(rel))
}

/// 入口页要带上 `online-config.js`（完整包是构建脚本写进快照的 `<head>`，这边运行时补）。
fn inject(html: &str) -> String {
    if html.contains("online-config.js") {
        return html.to_string();
    }
    html.replacen("<head>", "<head>\n<script src=\"online-config.js\"></script>", 1)
}

/// 与 `build-online-app.cjs` 写进快照的那份 `online-config.js` 同格式，
/// 多一个 `__SSDZ_ONLINE_SHELL__`：前端据此隐藏「一键同步更改」（整包替换会把轻壳换回完整包）。
fn config_js() -> String {
    let api: serde_json::Value = serde_json::from_str(API_JSON).unwrap_or(serde_json::Value::Null);
    let base = api.get("base").and_then(|v| v.as_str()).unwrap_or("").trim_end_matches('/').to_string();
    let mut fallbacks: Vec<String> = Vec::new();
    for url in derived_fallbacks(&base, &api) {
        if url != base && !fallbacks.contains(&url) {
            fallbacks.push(url);
        }
    }
    let version = serde_json::from_str::<serde_json::Value>(APP_JSON)
        .ok()
        .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(str::to_string))
        .unwrap_or_default();
    format!(
        "window.__SSDZ_ONLINE_API__ = {};\nwindow.__SSDZ_ONLINE_API_FALLBACKS__ = {};\n\
         window.__SSDZ_VERSION = {};\nwindow.__SSDZ_ONLINE_SHELL__ = true;\n",
        json(&base),
        json(&fallbacks),
        json(&version),
    )
}

/// `serde_json` 的输出就是合法的 JS 字面量（字符串 / 数组都一样）。
fn json<T: serde::Serialize>(value: T) -> String {
    serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string())
}

/// 降级地址：与 `build-online-app.cjs` 的 `deriveFallbacks()` 同一套规则
/// （没写端口就试另一个协议；443 试 http、80 试 https；再并上 `online-api.json` 的 `fallbacks`）。
fn derived_fallbacks(base: &str, api: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some((scheme, rest)) = base.split_once("://") {
        let authority = rest.split('/').next().unwrap_or(rest);
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
                (host, Some(port))
            }
            _ => (authority, None),
        };
        match port {
            None => out.push(format!("{}://{host}", other_scheme(scheme))),
            Some("443") => out.push(format!("http://{host}")),
            Some("80") => out.push(format!("https://{host}")),
            Some(_) => {}
        }
    }
    if let Some(list) = api.get("fallbacks").and_then(|v| v.as_array()) {
        for item in list.iter().filter_map(|v| v.as_str()) {
            let url = item.trim_end_matches('/');
            if url.starts_with("http://") || url.starts_with("https://") {
                out.push(url.to_string());
            }
        }
    }
    out
}

fn other_scheme(scheme: &str) -> &'static str {
    if scheme == "https:" || scheme == "https" {
        "http"
    } else {
        "https"
    }
}

/// 找「哪个目录是联机版的仓库」：必须同时有入口页、`js/net.js`、`css/online.css`。
/// 顺序与单机版外壳一致：环境变量 → 当前目录往上 → 可执行文件往上。
fn find_root() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("SSDZ_GAME_DIR") {
        if let Some(root) = walk_up(Path::new(&dir), 1) {
            return Some(root);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = walk_up(&cwd, 5) {
            return Some(root);
        }
    }
    let exe = std::env::current_exe().ok()?;
    walk_up(exe.parent()?, 6)
}

fn walk_up(start: &Path, depth: usize) -> Option<PathBuf> {
    let mut current = Some(start.to_path_buf());
    for _ in 0..depth {
        let dir = current?;
        if is_repo(&dir) {
            return Some(dir);
        }
        current = dir.parent().map(Path::to_path_buf);
    }
    None
}

fn is_repo(dir: &Path) -> bool {
    dir.join("scripts").join("index-online.html").is_file()
        && dir.join("js").join("net.js").is_file()
        && dir.join("css").join("online.css").is_file()
}

/// 诊断：设了 `SSDZ_SHELL_LOG=1` 就把「找游戏目录」的结果追加到 `%TEMP%\ssdz-online-shell.log`。
fn diag(msg: &str) {
    if std::env::var_os("SSDZ_SHELL_LOG").is_none() {
        return;
    }
    use std::io::Write as _;
    let file = std::env::temp_dir().join("ssdz-online-shell.log");
    if let Ok(mut handle) = fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(handle, "{msg}");
    }
}

fn reply(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        /* 轻壳的全部意义就是「改完立刻看到」：不让 WebView 缓存旧 js / css / 图。 */
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn mime_for(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => HTML,
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => JS,
        "json" | "webmanifest" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "mp3" => "audio/mpeg",
        "ogg" | "oga" => "audio/ogg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" | "md" => TEXT,
        _ => "application/octet-stream",
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}
