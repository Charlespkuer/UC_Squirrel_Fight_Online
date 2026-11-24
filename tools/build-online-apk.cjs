#!/usr/bin/env node
'use strict';
// Online-only Android builder. Never installs, touches offline targets, or copies account data.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..'), TAURI = path.join(ROOT, 'src-tauri');
const ANDROID = path.join(TAURI, 'gen', 'android');
const SDK = process.env.ANDROID_HOME || 'E:\\Android\\sdk';
const JDK = process.env.JAVA_HOME || 'E:\\Android\\jdk-17.0.20.1+1';
const NDK = process.env.NDK_HOME || path.join(SDK, 'ndk', '27.0.12077973');
const env = { ...process.env, JAVA_HOME: JDK, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK,
  NDK_HOME: NDK, CARGO_TARGET_DIR: path.join(TAURI, 'target'), CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '4',
  PATH: [path.join(os.homedir(), '.cargo', 'bin'), path.join(JDK, 'bin'), process.env.PATH].join(path.delimiter) };
function run(cmd, args, cwd = ROOT, options = {}) {
  const result = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw result.error || new Error(path.basename(cmd) + ' failed: ' + result.status);
  return result;
}
function batch(file, args, cwd = ROOT, options = {}) {
  return run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', file, ...args], cwd, options);
}
const apiArgs = process.argv.slice(2);
/* 目标 ABI：默认 arm64（正式包）；`SSDZ_ONLINE_ABI=x86_64` 出模拟器测试包
 * （本机 Android 模拟器都是 x86_64 镜像，装不了 arm64-only 的正式包）。 */
