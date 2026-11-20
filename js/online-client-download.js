// online-client-download.js — 纯网页端「下载客户端」：识别本机 → 服务端选包 → 确认后下载
(function () {
  'use strict';
  const U = window.OnlineUI;
  if (!U || !U._) return;
  const { O, esc, toast, C } = U._;

  const OS_SHORT = {
    windows: 'Windows', android: 'Android', ios: 'iOS',
    macos: 'macOS', linux: 'Linux', chromeos: 'ChromeOS',
  };
  let busy = false;

  function nav() { return window.navigator || {}; }
  function uaText() { return String(nav().userAgent || ''); }
  function uaData() {
    const data = nav().userAgentData;
    return data && typeof data === 'object' ? data : null;
  }
  // UA-CH 高熵字段在 Safari / Firefox 不可用；拿不到就只用 UA 降级识别。
  function highEntropy() {
    const data = uaData();
    if (!data || typeof data.getHighEntropyValues !== 'function') return Promise.resolve(null);
    try {
      const out = data.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion']);
      return out && typeof out.then === 'function' ? out.catch(() => null) : Promise.resolve(null);
    } catch (e) { return Promise.resolve(null); }
  }

  function platformOf() {
    const ua = uaText();
    const data = uaData();
    const low = String((data && data.platform) || '');
    const pf = String(nav().platform || '');
    const touch = Number(nav().maxTouchPoints || 0);
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    // iPadOS 13+ 桌面模式的 UA 与 macOS 相同，只能靠触点数量区分。
    if (/Macintosh/i.test(ua) && touch > 1) return 'ios';
    if (/CrOS/i.test(ua)) return 'chromeos';
    if (/Windows/i.test(ua) || /^Win/i.test(pf) || /^Windows/i.test(low)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(ua) || /Mac/i.test(low)) return 'macos';
    if (/Linux|X11/i.test(ua) || /Linux/i.test(low)) return 'linux';
    return 'other';
  }

  function archOf(os, ua, high) {
    const h = high || {};
    const arch = String(h.architecture || '').toLowerCase();
    const bits = String(h.bitness || '');
    if (arch) {
      if (/arm/.test(arch)) return bits === '32' ? 'arm' : 'arm64';
      if (/x86/.test(arch)) {
        if (bits === '32') return 'x86';
        return os === 'android' ? 'x86_64' : 'x64';
      }
    }
    if (os === 'android') {
      if (/x86_64|x64|amd64/i.test(ua)) return 'x86_64';
      if (/aarch64|arm64|armv8/i.test(ua)) return 'arm64';
      if (/armv7|armeabi/i.test(ua)) return 'arm';
      return '';
    }
    if (/WOW64/i.test(ua)) return 'x64'; // 32 位进程跑在 64 位 Windows 上，安装包仍要 64 位版。
    if (/aarch64|arm64/i.test(ua)) return 'arm64';
    if (/x86_64|amd64|win64|x64/i.test(ua)) return 'x64';
    if (/i[3-6]86|armv7|win32/i.test(ua)) return 'x86';
    return '';
  }

  function windowsLabel(ua, high) {
    const major = parseInt(String((high && high.platformVersion) || ''), 10) || 0;
    if (major >= 13) return 'Windows 11';
    if (major === 10) return 'Windows 10';
    if (/Windows NT 6\.3/.test(ua)) return 'Windows 8.1';
    if (/Windows NT 6\.2/.test(ua)) return 'Windows 8';
    if (/Windows NT 6\.1/.test(ua)) return 'Windows 7';
    return /Windows NT 10\.0/.test(ua) ? 'Windows 10 / 11' : 'Windows';
  }

  function macLabel(high) {
    const m = /^(\d+)(?:\.(\d+))?/.exec(String((high && high.platformVersion) || ''));
    if (!m) return 'macOS';
    const major = Number(m[1]), minor = Number(m[2] || 0);
    if (major >= 11) return 'macOS ' + major + (minor ? '.' + minor : '');
    if (major === 10) return 'macOS 10.' + minor;
    return 'macOS';
  }

  function androidVersion(ua, high) {
    const m = /^(\d+)/.exec(String((high && high.platformVersion) || ''));
    if (m) return m[1];
    const hit = /Android (\d+(?:\.\d+)?)/.exec(ua);
    return hit ? hit[1] : '';
  }

  function androidModel(ua, high) {
    const hint = String((high && high.model) || '').trim();
    if (hint) return hint;
    const m = /Android [^;]+;\s*([^;)]+?)(?:\s+Build\/|\))/.exec(ua);
    const value = m ? String(m[1] || '').trim() : '';
    // UA 缩减后型号会变成占位符 K / wv；语言标签也不是型号。
    if (!value || /^(k|wv)$/i.test(value) || /^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(value)) return '';
    return value;
  }

  function iosMajorOf(ua) {
    const m = /(?:CPU (?:iPhone )?OS|CPU OS|iPhone OS) (\d+)[_.]/.exec(ua);
    if (m) return Number(m[1]) || 0;
    // iPadOS 桌面模式 UA 不带 OS 版本；Safari 的 Version/ 与系统大版本一致。
    const v = /Version\/(\d+)[.\d]*.*Safari/.exec(ua);
    return v ? Number(v[1]) || 0 : 0;
  }

  function iosDevice(ua) {
    if (/iPad/i.test(ua)) return 'iPad';
    if (/iPod/i.test(ua)) return 'iPod';
    if (/iPhone/i.test(ua)) return 'iPhone';
    return Number(nav().maxTouchPoints || 0) > 1 && /Macintosh/i.test(ua) ? 'iPad' : 'iPhone';
  }

  function browserOf(ua) {
    if (/MicroMessenger/i.test(ua)) return { name: '微信内置浏览器', embedded: true };
    if (/\bQQ\/|MQQBrowser/i.test(ua)) return { name: 'QQ 内置浏览器', embedded: true };
    const hit = (re, label) => {
      const m = re.exec(ua);
      return m ? { name: label + (m[1] ? ' ' + m[1] : ''), embedded: false } : null;
    };
    return hit(/Edg\/(\d+)/, 'Edge')
      || hit(/OPR\/(\d+)/, 'Opera')
      || hit(/SamsungBrowser\/(\d+)/, '三星浏览器')
      || hit(/Firefox\/(\d+)/, 'Firefox')
      || hit(/CriOS\/(\d+)/, 'Chrome')
      || hit(/FxiOS\/(\d+)/, 'Firefox')
      || hit(/Chrome\/(\d+)/, 'Chrome')
      || hit(/Version\/([\d.]+).*Safari/, 'Safari')
      || { name: '', embedded: false };
  }

  function archLabelOf(os, arch) {
    if (!arch) return '';
    if (os === 'android') return arch === 'x86_64' ? 'x86_64' : arch === 'arm64' ? 'arm64' : '';
    if (os === 'macos') return arch === 'arm64' ? 'Apple Silicon' : arch === 'x64' ? 'Intel' : '';
    if (arch === 'arm64') return 'ARM64';
    if (arch === 'x64') return '64 位（x64）';
    if (arch === 'x86') return '32 位（x86）';
    return '';
  }

  function enrich(os, ua, high) {
    const data = uaData();
    const browser = browserOf(ua);
    const arch = archOf(os, ua, high);
    let osLabel = '未识别的设备', model = '', kindLabel = '浏览器', iosMajor = 0;
    if (os === 'windows' || os === 'macos' || os === 'linux' || os === 'chromeos') {
      osLabel = os === 'windows' ? windowsLabel(ua, high)
        : os === 'macos' ? macLabel(high)
          : os === 'chromeos' ? 'ChromeOS' : 'Linux';
      kindLabel = '桌面浏览器';
    } else if (os === 'android') {
      const version = androidVersion(ua, high);
      osLabel = version ? 'Android ' + version : 'Android';
      model = androidModel(ua, high);
      const mobile = data && typeof data.mobile === 'boolean' ? data.mobile : /Mobile/i.test(ua);
      kindLabel = mobile ? '手机浏览器' : '平板浏览器';
    } else if (os === 'ios') {
      iosMajor = iosMajorOf(ua);
      osLabel = iosDevice(ua) + (iosMajor ? ' · iOS ' + iosMajor : '');
      kindLabel = iosDevice(ua) === 'iPad' ? '平板浏览器' : '手机浏览器';
    }
    const bits = [osLabel];
    if (model && model !== osLabel) bits.push(model);
    const archLabel = archLabelOf(os, arch);
    if (archLabel) bits.push(archLabel);
    return {
      os,
      arch,
      iosMajor,
      model,
      osLabel,
      archLabel,
      kindLabel,
      browser: browser.name,
      embedded: browser.embedded,
      label: bits.join(' · '),
    };
  }

  async function detect() {
    const os = platformOf();
    const ua = uaText();
    return enrich(os, ua, await highEntropy());
  }

  function isNativeApp() { return !!window.__TAURI_INTERNALS__ || !!window.SSDZAndroid; }
  // 只在浏览器打开的 http(s) 页面挂这个入口；安装包内已有自己的更新通道。
  function available() {
    return !isNativeApp() && /^https?:$/.test(String((window.location && location.protocol) || ''));
  }

  function shortLabel() {
    return OS_SHORT[platformOf()] || '自动';
  }

  function base() {
    const net = window.Net && typeof Net.base === 'function' ? Net.base() : '';
    return String(net || (window.location && location.origin) || '').replace(/\/+$/, '');
  }

  function fileUrl(pkg) { return base() + String((pkg && pkg.url) || ''); }
  function downloadPageUrl(info) { return base() + String((info && info.downloadPage) || '/download'); }
  function sizeText(bytes) {
    const n = Number(bytes) || 0;
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function openUrl(url) {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return;
    try {
      if (window.Main && typeof Main.openExternal === 'function') { void Main.openExternal(u); return; }
    } catch (e) {}
    try { window.open(u, '_blank', 'noopener'); } catch (e) {}
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(text)).then(
          () => toast('下载地址已复制。'),
          () => toast('请手动复制：' + text));
        return;
      }
    } catch (e) {}
    toast('请手动复制：' + text);
  }

  // 直接交给浏览器下载管理器：整包几十 MB，不走 fetch / blob（移动端内存顶不住）。
  function saveFile(url, name) {
    const doc = document;
    const a = doc.createElement('a');
    a.href = url;
    if (name) a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    try { (doc.body || doc.documentElement).appendChild(a); } catch (e) {}
    try { a.click(); } catch (e) { openUrl(url); }
    setTimeout(() => { try { if (a.parentNode) a.parentNode.removeChild(a); } catch (e) {} }, 1000);
  }

  function installHint(pkg) {
    if (pkg.platform === 'ios') return '下载后用 TrollStore / AltStore 安装；保持同一 Bundle ID（com.ssdz.online），账号与进度不会丢。';
    if (pkg.platform === 'android') return '下载后打开 APK 安装；系统可能先要求允许安装来自浏览器的应用。';
    return '下载后运行安装包（Windows 可能提示 SmartScreen，选「更多信息 → 仍要运行」）；账号与进度保存在服务器，换客户端不会丢。';
  }

  function apiQuery(device) {
    const parts = ['os=' + encodeURIComponent(device.os)];
    if (device.arch) parts.push('arch=' + encodeURIComponent(device.arch));
    if (device.iosMajor) parts.push('ios=' + encodeURIComponent(String(device.iosMajor)));
    return parts.join('&');
  }

  function dialogBody(device, info) {
    const pkg = info && info.package;
    const bits = ['<p>已识别设备：<b>' + esc(device.label) + '</b></p>'];
    const meta = [device.kindLabel, device.browser].filter(Boolean).join(' · ');
    if (meta) bits.push('<p class="small-label">' + esc(meta) + '</p>');
    if (pkg) {
      bits.push('<p>服务器当前版本 <b>v' + esc(info.version || '?') + '</b>，将下载 <b>' + esc(pkg.label) + '</b>' +
        '（' + esc(pkg.name) + (pkg.size ? '，约 ' + sizeText(pkg.size) : '') + '）。</p>');
      if (pkg.note) bits.push('<p class="small-label">' + esc(pkg.note) + '</p>');
      bits.push('<p class="small-label">' + esc(installHint(pkg)) + '</p>');
    } else {
      bits.push('<p>' + esc((info && info.message) || '服务器暂时没有适合这台设备的客户端。') + '</p>');
    }
    if (device.embedded) {
      bits.push('<p class="small-label">当前是微信 / QQ 内置浏览器，可能拦截下载；如果没反应，请点右上角在系统浏览器中打开，或复制地址。</p>');
    }
    bits.push('<p class="small-label">识别结果来自浏览器上报的系统信息；如果设备不对，可到下载页手动选包。</p>');
    return bits.join('');
  }

  function startDownload(device, info) {
    const pkg = info && info.package;
    if (!pkg || !pkg.url) return;
    saveFile(fileUrl(pkg), pkg.name);
    toast('开始下载 ' + pkg.label + '，请留意浏览器的下载提示。');
  }

  function showDialog(device, info) {
    const pkg = info && info.package;
    const buttons = [];
    if (pkg) buttons.push({ label: '确认下载', cls: 'gold', run: () => startDownload(device, info) });
    if (pkg && device.embedded) {
      buttons.push({ label: '复制地址', cls: 'muted', run: () => copyText(fileUrl(pkg)) });
    } else {
      buttons.push({ label: '打开下载页', cls: 'muted', run: () => openUrl(downloadPageUrl(info)) });
    }
    buttons.push({ label: pkg ? '取消' : '知道了', cls: 'muted' });
    const c = C();
    if (!c || typeof c.modal !== 'function') {
      if (pkg && window.confirm('已识别设备：' + device.label + '\n下载 ' + pkg.label + '（' + pkg.name + '）？')) {
        startDownload(device, info);
      } else if (!pkg) {
        openUrl(downloadPageUrl(info));
      }
      return null;
    }
    return c.modal('下载客户端', dialogBody(device, info), buttons, { small: true });
  }

  async function open() {
    if (!available()) { toast('当前已经在客户端里，不需要再下载客户端。'); return null; }
    if (busy) return null;
    busy = true;
    try {
      const device = await detect();
      let info = null;
      try {
        info = await O.get('/api/client/download?' + apiQuery(device), { auth: false, device: false, timeoutMs: 10000 });
      } catch (e) {
        toast('读取客户端下载信息失败：' + O.errText(e));
        return null;
      }
      return showDialog(device, info || {});
    } finally { busy = false; }
  }

  window.OnlineClientDownload = { available, detect, shortLabel, open };
})();
