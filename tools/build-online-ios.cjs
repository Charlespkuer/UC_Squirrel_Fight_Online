#!/usr/bin/env node
'use strict';
// Online-only iOS snapshot. The paired Mac receives an isolated, allowlisted
// source tree, not this repository's server, credentials, signing keys or saves.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const remote = require('./build-ios-remote.cjs');
const ROOT = path.resolve(__dirname, '..');
const STAGE = path.join(ROOT, 'out', '_online-ios-source');
const DIST = path.join(ROOT, 'src-tauri', 'dist');
const excluded = /(?:^|\/)(?:_reference|references|\.bak-upscale|node_modules|\.git|out)(?:\/|$)|(?:\.bak|\.log|\.sqlite(?:-wal|-shm)?|\.db|\.local\.json|\.key|\.pem|\.p12|\.p8|\.mobileprovision)$/i;

function apiBase(value) {
  const base = String(value || process.env.SSDZ_ONLINE_API || JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'online-api.json'), 'utf8')).base).replace(/\/+$/, '');
  const api = new URL(base);
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.search || api.hash)
    throw new Error('iOS API must be a public HTTP(S) URL without credentials, query or fragment');
  return base;
}

function plannedSources() {
  const sources = [];
  function add(rel, optional = false) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) { if (optional) return; throw new Error('Missing iOS source: ' + rel); }
    const stat = fs.lstatSync(src);
    if (stat.isSymbolicLink()) throw new Error('Refusing symlink in iOS source: ' + rel);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(src).sort()) {
        const next = rel + '/' + name;
        if (name.startsWith('.') || /^AGENTS?\.md$/i.test(name) || excluded.test(next)) continue;
        add(next);
      }
    } else if (stat.isFile()) sources.push({ src: rel, dest: rel });
    else throw new Error('Unsupported iOS source: ' + rel);
  }
  for (const rel of ['css', 'js', 'images', 'audio', 'scripts/version.json', 'tools/build-ios.cjs',
    'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/src',
    'src-tauri/Info.ios.plist', 'src-tauri/app-icon.png', 'src-tauri/icons',
    'src-tauri/package.json', 'src-tauri/package-lock.json']) add(rel);
  for (const rel of ['src-tauri/capabilities', 'src-tauri/empty']) add(rel, true);
  for (const name of ['tauri.conf.json', 'tauri.ios.conf.json']) add('src-tauri/' + name);
  sources.push({ src: 'scripts/index-online.html', dest: 'scripts/index.html' });
  sources.push({ src: 'tools/build-online-app.cjs', dest: 'tools/build-tauri-app.cjs' });
  return sources;
}

function clearStage(stage = STAGE) {
  const resolved = path.resolve(stage), parent = path.join(ROOT, 'out');
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('_online-ios-'))
    throw new Error('Invalid Online iOS staging path');
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) throw new Error('Staging path cannot be a symlink');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

