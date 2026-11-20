'use strict';
// server/account-quota.js — 同一 IP 的注册 / 注销每日次数
// 再尝试会被禁止。这里把「注册」和「注销」分开计数（各 5 次/日），

const db = require('./db');
const { config, localDate } = require('./config');
const { fail } = require('./http');

const ACTIONS = new Set(['register', 'delete']);
const LABEL = { register: '注册', delete: '注销' };

function limit() {
  return Math.max(0, Math.floor(Number(config.accountDailyLimit) || 0));
}

function dayOf(nowMs) {
  // 不走 `localDate()` 的 1 秒缓存：每日额度要严格按当前时刻换日。
  return localDate(nowMs == null ? Date.now() : nowMs);
}

function usedOf(ip, action, date) {
  if (!ip || !ACTIONS.has(action)) return 0;
  const row = db.get('SELECT count FROM account_daily_actions WHERE ip = ? AND date = ? AND action = ?',
    String(ip), String(date), String(action));
  return Math.max(0, Math.floor(Number(row && row.count) || 0));
}

function status(ip, nowMs) {
  const date = dayOf(nowMs);
  const cap = limit();
  const register = usedOf(ip, 'register', date);
  const del = usedOf(ip, 'delete', date);
  return { date, limit: cap, register, delete: del,
    registerLeft: cap > 0 ? Math.max(0, cap - register) : 0,
    deleteLeft: cap > 0 ? Math.max(0, cap - del) : 0 };
}

// 发动作前先问：今天这个 IP 的这个动作还能不能做。超限抛 429。
function assertAllowed(ip, action, opts) {
  const o = opts || {};
  if (!ip || limit() <= 0) return status(ip, o.nowMs);
  if (!ACTIONS.has(action)) throw new Error('未知的账号额度动作：' + action);
  const date = dayOf(o.nowMs);
  const cap = limit();
  const used = usedOf(ip, action, date);
  if (used >= cap) {
    const label = LABEL[action] || action;
    throw fail('ACCOUNT_DAILY_LIMIT',
      '同一网络（IP）每天最多' + label + ' ' + cap + ' 次，今天已经' + label + ' ' +
      used + ' 次，请明天 0 点后再试',
      { action, used, limit: cap, date });
  }
  return { date, limit: cap, used, left: cap - used };
}

// 动作成功后记账。失败 / 回滚的路径不要调用它。
function consume(ip, action, opts) {
  const o = opts || {};
  if (!ip || limit() <= 0 || !ACTIONS.has(action)) return false;
  const date = dayOf(o.nowMs);
  db.run(`INSERT INTO account_daily_actions (ip, date, action, count, updated_at)
          VALUES (?,?,?,1,?)
          ON CONFLICT(ip, date, action)
          DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
    String(ip), String(date), String(action), Date.now());
  return true;
}

module.exports = { limit, dayOf, usedOf, status, assertAllowed, consume };
