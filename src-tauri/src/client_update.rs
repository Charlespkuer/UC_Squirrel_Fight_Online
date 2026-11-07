//! 主人专用的「一键同步更改」下载器。
//!
//! 下载到**同目录**的 `squirrel_fight_online.new.exe`，校验 MZ 头与体积后：
//!   1. 把正在运行的旧 exe 改名成 `.old.exe`（Windows 允许重命名运行中的 exe）；
//!   2. 把新文件复制回原路径；
//!   3. 退出前拉起一个临时 cmd，等本进程退出、WebView2 数据目录释放后重启。
//!
//! 关键点：替换发生在**退出之前**。即使负责重启的 cmd 被父进程的 job 收走，
//! 磁盘上的 `squirrel_fight_online.exe` 也已经是新版本，下一次打开一定生效。

#[cfg(target_os = "windows")]
mod imp {
    use std::fs;
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// 服务器地址固定成部署时的 5896 入口；换地址时这里和 online-api.json 一起改。
    const ALLOWED_HOST: &str = "140.143.142.110:5896";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const OLD_NAME: &str = "squirrel_fight_online.old.exe";
    const NEW_NAME: &str = "squirrel_fight_online.new.exe";

    fn validate_url(url: &str) -> Result<(), String> {
        let rest = url
            .strip_prefix("http://")
            .ok_or_else(|| "同步地址必须是本服的 http 下载地址".to_string())?;
        let (host, path) = rest
            .split_once('/')
            .ok_or_else(|| "同步地址缺少下载路径".to_string())?;
        if host != ALLOWED_HOST {
            return Err("同步地址不是本服".to_string());
        }
        if !path.starts_with("download/") || !path.ends_with(".exe") {
            return Err("同步地址必须指向下载目录里的 exe".to_string());
        }
        if path.contains("..") || path.contains('?') || path.contains('#') || path.contains('"')
            || path.contains('\'') || path.contains('\\') || path.contains(' ')
        {
            return Err("同步地址包含不允许的字符".to_string());
        }
        Ok(())
    }

    fn safe_version(version: &str) -> Result<String, String> {
        if version.is_empty() || version.len() > 32
            || !version.bytes().all(|b| b.is_ascii_digit() || b == b'.' || b == b'-' || b == b'_')
        {
            return Err("版本号格式不正确".to_string());
        }
        Ok(version.to_string())
    }

    fn hide(cmd: &mut Command) {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    /// 优先用 Windows 自带的 curl.exe；老系统没有就退回 PowerShell。
    fn download(url: &str, out: &Path) -> Result<(), String> {
        let _ = fs::remove_file(out);
        let mut curl = Command::new("curl.exe");
        curl.args([
            "-fsSL",
            "--retry",
            "2",
            "--connect-timeout",
            "20",
            "--max-time",
            "900",
            "-o",
        ])
        .arg(out)
        .arg(url);
        hide(&mut curl);
        match curl.status() {
            Ok(status) if status.success() => return Ok(()),
            Ok(status) => return Err(format!("下载失败（curl 退出码 {}）", status.code().unwrap_or(-1))),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("启动 curl 失败：{}", err)),
        }

        let script = format!(
            "Invoke-WebRequest -UseBasicParsing -Uri '{}' -OutFile '{}'",
            url.replace('\'', "''"),
            out.to_string_lossy().replace('\'', "''")
        );
        let mut ps = Command::new("powershell.exe");
        ps.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        hide(&mut ps);
        match ps.status() {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!("下载失败（PowerShell 退出码 {}）", status.code().unwrap_or(-1))),
            Err(err) => Err(format!("启动 PowerShell 失败：{}", err)),
        }
    }

    fn verify(path: &Path) -> Result<(), String> {
        let meta = fs::metadata(path).map_err(|e| format!("下载文件不存在：{}", e))?;
        if meta.len() < 1_000_000 {
            return Err(format!("下载文件太小（{} 字节），不像客户端", meta.len()));
        }
        let mut f = fs::File::open(path).map_err(|e| format!("打开下载文件失败：{}", e))?;
        let mut magic = [0u8; 2];
        f.read_exact(&mut magic)
            .map_err(|e| format!("读取下载文件头失败：{}", e))?;
        if &magic != b"MZ" {
            return Err("下载文件不是 Windows 可执行文件".to_string());
        }
        Ok(())
    }

    /// 启动时清理上一次同步留下的旧包 / 半成品；不会删正在运行的自己。
    pub fn cleanup() {
        let target = match std::env::current_exe() {
            Ok(path) => path,
            Err(_) => return,
        };
        let dir = match target.parent() {
            Some(dir) => dir,
            None => return,
        };
        for name in [OLD_NAME, NEW_NAME] {
            let path = dir.join(name);
            if path != target {
                let _ = fs::remove_file(path);
            }
        }
    }

    pub fn apply(url: &str, version: &str) -> Result<(), String> {
        validate_url(url)?;
        let version = safe_version(version)?;
        let target = std::env::current_exe().map_err(|e| format!("找不到当前客户端路径：{}", e))?;
        let parent = target
            .parent()
            .ok_or_else(|| "当前客户端路径没有父目录".to_string())?;
        // 先确认目录可写，免得下完 76 MB 才发现 Program Files 不让覆盖。
        let probe = parent.join(format!(".ssdz-sync-probe-{}", std::process::id()));
        fs::write(&probe, b"probe")
            .map_err(|_| "当前客户端目录不可写，请用「下载页」手动更新".to_string())?;
        let _ = fs::remove_file(&probe);

        let staged: PathBuf = parent.join(NEW_NAME);
        let old: PathBuf = parent.join(OLD_NAME);
        let _ = fs::remove_file(&staged);
        let _ = fs::remove_file(&old);
        download(url, &staged)?;
        verify(&staged)?;

        /* 先改名再复制：Windows 允许重命名正在运行的 exe，但不允许覆盖它。
         * 复制失败时把旧文件名改回去，当前进程和磁盘都保持原样。 */
        fs::rename(&target, &old).map_err(|e| format!("无法替换旧客户端（改名失败：{}）", e))?;
        if let Err(e) = fs::copy(&staged, &target) {
            let _ = fs::rename(&old, &target);
            let _ = fs::remove_file(&staged);
            return Err(format!("无法写入新客户端：{}", e));
        }
        let _ = fs::remove_file(&staged);

        /* 磁盘上的 target 已经是新版本。当前进程继续用旧句柄跑完这一局，
         * 下次双击打开自然是新版；由 JS 明确提示「重新打开后生效」。 */
        let _ = version;
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub fn cleanup() {}

    pub fn apply(_url: &str, _version: &str) -> Result<(), String> {
        Err("当前平台不支持自动替换客户端，请用下载页更新".to_string())
    }
}

pub use imp::{apply, cleanup};