function prepareSnapshot(base, stage = STAGE) {
  const sources = plannedSources();
  clearStage(stage);
  for (const entry of sources) {
    const dest = path.join(stage, entry.dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, entry.src), dest);
  }
  // Keep the platform's established, authenticated upload allowlist intact.
  // Alias the actual Online builder; only its entry/config paths change.
  const builder = path.join(stage, 'tools', 'build-tauri-app.cjs');
  let source = fs.readFileSync(builder, 'utf8');
  function replaceOnce(from, to) {
    if (source.split(from).length !== 2) throw new Error('Online builder changed; review the iOS alias: ' + from);
    source = source.replace(from, to);
  }
  replaceOnce("JSON.parse(fs.readFileSync(path.join(TAURI, 'online-api.json'), 'utf8')).base", JSON.stringify(base));
  // The snapshot's API choice is frozen, independent of the paired Mac's shell.
  replaceOnce('process.env.SSDZ_ONLINE_API ||', '');
  replaceOnce("['js', 'css', 'audio', 'images', 'shared']", "['js', 'css', 'audio', 'images']");
  source = source.replaceAll('scripts/index-online.html', 'scripts/index.html');
  fs.writeFileSync(builder, source);
  const conf = JSON.parse(fs.readFileSync(path.join(stage, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  if (conf.identifier !== 'com.ssdz.online' || conf.mainBinaryName !== 'squirrel_fight_online')
    throw new Error('Refusing a non-Online native configuration');
  const manifest = remote.sourceManifest(stage);
  if (manifest.files.some(f => /^(server|save|shared|scripts\/sync)\//.test(f.path) || excluded.test(f.path)))
    throw new Error('Unexpected private file in iOS snapshot');
  return { stage, manifest, version: conf.version };
}

async function main(args = process.argv.slice(2)) {
  const forwarded = args.slice();
  const apiAt = forwarded.indexOf('--api');
  let override;
  if (apiAt >= 0) {
    if (!forwarded[apiAt + 1] || forwarded[apiAt + 1].startsWith('--')) throw new Error('--api requires a value');
    override = forwarded[apiAt + 1]; forwarded.splice(apiAt, 2);
  }
  const opts = remote.parseArgs(forwarded);
  if (opts.help) {
    console.log('node tools/build-online-ios.cjs [--check] [--dry-run] [--variant both|modern|legacy] [--peer mac] [--api HTTP(S)_URL]');
    console.log('Windows: isolated paired-Mac build, return Online unsigned IPAs to src-tauri/dist. macOS: build locally.');
    return;
  }
  const base = apiBase(override);
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  if (opts.version && opts.version !== conf.version) throw new Error('--version must match Online Tauri version ' + conf.version);
  if (opts.dryRun) {
    const sources = plannedSources();
    console.log('Online iOS: ' + conf.identifier + '; version ' + conf.version + '; API ' + base);
    console.log('Isolated allowlisted snapshot: ' + sources.length + ' files; no server, saves, keys or sync configuration.');
    const variants = opts.variant === 'both' ? ['modern', 'legacy'] : [opts.variant];
    for (const name of remote.expectedArtifacts(conf.version, variants)) console.log(path.join(DIST, name.replace(/^squirrel_fight_/, 'squirrel_fight_online_')));
    console.log('No network access, builds or file writes were performed.');
    return;
  }
  if (opts.check) {
    if (process.platform !== 'darwin') return remote.main(forwarded, { root: ROOT, connectionRoot: ROOT });
    const result = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-ios.cjs'), '--check'], { cwd: ROOT, stdio: 'inherit' });
    if (result.error || result.status) throw result.error || new Error('iOS toolchain check failed');
    return;
  }
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const stage = fs.mkdtempSync(path.join(ROOT, 'out', '_online-ios-'));
  try {
    const snapshot = prepareSnapshot(base, stage);
    if (process.platform !== 'darwin') {
      await remote.main(forwarded, { root: snapshot.stage, connectionRoot: ROOT, outDir: DIST, outputPrefix: 'squirrel_fight_online_' });
    } else {
      // Dependencies stay outside the upload manifest and outside the app.
      const dependencies = path.join(ROOT, 'src-tauri', 'node_modules');
      if (!fs.existsSync(dependencies)) throw new Error('Install src-tauri build dependencies first');
      fs.symlinkSync(dependencies, path.join(stage, 'src-tauri', 'node_modules'), 'dir');
      const variants = opts.variant === 'both' ? ['modern', 'legacy'] : [opts.variant];
      for (const variant of variants) {
        const result = spawnSync(process.execPath, [path.join(stage, 'tools', 'build-ios.cjs'), ...(variant === 'legacy' ? ['--legacy'] : [])], { cwd: stage, stdio: 'inherit' });
        if (result.error || result.status) throw result.error || new Error('Online iOS ' + variant + ' build failed');
        fs.mkdirSync(DIST, { recursive: true });
        const name = remote.expectedArtifacts(snapshot.version, [variant])[0];
        fs.copyFileSync(path.join(stage, 'src-tauri', 'dist', name), path.join(DIST, name.replace(/^squirrel_fight_/, 'squirrel_fight_online_')));
      }
    }
  } finally { clearStage(stage); }
}

module.exports = { apiBase, plannedSources, prepareSnapshot, clearStage, main };
if (require.main === module) main().catch(err => { console.error('[Online iOS] ' + err.message); process.exitCode = 1; });
