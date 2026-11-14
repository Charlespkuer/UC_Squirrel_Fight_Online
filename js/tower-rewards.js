// tower-rewards.js — 联机版无尽塔的周奖励账本（浏览器与服务端共用）
(function () {
  'use strict';

  const WEEK_CAP = 10;
  const LAYERS_PER_TICKET = 25;
  const MINT_BONUS_THRESHOLD = 10;
  const MAX_RUNS = 32;

  function int(value, fallback) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? n : (Number(fallback) || 0);
  }

  function weekKeyOf(value) {
    const s = String(value == null ? '' : value);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  }

  function emptyWeek(week) {
    return { week: weekKeyOf(week), tickets: 0, runs: [] };
  }

  function normalizeRun(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = String(raw.id == null ? '' : raw.id).slice(0, 64);
    if (!id) return null;
    return {
      id,
      layer: Math.max(0, int(raw.layer)),
      mint: Math.max(0, int(raw.mint)),
      raw: Math.max(0, int(raw.raw)),
      tickets: Math.max(0, Math.min(WEEK_CAP, int(raw.tickets))),
      at: Math.max(0, int(raw.at)),
    };
  }

  // 只做形状清洗，不按当前周重置（服务端结算时才比对 week）。
  function normalizeWeek(raw) {
    const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const runs = (Array.isArray(src.runs) ? src.runs : [])
      .map(normalizeRun).filter(Boolean).slice(-MAX_RUNS);
    return {
      week: weekKeyOf(src.week),
      tickets: Math.max(0, Math.min(WEEK_CAP, int(src.tickets))),
      runs,
    };
  }

  // 层数 / 铸币 → 本局应得（未受周上限影响）。
  function compute(layer, mint) {
    const bestLayer = Math.max(0, Math.min(1000000000, int(layer)));
    const mintCount = Math.max(0, Math.min(1000000000, int(mint)));
    const layerTickets = Math.floor(bestLayer / LAYERS_PER_TICKET);
    const mintBonus = mintCount > MINT_BONUS_THRESHOLD ? 1 : 0;
    return { bestLayer, mintCount, layerTickets, mintBonus, raw: layerTickets + mintBonus };
  }


  function settle(input) {
    const o = input || {};
    const week = weekKeyOf(o.week);
    const old = normalizeWeek(o.box);
    const store = old.week === week ? old : emptyWeek(week);
    const calc = compute(o.layer, o.mint);
    const id = String(o.runId == null ? '' : o.runId).slice(0, 64);
    const base = {
      layerTickets: calc.layerTickets,
      mintBonus: calc.mintBonus,
      raw: calc.raw,
      week: store.week,
      weekCap: WEEK_CAP,
    };

    // 同一局重复提交（超时重试 / 断线重连）：返回上次的结果，不再发奖。
    if (id) {
      const prev = store.runs.find((r) => r.id === id);
      if (prev) {
        return {
          box: store,
          result: Object.assign({}, base, {
            ok: true, duplicate: true, runId: id,
            layer: prev.layer, mint: prev.mint,
            layerTickets: Math.floor(prev.layer / LAYERS_PER_TICKET),
            mintBonus: prev.mint > MINT_BONUS_THRESHOLD ? 1 : 0,
            raw: prev.raw,
            granted: prev.tickets,
            capped: prev.raw > prev.tickets,
            weekUsed: store.tickets,
            weekLeft: Math.max(0, WEEK_CAP - store.tickets),
          }),
        };
      }
    }

    const left = Math.max(0, WEEK_CAP - store.tickets);
    const granted = Math.min(calc.raw, left);
    if (calc.raw > 0 && id) {
      store.runs.push({
        id, layer: calc.bestLayer, mint: calc.mintCount,
        raw: calc.raw, tickets: granted, at: Date.now(),
      });
      if (store.runs.length > MAX_RUNS) store.runs.splice(0, store.runs.length - MAX_RUNS);
    }
    if (granted > 0) store.tickets = Math.min(WEEK_CAP, store.tickets + granted);

    return {
      box: store,
      result: Object.assign({}, base, {
        ok: true, duplicate: false, runId: id,
        layer: calc.bestLayer, mint: calc.mintCount,
        granted,
        capped: granted < calc.raw,
        weekUsed: store.tickets,
        weekLeft: Math.max(0, WEEK_CAP - store.tickets),
      }),
    };
  }

  window.TowerRewards = Object.freeze({
    WEEK_CAP,
    LAYERS_PER_TICKET,
    MINT_BONUS_THRESHOLD,
    MAX_RUNS,
    compute,
    normalizeWeek,
    emptyWeek,
    settle,
  });
})();