const ABI = String(process.env.SSDZ_ONLINE_ABI || 'arm64').toLowerCase();
const ABI_PROFILES = {
  arm64: { rust: 'aarch64-linux-android', tauri: 'aarch64', jni: 'arm64-v8a', task: 'assembleArm64Release', out: 'arm64', label: 'arm64' },
  x86_64: { rust: 'x86_64-linux-android', tauri: 'x86_64', jni: 'x86_64', task: 'assembleX86_64Release', out: 'x86_64', label: 'x86_64' },
};
const PROFILE = ABI_PROFILES[ABI];
if (!PROFILE) throw new Error('Unsupported SSDZ_ONLINE_ABI=' + ABI + '（支持 arm64 / x86_64）');
run(process.execPath, [path.join(ROOT, 'tools', 'build-online-app.cjs'), '--web', ...apiArgs]);
const cli = path.join(TAURI, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
if (!fs.existsSync(cli)) throw new Error('Install Online CLI first: cd src-tauri && npm install');
if (!fs.existsSync(path.join(ANDROID, 'gradlew.bat'))) run(process.execPath, [cli, 'android', 'init', '--ci'], TAURI);
const so = path.join(TAURI, 'target', PROFILE.rust, 'release', 'libssdz_online_lib.so');
const started = Date.now();
const built = spawnSync(process.execPath, [cli, 'android', 'build', '--apk', '--target', PROFILE.tauri, '--ci'],
  { cwd: TAURI, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const output = String(built.stdout || '') + String(built.stderr || '');
process.stdout.write(output);
if (built.error) throw built.error;
if (built.status !== 0) {
  // Windows without Developer Mode may reject only Tauri's final JNI symlink.
  const denied = /(?:symbolic link|symlink|符号链接|1314|privilege)/i.test(output);
  const fresh = fs.existsSync(so) && fs.statSync(so).mtimeMs >= started - 2000;
  if (!denied || !fresh) throw new Error('Rust/Tauri failed; refusing to package a stale Online library');
}
/* `.so` 的 ELF / 16 KB 对齐只验一次：等打完包对**最终 APK** 里那个 .so 验（见文件末尾的
 * `check-android-package pending`）。以前这里先验一遍裸 .so、末尾又验一遍包里的同一份，
 * 同一事实查两次没有意义。 */
const jniRoot = path.join(ANDROID, 'app', 'src', 'main', 'jniLibs');
/* 只留本次目标 ABI：以前打过 x86_64 测试包后，正式 arm64 包会把两个 .so 一起打进去（包体翻倍）。 */
if (fs.existsSync(jniRoot)) {
  for (const dir of fs.readdirSync(jniRoot)) {
    if (dir !== PROFILE.jni) fs.rmSync(path.join(jniRoot, dir), { recursive: true, force: true, maxRetries: 3 });
  }
}
const jni = path.join(jniRoot, PROFILE.jni);
fs.mkdirSync(jni, { recursive: true });
const jniSo = path.join(jni, 'libssdz_online_lib.so');
if (fs.existsSync(jniSo) && fs.lstatSync(jniSo).isSymbolicLink()) fs.unlinkSync(jniSo);
fs.copyFileSync(so, jniSo);
const kotlin = path.join(ANDROID, 'app', 'src', 'main', 'java', 'com', 'ssdz', 'online');
fs.copyFileSync(path.join(TAURI, 'android', 'MainActivity.kt'), path.join(kotlin, 'MainActivity.kt'));
/* `gen/android` 由 Tauri 生成、不进仓库：系统深色模式下 DayNight 主题会触发 WebView
 * 自动压暗，经典 UI 的米色/金色会变成暗褐/墨绿。构建时统一改成固定浅色主题。 */
for (const rel of ['values/themes.xml', 'values-night/themes.xml']) {
  const file = path.join(ANDROID, 'app', 'src', 'main', 'res', rel);
  if (!fs.existsSync(file)) continue;
  let theme = fs.readFileSync(file, 'utf8')
    .replace(/parent="Theme\.MaterialComponents\.DayNight\.NoActionBar"/g, 'parent="Theme.MaterialComponents.Light.NoActionBar"');
  if (!theme.includes('android:forceDarkAllowed')) {
    theme = theme.replace('</style>', '        <item name="android:forceDarkAllowed">false</item>\n    </style>');
  }
  fs.writeFileSync(file, theme);
}
const manifest = path.join(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml');
let xml = fs.readFileSync(manifest, 'utf8');
if (!xml.includes('android:screenOrientation=')) xml = xml.replace('android:name=".MainActivity"', 'android:name=".MainActivity"\n            android:screenOrientation="sensorLandscape"');
if (!xml.includes('android:networkSecurityConfig=')) xml = xml.replace('android:usesCleartextTraffic=', 'android:networkSecurityConfig="@xml/online_network_security"\n        android:usesCleartextTraffic=');
// Android 8+ 允许应用拉起 APK 安装器；用户仍需在系统里允许「安装未知应用」。
if (!xml.includes('android.permission.REQUEST_INSTALL_PACKAGES')) {
  xml = xml.replace('<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />');
}
fs.writeFileSync(manifest, xml);
const apiBase = JSON.parse(fs.readFileSync(path.join(TAURI, 'web-stamp.json'), 'utf8')).api;
// The web client probes its public fallbacks too; permit only their HTTP hosts.
const configText = fs.readFileSync(path.join(TAURI, 'web', 'online-config.js'), 'utf8');
const fallbackMatch = configText.match(/^window\.__SSDZ_ONLINE_API_FALLBACKS__ = (\[.*\]);$/m);
const fallbackBases = fallbackMatch ? JSON.parse(fallbackMatch[1]) : [];
const httpHosts = [...new Set([apiBase, ...fallbackBases].map(base => new URL(base))
  .filter(url => url.protocol === 'http:').map(url => url.hostname))];
const netConfig = '<network-security-config><base-config cleartextTrafficPermitted="false"/>' +
  (httpHosts.length ? '<domain-config cleartextTrafficPermitted="true">' + httpHosts.map(host =>
    '<domain includeSubdomains="false">' + host + '</domain>').join('') + '</domain-config>' : '') + '</network-security-config>\n';
const resXml = path.join(ANDROID, 'app', 'src', 'main', 'res', 'xml'); fs.mkdirSync(resXml, { recursive: true });
fs.writeFileSync(path.join(resXml, 'online_network_security.xml'), netConfig);
const gradle = path.join(ANDROID, 'app', 'build.gradle.kts');
let gradleText = fs.readFileSync(gradle, 'utf8').replace(/isMinifyEnabled = true/g, 'isMinifyEnabled = false');
gradleText = gradleText.replace(/manifestPlaceholders\["usesCleartextTraffic"\] = "(?:false|true)"/g,
  'manifestPlaceholders["usesCleartextTraffic"] = "' + (httpHosts.length > 0) + '"');
fs.writeFileSync(gradle, gradleText);
fs.writeFileSync(path.join(ANDROID, 'app', 'src', 'main', 'res', 'values', 'strings.xml'),
  '<resources><string name="app_name">松鼠大战 Online</string><string name="main_activity_title">松鼠大战 Online</string></resources>\n');
/* Android 自适应图标把 108dp 图层裁到中央 72dp；全出血前景会切掉松鼠。
 * app-icon-android-fg.png 是 app-icon.png 的 60/108 预缩图，旧版图标由清单留边。 */
const iconOut = path.join(TAURI, 'target', 'android-icons');
fs.rmSync(iconOut, { recursive: true, force: true, maxRetries: 3 });
run(process.execPath, [cli, 'icon', 'app-icon.json', '--output', iconOut], TAURI);
fs.cpSync(path.join(iconOut, 'android'), path.join(ANDROID, 'app', 'src', 'main', 'res'), { recursive: true });
const buildTask = path.join(ANDROID, 'buildSrc', 'src', 'main', 'java', 'com', 'ssdz', 'online', 'kotlin', 'BuildTask.kt');
let task = fs.readFileSync(buildTask, 'utf8');
const prebuiltLine = 'if (File(project.projectDir, "src/main/jniLibs/" + (if (target == "aarch64") "arm64-v8a" else target) + "/libssdz_online_lib.so").isFile) return';
if (task.includes('Online prebuilt JNI')) {
  /* 旧补丁只认 aarch64；换成按 target 取 ABI 目录，x86_64 测试包也能跳过重复的 Rust 编译。 */
  task = task.replace(/if \(target == "aarch64" [^\n]*libssdz_online_lib\.so"\)\.isFile\) return/, prebuiltLine);
} else {
  task = task.replace('fun assemble() {', 'fun assemble() {\n        // Online prebuilt JNI was compiled and ELF-checked immediately before Gradle.\n        ' + prebuiltLine + '\n');
}
fs.writeFileSync(buildTask, task);
// Only the Rust library embeds the web snapshot; no second copy under assets/.
const cliVersion = JSON.parse(fs.readFileSync(path.join(TAURI, 'tauri.conf.json'), 'utf8')).version;
fs.writeFileSync(path.join(ANDROID, 'app', 'tauri.properties'), 'tauri.android.versionName=' + cliVersion + '\ntauri.android.versionCode=' +
  cliVersion.split('.').reduce((n, v) => n * 1000 + Number(v), 0) + '\n');
batch('gradlew.bat', [PROFILE.task, '--console=plain'], ANDROID);
const unsigned = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', PROFILE.out, 'release',
  'app-' + PROFILE.out + '-release-unsigned.apk');
if (!fs.existsSync(unsigned)) throw new Error('Unsigned Online APK missing');
const bt = fs.readdirSync(path.join(SDK, 'build-tools')).sort((a,b) => b.localeCompare(a, undefined, { numeric: true }))[0];
const tools = path.join(SDK, 'build-tools', bt), dist = path.join(TAURI, 'dist'); fs.mkdirSync(dist, { recursive: true });
const aligned = path.join(dist, 'online-aligned-unsigned.apk');
const pending = path.join(dist, 'online-pending.apk');
const apk = path.join(dist, 'squirrel_fight_online-' + cliVersion + '-' + PROFILE.label + '.apk');
run(path.join(tools, 'zipalign.exe'), ['-P', '16', '-f', '4', unsigned, aligned]);
const keys = path.join(TAURI, 'keys'); fs.mkdirSync(keys, { recursive: true });
const secret = path.join(keys, 'signing.local.json'), keystore = path.join(keys, 'online-release.jks');
if (!fs.existsSync(secret)) fs.writeFileSync(secret, JSON.stringify({ password: crypto.randomBytes(32).toString('base64url') }) + '\n');
env.SSDZ_ONLINE_KEY_PASS = JSON.parse(fs.readFileSync(secret, 'utf8')).password;
if (!fs.existsSync(keystore)) run(path.join(JDK, 'bin', 'keytool.exe'), ['-genkeypair', '-keystore', keystore,
  '-storepass:env', 'SSDZ_ONLINE_KEY_PASS', '-keypass:env', 'SSDZ_ONLINE_KEY_PASS', '-alias', 'ssdz-online',
  '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Squirrel Fight Online']);
batch(path.join(tools, 'apksigner.bat'), ['sign', '--ks', keystore, '--ks-pass', 'env:SSDZ_ONLINE_KEY_PASS',
  '--ks-key-alias', 'ssdz-online', '--key-pass', 'env:SSDZ_ONLINE_KEY_PASS', '--v1-signing-enabled', 'true',
  '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true', '--out', pending, aligned]);
const sig = batch(path.join(tools, 'apksigner.bat'), ['verify', '--min-sdk-version', '23', '--verbose', pending], ROOT,
  { stdio: 'pipe', encoding: 'utf8' });
for (const version of [1, 2, 3]) if (!new RegExp('Verified using v' + version + ' scheme[^\\r\\n]*: true').test(sig.stdout))
  throw new Error('Online APK missing required v' + version + ' signature');
console.log('PASS Online APK signatures v1/v2/v3');
run(path.join(tools, 'zipalign.exe'), ['-c', '-P', '16', '4', pending]);
run(process.execPath, [path.join(ROOT, 'tools', 'check-android-package.cjs'), pending]);
const badging = run(path.join(tools, 'aapt2.exe'), ['dump', 'badging', pending], ROOT, { stdio: 'pipe', encoding: 'utf8' }).stdout;
const versionCode = cliVersion.split('.').reduce((n, v) => n * 1000 + Number(v), 0);
if (!badging.includes("package: name='com.ssdz.online'") || !badging.includes("versionName='" + cliVersion + "'")
    || !badging.includes("versionCode='" + versionCode + "'") || !/(?:minSdkVersion|sdkVersion):'24'/i.test(badging)
    || !badging.includes("native-code: '" + PROFILE.jni + "'"))
  throw new Error('Online APK package, version, minimum SDK, or ABI mismatch');
if (/uses-permission:.*(?:WRITE_EXTERNAL_STORAGE|READ_EXTERNAL_STORAGE)/.test(badging))
  throw new Error('Online APK unexpectedly requests offline storage permissions');
console.log('PASS Online Android identity, version, SDK24+, ' + PROFILE.label + ' and permissions');
fs.unlinkSync(aligned);
/* 不再在打完包后 spawn 一次 `--web --check`：那会把 96 MB 源码再读一遍、再算一遍快照指纹；
 * 本函数开头已经 `--web` 暂存过，构建期间的源码变化不是发布门禁要重复查的事。
 * 需要单独核对已有快照时手动跑 `node tools/build-online-app.cjs --check`（一次）。 */
fs.copyFileSync(pending, apk); fs.unlinkSync(pending);
/* 发布物保留策略：dist 只留当前版本（同版本两个 ABI 一起留），见 tools/prune-dist.cjs。 */
try { require('./prune-dist.cjs').prune({ keep: 1 }); } catch (e) { console.warn('[prune-dist] ' + (e && e.message)); }
console.log('Online ' + PROFILE.label + ' APK ready (not installed): ' + apk);
