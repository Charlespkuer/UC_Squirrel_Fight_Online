'use strict';
// server/db.js — SQLite（node:sqlite）建表/迁移/事务
// 一次性建全表；`PRAGMA user_version` 记迁移版本，后续只追加。

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');

const SCHEMA_VERSION = 21;

let db = null;
const stmtCache = new Map();

const SCHEMA = [
  `PRAGMA journal_mode = WAL`,
  `PRAGMA foreign_keys = ON`,
  `PRAGMA synchronous = NORMAL`,

  `CREATE TABLE IF NOT EXISTS accounts (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     name          TEXT    NOT NULL,
     tag           TEXT    NOT NULL,
     pass_hash     TEXT    NOT NULL,
     pass_salt     TEXT    NOT NULL,
     recovery_hash TEXT    NOT NULL,
     created_at    INTEGER NOT NULL,
     last_seen     INTEGER NOT NULL DEFAULT 0,
     banned        INTEGER NOT NULL DEFAULT 0,
     ban_reason    TEXT    NOT NULL DEFAULT '',
     device        TEXT    NOT NULL DEFAULT '',
     ip            TEXT    NOT NULL DEFAULT '',

     reg_ip            TEXT NOT NULL DEFAULT '',
     reg_device_hash   TEXT NOT NULL DEFAULT '',
     reg_platform      TEXT NOT NULL DEFAULT '',
     reg_provider      TEXT NOT NULL DEFAULT '',
     reg_at            INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_name_tag ON accounts (name, tag)`,
  `CREATE INDEX IF NOT EXISTS ix_accounts_name ON accounts (name)`,

  `CREATE TABLE IF NOT EXISTS random_refresh_state (
     account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
     refresh_no INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS random_refresh_exclusions (
     account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     opponent_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     through_refresh INTEGER NOT NULL,
     PRIMARY KEY(account_id, opponent_id)
   )`,


  `CREATE TABLE IF NOT EXISTS simulated_accounts (
     account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
     note TEXT NOT NULL DEFAULT ''
   )`,


  `CREATE TABLE IF NOT EXISTS dev_accounts (
     account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
     label      TEXT    NOT NULL DEFAULT '',
     note       TEXT    NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   )`,

  // 临时隐身：hidden_until 到点自动失效；影响其他玩家看到的天梯/公开匹配，不改存档、天梯分数与社交关系。
  `CREATE TABLE IF NOT EXISTS hidden_accounts (
     account_id   INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
     hidden_until INTEGER NOT NULL,
     reason       TEXT    NOT NULL DEFAULT '',
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_hidden_until ON hidden_accounts(hidden_until)`,

  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT    PRIMARY KEY,
     account_id INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     last_seen  INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     ua         TEXT    NOT NULL DEFAULT '',
     ip         TEXT    NOT NULL DEFAULT '',
     device_hash TEXT   NOT NULL DEFAULT '',
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS ix_sessions_account ON sessions (account_id)`,


  `CREATE TABLE IF NOT EXISTS session_kicks (
     token_hash TEXT PRIMARY KEY,
     account_id INTEGER NOT NULL,
     reason     TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS ix_session_kicks_time ON session_kicks(created_at)`,

  `CREATE TABLE IF NOT EXISTS account_devices (
     device_hash TEXT NOT NULL,
     account_id INTEGER NOT NULL,
     platform TEXT NOT NULL,
     provider TEXT NOT NULL,
     weak INTEGER NOT NULL DEFAULT 0,
     bound_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     last_ip TEXT NOT NULL DEFAULT '',
     PRIMARY KEY (device_hash, account_id),
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS ix_devices_account ON account_devices(account_id)`,
  `CREATE INDEX IF NOT EXISTS ix_devices_device ON account_devices(device_hash)`,
  `CREATE TABLE IF NOT EXISTS account_ips (
     account_id INTEGER NOT NULL,
     ip TEXT NOT NULL,
     first_seen INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     logins INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (account_id, ip),
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS ix_account_ips_ip ON account_ips(ip, last_seen)`,
  `CREATE TABLE IF NOT EXISTS security_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     event TEXT NOT NULL,
     outcome TEXT NOT NULL,
     account_id INTEGER,
     device_hash TEXT NOT NULL DEFAULT '',
     ip TEXT NOT NULL DEFAULT '',
     reason TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_security_time ON security_events(created_at)`,
  `CREATE INDEX IF NOT EXISTS ix_security_ip ON security_events(ip, created_at)`,

  // 服务器权威存档：一人一份（联机版只有 classic 槽）。
  `CREATE TABLE IF NOT EXISTS saves (
     account_id INTEGER NOT NULL,
     mode       TEXT    NOT NULL DEFAULT 'classic',
     revision   INTEGER NOT NULL DEFAULT 1,
     payload    BLOB    NOT NULL,
     level      INTEGER NOT NULL DEFAULT 1,
     name       TEXT    NOT NULL DEFAULT '',
     power      INTEGER NOT NULL DEFAULT 0,
     agility    INTEGER NOT NULL DEFAULT 0,
     speed      INTEGER NOT NULL DEFAULT 0,
     hp         INTEGER NOT NULL DEFAULT 0,
     gold       INTEGER NOT NULL DEFAULT 0,
     gold_cup   INTEGER NOT NULL DEFAULT 0,
     integral   INTEGER NOT NULL DEFAULT 0,
     vip_level  INTEGER NOT NULL DEFAULT 0,
     vip_until  INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, mode),
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
   )`,

  // 每级战斗快照：升级时落一条，同级换装写新 revision；只读战斗字段。
  `CREATE TABLE IF NOT EXISTS battle_snapshots (
     id         TEXT    PRIMARY KEY,
     account_id INTEGER NOT NULL,
     mode       TEXT    NOT NULL DEFAULT 'classic',
     level      INTEGER NOT NULL,
     revision   INTEGER NOT NULL DEFAULT 1,
     is_current INTEGER NOT NULL DEFAULT 0,
     json       BLOB    NOT NULL,
     summary    TEXT    NOT NULL DEFAULT '',
     source     TEXT    NOT NULL DEFAULT 'levelup',
     created_at INTEGER NOT NULL,
     UNIQUE (account_id, mode, level, revision),
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS ix_snap_level ON battle_snapshots (mode, level, is_current)`,
  `CREATE INDEX IF NOT EXISTS ix_snap_account ON battle_snapshots (account_id, mode, level)`,

  `CREATE TABLE IF NOT EXISTS ratings (
     account_id INTEGER NOT NULL,
     season     TEXT    NOT NULL,
     score      INTEGER NOT NULL,
     wins       INTEGER NOT NULL DEFAULT 0,
     losses     INTEGER NOT NULL DEFAULT 0,
     streak     INTEGER NOT NULL DEFAULT 0,
     best_rank  INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, season),
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS ix_ratings_season_score ON ratings (season, score DESC)`,

  `CREATE TABLE IF NOT EXISTS combats (
     id           TEXT    PRIMARY KEY,
     idem_key     TEXT,
     kind         TEXT    NOT NULL DEFAULT 'rank',
     season       TEXT    NOT NULL,
     attacker_id  INTEGER NOT NULL,
     defender_id  INTEGER NOT NULL DEFAULT 0,
     snapshot_id  TEXT    NOT NULL DEFAULT '',
     seed         INTEGER NOT NULL,
     result       BLOB    NOT NULL,

     repro        BLOB,
     hash         TEXT    NOT NULL,
     sim_version  TEXT    NOT NULL DEFAULT '',
     winner       INTEGER NOT NULL,
     settlement   TEXT    NOT NULL DEFAULT '{}',
     attacker_rev INTEGER NOT NULL DEFAULT 0,
     defender_rev INTEGER NOT NULL DEFAULT 0,
     created_at   INTEGER NOT NULL,
     ack_at       INTEGER,
     defender_ack_at INTEGER
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_combats_idem ON combats (idem_key) WHERE idem_key IS NOT NULL AND idem_key <> ''`,
  `CREATE INDEX IF NOT EXISTS ix_combats_attacker ON combats (attacker_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_combats_defender ON combats (defender_id, created_at DESC)`,

  // 战后四选一：奖池只在服务器保存；领取状态不依赖录像保留数量。
  `CREATE TABLE IF NOT EXISTS combat_chests (
     combat_id TEXT PRIMARY KEY,
     account_id INTEGER NOT NULL,
     kind TEXT NOT NULL,
     prizes BLOB NOT NULL,
     picked INTEGER,
     created_at INTEGER NOT NULL,
     claimed_at INTEGER,
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS ix_combat_chests_pending ON combat_chests (account_id, claimed_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS combat_pickups (
     combat_id TEXT NOT NULL, account_id INTEGER NOT NULL, pickup_index INTEGER NOT NULL,
     claimed_at INTEGER NOT NULL, ups BLOB, PRIMARY KEY (combat_id, pickup_index),
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
   )`,

  `CREATE TABLE IF NOT EXISTS messages (
     id          TEXT    PRIMARY KEY,
     account_id  INTEGER NOT NULL,
     kind        TEXT    NOT NULL,
     combat_id   TEXT    NOT NULL DEFAULT '',
     from_id     INTEGER NOT NULL DEFAULT 0,
     from_name   TEXT    NOT NULL DEFAULT '',
     text        TEXT    NOT NULL,
     payload     TEXT    NOT NULL DEFAULT '{}',
     read_at     INTEGER,
     created_at  INTEGER NOT NULL,
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS ix_messages_account ON messages (account_id, created_at DESC)`,


  `CREATE TABLE IF NOT EXISTS notice_seen (
     account_id       INTEGER PRIMARY KEY,
     requests_seen_at INTEGER NOT NULL DEFAULT 0,
     updated_at       INTEGER NOT NULL DEFAULT 0,
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
   )`,

  `CREATE TABLE IF NOT EXISTS admin_broadcasts (
     id TEXT PRIMARY KEY, digest TEXT NOT NULL, created_at INTEGER NOT NULL,
     recipients INTEGER NOT NULL, payload TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS friendships (
     account_id INTEGER NOT NULL,
     friend_id  INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, friend_id),
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
   )`,


  `CREATE TABLE IF NOT EXISTS friend_requests (
     id         TEXT    PRIMARY KEY,
     from_id    INTEGER NOT NULL,
     to_id      INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (from_id, to_id),
     FOREIGN KEY (from_id) REFERENCES accounts(id) ON DELETE CASCADE,
     FOREIGN KEY (to_id)   REFERENCES accounts(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS ix_friend_requests_to ON friend_requests (to_id, created_at DESC)`,


  `CREATE TABLE IF NOT EXISTS daily_counts (
     account_id INTEGER NOT NULL,
     kind       TEXT    NOT NULL,
     date       TEXT    NOT NULL,
     count      INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (account_id, kind, date),
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
   )`,


  `CREATE TABLE IF NOT EXISTS account_daily_actions (
     ip         TEXT    NOT NULL,
     date       TEXT    NOT NULL,
     action     TEXT    NOT NULL,
     count      INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (ip, date, action)
   )`,
  `CREATE INDEX IF NOT EXISTS ix_account_daily_actions_date ON account_daily_actions(date)`,

  // 每一条服务端动作都记账，只追加；出问题能回放。
  `CREATE TABLE IF NOT EXISTS action_log (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     account_id INTEGER NOT NULL,
     name       TEXT    NOT NULL,
     args       TEXT    NOT NULL DEFAULT '[]',
     rev_before INTEGER NOT NULL DEFAULT 0,
     rev_after  INTEGER NOT NULL DEFAULT 0,
     ok         INTEGER NOT NULL DEFAULT 0,
     msg        TEXT    NOT NULL DEFAULT '',
     ip         TEXT    NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_action_log_account ON action_log (account_id, created_at DESC)`,


  `CREATE TABLE IF NOT EXISTS campaign_rooms (
     id         TEXT    PRIMARY KEY,
     code       TEXT    NOT NULL,
     boss_id    INTEGER NOT NULL,
     boss_level INTEGER NOT NULL,
     status     TEXT    NOT NULL DEFAULT 'waiting',
     mode       TEXT    NOT NULL DEFAULT 'real',
     host_id    INTEGER NOT NULL,
     combat_ids TEXT    NOT NULL DEFAULT '[]',
     seats_json TEXT    NOT NULL DEFAULT '[]',
     roll_json  TEXT    NOT NULL DEFAULT '',
     team_result TEXT   NOT NULL DEFAULT '',
     boss_max_hp INTEGER NOT NULL DEFAULT 0,
     boss_hp     INTEGER NOT NULL DEFAULT 0,
     failed_reason TEXT NOT NULL DEFAULT '',
     resolve_at  INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     start_at   INTEGER NOT NULL DEFAULT 0,
     closed_at  INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS ix_campaign_code ON campaign_rooms (code, status)`,

  `CREATE TABLE IF NOT EXISTS campaign_members (
     room_id     TEXT    NOT NULL,
     account_id  INTEGER NOT NULL,
     seat        INTEGER NOT NULL,
     snapshot_id TEXT    NOT NULL DEFAULT '',
     joined_at   INTEGER NOT NULL,
     dice        INTEGER NOT NULL DEFAULT -1,
     reward      TEXT    NOT NULL DEFAULT '{}',
     acked       INTEGER NOT NULL DEFAULT 0,
     missed      INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (room_id, account_id),
     FOREIGN KEY (room_id) REFERENCES campaign_rooms(id) ON DELETE CASCADE
   )`,

  // 师徒：真实账号关系（师傅可查徒弟成长，徒弟日贡由服务端结算）。
  `CREATE TABLE IF NOT EXISTS apprenticeships (
     prentice_id       INTEGER PRIMARY KEY,
     master_id         INTEGER NOT NULL DEFAULT 0,
     master_kind       TEXT    NOT NULL DEFAULT 'account',
     master_json       TEXT    NOT NULL DEFAULT '',
     since             INTEGER NOT NULL,
     since_date        TEXT    NOT NULL DEFAULT '',
     status            TEXT    NOT NULL DEFAULT 'active',
     last_tribute_date TEXT    NOT NULL DEFAULT '',
     FOREIGN KEY (prentice_id) REFERENCES accounts(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS ix_apprentice_master ON apprenticeships (master_id, status)`,


  `CREATE TABLE IF NOT EXISTS apprentice_cheers (
     prentice_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
     stat        TEXT    NOT NULL CHECK(stat IN ('power','agility','speed')),
     created_at  INTEGER NOT NULL
   )`,


  `CREATE TABLE IF NOT EXISTS rank_awards (
     account_id INTEGER NOT NULL,
     week       TEXT    NOT NULL,
     rank       INTEGER NOT NULL,
     cups       INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, week)
   )`,

  // 服务端键值（目前只存天梯最近一次周结算的周标识；`meta` 通用，后续可复用）。
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,


  `CREATE TABLE IF NOT EXISTS rank_bots (
     id         TEXT    PRIMARY KEY,
     division   TEXT    NOT NULL,
     level      INTEGER NOT NULL,
     idx        INTEGER NOT NULL,
     name       TEXT    NOT NULL,
     week       TEXT    NOT NULL DEFAULT '',
     score      INTEGER NOT NULL DEFAULT 300,
     wins       INTEGER NOT NULL DEFAULT 0,
     losses     INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_rank_bots_week ON rank_bots (week, division, score DESC)`,


  `CREATE TABLE IF NOT EXISTS friend_messages (
     id         TEXT    PRIMARY KEY,
     to_id      INTEGER NOT NULL,
     from_id    INTEGER NOT NULL,
     from_name  TEXT    NOT NULL DEFAULT '',
     text       TEXT    NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_friend_messages_to ON friend_messages (to_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS forum_posts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     author_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     request_key TEXT NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(author_id, request_key)
   )`,
  `CREATE INDEX IF NOT EXISTS ix_forum_posts_updated ON forum_posts (updated_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS forum_replies (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     post_id INTEGER NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
     author_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     request_key TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE(author_id, request_key)
   )`,
  `CREATE INDEX IF NOT EXISTS ix_forum_replies_post ON forum_replies (post_id, id)`,


  `CREATE TABLE IF NOT EXISTS forum_admins (
     account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
     role       TEXT    NOT NULL DEFAULT 'admin',
     created_at INTEGER NOT NULL,
     created_by INTEGER NOT NULL DEFAULT 0,
     note       TEXT    NOT NULL DEFAULT ''
   )`,
  // 违禁词：match_key 是归一化后的唯一键（去空白/标点/零宽、全角转半角）。
  `CREATE TABLE IF NOT EXISTS forum_banned_words (
     match_key  TEXT    PRIMARY KEY,
     word       TEXT    NOT NULL,
     category   TEXT    NOT NULL DEFAULT '其他',
     note       TEXT    NOT NULL DEFAULT '',
     created_by INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS forum_admin_log (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     actor_id    INTEGER NOT NULL,
     action      TEXT    NOT NULL,
     target_type TEXT    NOT NULL DEFAULT '',
     target_id   TEXT    NOT NULL DEFAULT '',
     detail      TEXT    NOT NULL DEFAULT '',
     created_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_forum_admin_log_created ON forum_admin_log (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_forum_posts_created ON forum_posts (created_at)`,
  `CREATE INDEX IF NOT EXISTS ix_forum_posts_author ON forum_posts (author_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_forum_replies_author ON forum_replies (author_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS player_ids (
     player_id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(player_id >= 100000),
     account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS ai_friends (
     id TEXT PRIMARY KEY,
     account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     request_key TEXT NOT NULL,
     fighter TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE(account_id, request_key)
   )`,
  `CREATE INDEX IF NOT EXISTS ix_ai_friends_owner ON ai_friends(account_id, created_at DESC)`,


  `CREATE INDEX IF NOT EXISTS ix_combats_created ON combats(created_at)`,
  `CREATE INDEX IF NOT EXISTS ix_action_log_created ON action_log(created_at)`,
  `CREATE INDEX IF NOT EXISTS ix_messages_created ON messages(created_at)`,
  `CREATE INDEX IF NOT EXISTS ix_daily_counts_date ON daily_counts(date)`,
  `CREATE INDEX IF NOT EXISTS ix_combat_chests_created ON combat_chests(created_at)`,
  `CREATE INDEX IF NOT EXISTS ix_combat_pickups_claimed ON combat_pickups(claimed_at)`,
  `CREATE INDEX IF NOT EXISTS ix_friend_messages_created ON friend_messages(created_at)`,
  `CREATE INDEX IF NOT EXISTS ix_friend_requests_created ON friend_requests(created_at)`,
  `CREATE INDEX IF NOT EXISTS ix_campaign_rooms_closed ON campaign_rooms(status, closed_at)`,
  `CREATE INDEX IF NOT EXISTS ix_account_ips_seen ON account_ips(last_seen)`,
];

function open(opts) {
  if (db) return db;
  const dir = (opts && opts.dir) || config.dataDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = (opts && opts.file) || path.join(dir, 'ssdz.db');
  db = new DatabaseSync(file);
  for (const sql of SCHEMA) db.exec(sql);
  migrate();
  return db;
}

function migrate() {
  const row = db.prepare('PRAGMA user_version').get();
  const version = Number(row && (row.user_version ?? Object.values(row)[0])) || 0;
  if (version >= SCHEMA_VERSION) return;
  tx(() => {
    const columns = db.prepare('PRAGMA table_info(sessions)').all();
    if (!columns.some(c => c.name === 'device_hash')) db.exec("ALTER TABLE sessions ADD COLUMN device_hash TEXT NOT NULL DEFAULT ''");
    if (version < 5) db.exec("UPDATE accounts SET device = ''");
    if (version < 6) {
      const rows = db.prepare('SELECT id FROM accounts ORDER BY created_at,id').all();
      let next = 100000;
      for (const account of rows) db.prepare('INSERT OR IGNORE INTO player_ids(player_id,account_id) VALUES (?,?)').run(next++, account.id);
      const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='player_ids'").get();
      if (!seq) db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES ('player_ids',99999)").run();
      else if (Number(seq.seq) < 99999) db.prepare("UPDATE sqlite_sequence SET seq=99999 WHERE name='player_ids'").run();
    }
    if (version < 7) migrateV7();
    if (version < 8) migrateV8();
    if (version < 9) migrateV9();
    if (version < 10) migrateV10();
    if (version < 11) migrateV11();
    if (version < 12) migrateV12();
    if (version < 13) migrateV13();
    if (version < 14) migrateV14();
    if (version < 15) migrateV15();
    if (version < 16) migrateV16();
    if (version < 17) migrateV17();
    if (version < 18) migrateV18();
    if (version < 19) migrateV19();
    if (version < 20) migrateV20();
    if (version < 21) migrateV21();
    db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
  });
}

function migrateV7() {
  const cols = db.prepare('PRAGMA table_info(apprenticeships)').all();
  if (!cols.some((c) => c.name === 'master_kind')) {
    db.exec(`CREATE TABLE apprenticeships_v7 (
       prentice_id       INTEGER PRIMARY KEY,
       master_id         INTEGER NOT NULL DEFAULT 0,
       master_kind       TEXT    NOT NULL DEFAULT 'account',
       master_json       TEXT    NOT NULL DEFAULT '',
       since             INTEGER NOT NULL,
       since_date        TEXT    NOT NULL DEFAULT '',
       status            TEXT    NOT NULL DEFAULT 'active',
       last_tribute_date TEXT    NOT NULL DEFAULT '',
       FOREIGN KEY (prentice_id) REFERENCES accounts(id) ON DELETE CASCADE
     )`);
    db.exec(`INSERT INTO apprenticeships_v7 (prentice_id, master_id, master_kind, master_json, since, since_date, status, last_tribute_date)
             SELECT prentice_id, master_id, 'account', '', since, '', status, '' FROM apprenticeships`);
    db.exec('DROP TABLE apprenticeships');
    db.exec('ALTER TABLE apprenticeships_v7 RENAME TO apprenticeships');
    db.exec('CREATE INDEX IF NOT EXISTS ix_apprentice_master ON apprenticeships (master_id, status)');
  }

  db.exec('UPDATE ratings SET score = 0 WHERE score = 1500 AND wins = 0 AND losses = 0');
  const rows = db.prepare('SELECT account_id, payload FROM saves').all();
  for (const row of rows) {
    let save = null;
    try { save = JSON.parse(Buffer.from(row.payload).toString('utf8')); } catch (_) { continue; }
    if (!save || Number(save.integral) !== 1500) continue;
    const rating = db.prepare('SELECT wins, losses FROM ratings WHERE account_id = ?').get(row.account_id);
    if (rating && Number(rating.wins) + Number(rating.losses) > 0) continue;
    save.integral = 0;
    db.prepare('UPDATE saves SET payload = ?, integral = 0 WHERE account_id = ?')
      .run(Buffer.from(JSON.stringify(save), 'utf8'), row.account_id);
  }
}

function migrateV8() {
  const saveIntegral = (accountId, integral) => {
    const row = db.prepare('SELECT payload FROM saves WHERE account_id = ? AND mode = ?').get(Number(accountId), 'classic');
    if (!row) return;
    let save = null;
    try { save = JSON.parse(Buffer.from(row.payload).toString('utf8')); } catch (_) { return; }
    if (!save || typeof save !== 'object') return;
    save.integral = integral;
    db.prepare('UPDATE saves SET payload = ?, integral = ? WHERE account_id = ? AND mode = ?')
      .run(Buffer.from(JSON.stringify(save), 'utf8'), integral, Number(accountId), 'classic');
  };
  const mine = db.prepare('SELECT account_id FROM player_ids WHERE player_id = 100000').get();
  if (mine) {
    // 所有赛季一起改：否则下次换季滚动会把旧赛季的 1500 再折算回来。
    db.prepare('UPDATE ratings SET score = 0 WHERE account_id = ?').run(Number(mine.account_id));
    saveIntegral(mine.account_id, 0);
  }
  const sims = db.prepare(
    `SELECT sa.account_id FROM simulated_accounts sa
     WHERE EXISTS (SELECT 1 FROM ratings r WHERE r.account_id = sa.account_id)`
  ).all();
  for (const sim of sims) {
    db.prepare('UPDATE ratings SET score = 1000 WHERE account_id = ?').run(Number(sim.account_id));
    saveIntegral(sim.account_id, 1000);
  }
}

// 当前天梯周（周一，Asia/Shanghai）。db.js 不能 require settlement（会循环依赖），
function currentRankWeek(nowMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date(nowMs || Date.now()));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const y = Number(get('year')), m = Number(get('month')), d = Number(get('day'));
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[get('weekday')] || 1;
  const base = Date.UTC(y, m - 1, d) - (dow - 1) * 86400000;
  const dt = new Date(base);
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}

// v9：天梯改为「赛区 + 周结算 + 赛区人机」。
// · `rank_bots` 由 SCHEMA 建表，人机行在 `settlement.ensureBots()` 里按周懒生成；
function migrateV9() {
  const week = currentRankWeek();
  const rows = db.prepare('SELECT account_id, season, score FROM ratings WHERE LENGTH(season) = 7 ORDER BY account_id, season DESC').all();
  const has = db.prepare('SELECT 1 AS x FROM ratings WHERE account_id = ? AND season = ?');
  const insert = db.prepare('INSERT INTO ratings (account_id, season, score, wins, losses, streak, best_rank, updated_at) VALUES (?,?,?,0,0,0,0,?)');
  const del = db.prepare('DELETE FROM ratings WHERE account_id = ? AND season = ?');
  for (const row of rows) {
    if (!has.get(row.account_id, week)) insert.run(row.account_id, week, Math.max(0, Number(row.score) || 0), Date.now());
    del.run(row.account_id, row.season);
  }
}

function migrateV10() {}

function migrateV11() {
  db.exec('DROP TABLE IF EXISTS rank_refresh_exclusions');
  db.exec('DROP TABLE IF EXISTS rank_refresh_state');
}

function migrateV12() {
  const cols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => String(c.name));
  const add = (name, ddl) => { if (!cols.includes(name)) db.exec('ALTER TABLE accounts ADD COLUMN ' + ddl); };
  add('reg_ip', "reg_ip TEXT NOT NULL DEFAULT ''");
  add('reg_device_hash', "reg_device_hash TEXT NOT NULL DEFAULT ''");
  add('reg_platform', "reg_platform TEXT NOT NULL DEFAULT ''");
  add('reg_provider', "reg_provider TEXT NOT NULL DEFAULT ''");
  add('reg_at', 'reg_at INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE accounts SET reg_at = created_at WHERE reg_at = 0');
  db.exec(`UPDATE accounts SET
    reg_ip = COALESCE((SELECT ip FROM account_ips a
                        WHERE a.account_id = accounts.id AND a.ip <> ''
                        ORDER BY a.first_seen ASC LIMIT 1), ip, '')
    WHERE reg_ip = ''`);
  db.exec(`UPDATE accounts SET
    reg_device_hash = COALESCE((SELECT d.device_hash FROM account_devices d
                                 WHERE d.account_id = accounts.id
                                 ORDER BY d.bound_at ASC LIMIT 1), ''),
    reg_platform = COALESCE((SELECT d.platform FROM account_devices d
                              WHERE d.account_id = accounts.id
                              ORDER BY d.bound_at ASC LIMIT 1), ''),
    reg_provider = COALESCE((SELECT d.provider FROM account_devices d
                              WHERE d.account_id = accounts.id
                              ORDER BY d.bound_at ASC LIMIT 1), '')
    WHERE reg_device_hash = ''`);
}

function migrateV13() {
  const cols = db.prepare('PRAGMA table_info(combats)').all().map((c) => String(c.name));
  if (!cols.includes('repro')) db.exec('ALTER TABLE combats ADD COLUMN repro BLOB');
}

// v14：征战异步化。房间补 mode/resolve_at/四个座位/队伍结果/共享 BOSS 血量；
// 统一按“从建立时间起 5 分钟”补上，避免升级后立刻被判超时。
function migrateV14() {
  const add = (table, name, ddl) => {
    const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => String(c.name));
    if (!cols.includes(name)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl);
  };
  add('campaign_rooms', 'mode', "mode TEXT NOT NULL DEFAULT 'real'");
  add('campaign_rooms', 'seats_json', "seats_json TEXT NOT NULL DEFAULT '[]'");
  add('campaign_rooms', 'team_result', "team_result TEXT NOT NULL DEFAULT ''");
  add('campaign_rooms', 'boss_max_hp', 'boss_max_hp INTEGER NOT NULL DEFAULT 0');
  add('campaign_rooms', 'boss_hp', 'boss_hp INTEGER NOT NULL DEFAULT 0');
  add('campaign_rooms', 'failed_reason', "failed_reason TEXT NOT NULL DEFAULT ''");
  add('campaign_rooms', 'resolve_at', 'resolve_at INTEGER NOT NULL DEFAULT 0');
  add('campaign_members', 'missed', 'missed INTEGER NOT NULL DEFAULT 0');
  db.exec("UPDATE campaign_rooms SET resolve_at = created_at + 300000 WHERE status = 'waiting' AND resolve_at = 0");
}

// v15：征战分奖页（原版 3437 第 5 帧 / `campaignRollMc`）要复算每一份奖品的
// 客户端回落到文字结果。
function migrateV15() {
  const cols = db.prepare('PRAGMA table_info(campaign_rooms)').all().map((c) => String(c.name));
  if (!cols.includes('roll_json')) db.exec("ALTER TABLE campaign_rooms ADD COLUMN roll_json TEXT NOT NULL DEFAULT ''");
}

// v16：`account_devices` 从「一设备一账号」改成「一设备最多 3 账号」的复合主键；
// 旧表按 device_hash 唯一，必须重建才能容纳同一设备的多个账号。
function migrateV16() {
  const cols = db.prepare('PRAGMA table_info(account_devices)').all();
  const pk = cols.filter((c) => Number(c.pk) > 0).map((c) => String(c.name)).sort();
  if (!(pk.length === 2 && pk[0] === 'account_id' && pk[1] === 'device_hash')) {
    db.exec(`CREATE TABLE account_devices_v16 (
       device_hash TEXT NOT NULL,
       account_id INTEGER NOT NULL,
       platform TEXT NOT NULL,
       provider TEXT NOT NULL,
       weak INTEGER NOT NULL DEFAULT 0,
       bound_at INTEGER NOT NULL,
       last_seen INTEGER NOT NULL,
       last_ip TEXT NOT NULL DEFAULT '',
       PRIMARY KEY (device_hash, account_id),
       FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
     )`);
    db.exec(`INSERT OR IGNORE INTO account_devices_v16
       (device_hash, account_id, platform, provider, weak, bound_at, last_seen, last_ip)
       SELECT device_hash, account_id, platform, provider, weak, bound_at, last_seen, last_ip
       FROM account_devices`);
    db.exec('DROP TABLE account_devices');
    db.exec('ALTER TABLE account_devices_v16 RENAME TO account_devices');
    db.exec('CREATE INDEX IF NOT EXISTS ix_devices_account ON account_devices(account_id)');
    db.exec('CREATE INDEX IF NOT EXISTS ix_devices_device ON account_devices(device_hash)');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS session_kicks (
     token_hash TEXT PRIMARY KEY,
     account_id INTEGER NOT NULL,
     reason     TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
   )`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_session_kicks_time ON session_kicks(created_at)');
}

// v17：论坛管理（管理员 / 违禁词 / 管理日志）。
// 创始管理员由 `server/game/forum.js` 的 bootstrap() 幂等种入，不在迁移里写死。
function migrateV17() {}

function migrateV18() {}

function migrateV19() {}

// v20：超级松鼠等级要按账号实时显示（随机/好友名单不读战斗快照），
// 把 payload.vip 的等级与到期时间摊成列，列表查询不再逐份 decode 整包存档。
function migrateV20() {
  const cols = db.prepare('PRAGMA table_info(saves)').all().map((c) => String(c.name));
  if (!cols.includes('vip_level')) db.exec('ALTER TABLE saves ADD COLUMN vip_level INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('vip_until')) db.exec('ALTER TABLE saves ADD COLUMN vip_until INTEGER NOT NULL DEFAULT 0');
  const rows = db.prepare('SELECT account_id, mode, payload FROM saves');
  const update = db.prepare('UPDATE saves SET vip_level = ?, vip_until = ? WHERE account_id = ? AND mode = ?');
  for (const row of rows.iterate()) {
    let save = null;
    try { save = JSON.parse(Buffer.from(row.payload).toString('utf8')); } catch (_) { continue; }
    const v = save && save.vip && typeof save.vip === 'object' ? save.vip : {};
    const level = Math.max(0, Math.min(10, Math.floor(Number(v.level) || 0)));
    const until = Math.max(0, Math.floor(Number(v.until) || 0));
    update.run(level, until, row.account_id, row.mode);
  }
}

function migrateV21() {
  // hidden_accounts 由 SCHEMA 的 CREATE TABLE IF NOT EXISTS 建好；这里只占版本位。
}

function handle() {
  if (!db) open();
  return db;
}
function prepare(sql) {
  let st = stmtCache.get(sql);
  if (!st) {
    st = handle().prepare(sql);
    stmtCache.set(sql, st);
  }
  return st;
}

function get(sql, ...params) { return prepare(sql).get(...params); }
function all(sql, ...params) { return prepare(sql).all(...params); }
function run(sql, ...params) { return prepare(sql).run(...params); }

let txDepth = 0;
// 同步事务。`fn` 里不能有 await（node:sqlite 是同步 API）。
function tx(fn) {
  const h = handle();
  if (txDepth > 0) { txDepth++; try { return fn(); } finally { txDepth--; } }
  h.exec('BEGIN IMMEDIATE');
  txDepth = 1;
  try {
    const out = fn();
    h.exec('COMMIT');
    return out;
  } catch (e) {
    try { h.exec('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    txDepth = 0;
  }
}

function close() {
  if (!db) return;
  stmtCache.clear();
  db.close();
  db = null;
}

// 生成一份一致性备份：SQLite 的 VACUUM INTO 会读取当前已提交快照，
function backupTo(file) {
  if (!db) open();
  const target = String(file).replace(/'/g, "''");
  db.exec("VACUUM INTO '" + target + "'");
}

module.exports = { open, close, handle, get, all, run, tx, backupTo, SCHEMA_VERSION };
