//! 开发机专用：设置 → 开发者同步 →「一键打包并重启」。
//!
//! 真正的构建 / 替换 / 重启逻辑在 `tools/rebuild-online-client.cjs`（Node）：
//! 这里只负责确认当前客户端就在仓库里、把脚本拉到一个新的控制台窗口，然后让客户端退出，
//! 把根目录的 exe 让给新包。普通玩家的客户端不在开发目录，`status()` 会报 `ok:false`，
//! 前端据此隐藏按钮 —— 不会给所有人多出一颗能执行本机命令的键。

#[cfg(target_os = "windows")]
use std::path::{Path, PathBuf};

#[derive(serde::Serialize)]
pub struct DevStatus {
    pub ok: bool,
    pub root: String,
    pub reason: String,
}

#[cfg(target_os = "windows")]
fn running_target() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("找不到当前客户端路径：{}", e))?;
    /* 「一键同步更改」会把运行中的 exe 改名成 `.old.exe` 再放新包；
     * 这时候 current_exe() 指的是那个备份名，真正的替换目标仍是同目录的原名。 */
    let name = exe.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if name == "squirrel_fight_online.old.exe" {
        if let Some(dir) = exe.parent() {
            return Ok(dir.join("squirrel_fight_online.exe"));
        }
    }
    Ok(exe)
}

#[cfg(target_os = "windows")]
fn repo_root(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start.to_path_buf());
    for _ in 0..4 {
        let current = dir?;
        if current.join("tools").join("build-online-app.cjs").is_file()
            && current.join("scripts").join("index-online.html").is_file()
        {
            return Some(current);
        }
        dir = current.parent().map(Path::to_path_buf);
    }
    None
}

pub fn status() -> DevStatus {
    #[cfg(target_os = "windows")]
    {
        let found = running_target()
            .ok()
            .and_then(|exe| exe.parent().and_then(repo_root));
        match found {
            Some(root) => DevStatus {
                ok: true,
                root: root.to_string_lossy().into_owned(),
                reason: String::new(),
            },
            None => DevStatus {
                ok: false,
                root: String::new(),
                reason: "当前客户端不在开发目录（找不到 tools/build-online-app.cjs）".to_string(),
            },
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        DevStatus {
            ok: false,
            root: String::new(),
            reason: "只有 Windows 开发机支持本机打包".to_string(),
        }
    }
}

/// 拉起重建脚本；成功启动后让客户端自己退出，脚本会在构建完成后重新打开新包。
pub fn spawn(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        /* CREATE_NEW_CONSOLE：构建日志单独一个窗口；子进程独立于客户端，
         * 客户端退出后它继续跑完构建并重启新包。 */
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        let exe = running_target()
            .map_err(|e| format!("{}（当前客户端不在开发目录，无法本机打包）", e))?;
        let root = exe
            .parent()
            .and_then(repo_root)
            .ok_or_else(|| "当前客户端不在开发目录（找不到 tools/build-online-app.cjs），无法本机打包".to_string())?;
        let script = root.join("tools").join("rebuild-online-client.cjs");
        if !script.is_file() {
            return Err("缺少 tools/rebuild-online-client.cjs，无法本机打包".to_string());
        }
        std::process::Command::new("node")
            .arg(&script)
            .arg("--target")
            .arg(&exe)
            .current_dir(&root)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| format!("启动打包脚本失败（确认已安装 Node 并加入 PATH）：{}", e))?;
        /* 先把结果回给前端（toast 能显示），再把客户端退出，把 exe 让给新包。 */
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(700));
            app.exit(0);
        });
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("只有 Windows 开发机支持本机打包".to_string())
    }
}
