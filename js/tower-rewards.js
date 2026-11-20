// tower-rewards.js — 联机版无尽塔的周奖励账本（浏览器与服务端共用）
(function () {
  'use strict';

  const WEEK_CAP = 10;
  // 通过 >=100 层每周首次结算额外给 2 张，不占 WEEK_CAP。
  const BONUS_MIN_LAYER = 100;
  const TRUE_END_BONUS_TICKETS = 2;
  const LAYERS_PER_TICKET = 10;
  const MINT_BONUS_THRESHOLD = 10;
  const MAX_RUNS = 32;
  // 结算数据合理性：塔内对局只在本机，服务端拿不到过程，只能挡住明显不可能的组合。
  // 真实铸币上限约「每 10 层 1 枚 + 每 5 层最多 1 家商店」；这里给到每 2 层 1 枚再留 4 枚缓冲，
  // 宁可放过也不误伤正常长局。层数上限同样只是防脏数据的硬边界。
  const MAX_LAYER = 100000;
  const MINT_GRACE = 4;

  function int(value, fallback) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? n : (Number(fallback) || 0);
  }

  function weekKeyOf(value) {
    const s = String(value == null ? '' : value);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  }

  function emptyWeek(week) {
    return { week: weekKeyOf(week), tickets: 0, trueEndBonus: false, runs: [] };
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
      bonus: Math.max(0, int(raw.bonus)),
      trueEnd: raw.trueEnd === true,
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
      trueEndBonus: src.trueEndBonus === true,
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

  // 本局层数下，铸币最多能有多少的宽松上限（合理组合；不是塔内真实掉落公式）。
  function mintLimitOf(layer) {
    return MINT_GRACE + Math.floor(Math.max(0, int(layer)) / 2);
  }

  function plausible(layer, mint) {
    const bestLayer = int(layer);
    const mintCount = int(mint);
    return bestLayer >= 0 && bestLayer <= MAX_LAYER
      && mintCount >= 0 && mintCount <= mintLimitOf(bestLayer);
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
      trueEndBonusTickets: TRUE_END_BONUS_TICKETS,
    };

    // 同一局重复提交（超时重试 / 断线重连）：返回上次的结果，不再发奖。
    if (id) {
      const prev = store.runs.find((r) => r.id === id);
      if (prev) {
        const prevBonus = Math.max(0, int(prev.bonus));
        return {
          box: store,
          result: Object.assign({}, base, {
            ok: true, duplicate: true, runId: id,
            layer: prev.layer, mint: prev.mint,
            layerTickets: Math.floor(prev.layer / LAYERS_PER_TICKET),
            mintBonus: prev.mint > MINT_BONUS_THRESHOLD ? 1 : 0,
            raw: prev.raw,
            trueEnd: prev.trueEnd === true,
            granted: prev.tickets + prevBonus,
            victoryBonus: prevBonus,
            victoryBonusUsed: store.trueEndBonus === true,
            capped: prev.raw > prev.tickets,
            weekUsed: store.tickets,
            weekLeft: Math.max(0, WEEK_CAP - store.tickets),
          }),
        };
      }
    }

    const left = Math.max(0, WEEK_CAP - store.tickets);
    const granted = Math.min(calc.raw, left);
    // 百层奖励只看本局已通过层数，不再要求「整百层击败魔王」；每周只发一次。
    const trueEnd = calc.bestLayer >= BONUS_MIN_LAYER;
    let victoryBonus = 0;
    // 百层奖励不占 WEEK_CAP，所以 weekLeft 不受影响。
    if (trueEnd && id && store.trueEndBonus !== true) {
      victoryBonus = TRUE_END_BONUS_TICKETS;
      store.trueEndBonus = true;
    }
    if ((calc.raw > 0 || victoryBonus > 0) && id) {
      store.runs.push({
        id, layer: calc.bestLayer, mint: calc.mintCount,
        raw: calc.raw, tickets: granted, bonus: victoryBonus, trueEnd, at: Date.now(),
      });
      if (store.runs.length > MAX_RUNS) store.runs.splice(0, store.runs.length - MAX_RUNS);
    }
    if (granted > 0) store.tickets = Math.min(WEEK_CAP, store.tickets + granted);

    return {
      box: store,
      result: Object.assign({}, base, {
        ok: true, duplicate: false, runId: id,
        layer: calc.bestLayer, mint: calc.mintCount,
        trueEnd,
        granted: granted + victoryBonus,
        victoryBonus,
        victoryBonusUsed: store.trueEndBonus === true,
        capped: granted < calc.raw,
        weekUsed: store.tickets,
        weekLeft: Math.max(0, WEEK_CAP - store.tickets),
      }),
    };
  }

  window.TowerRewards = Object.freeze({
    WEEK_CAP,
    BONUS_MIN_LAYER,
    TRUE_END_BONUS_TICKETS,
    LAYERS_PER_TICKET,
    MINT_BONUS_THRESHOLD,
    MAX_RUNS,
    MAX_LAYER,
    MINT_GRACE,
    compute,
    mintLimitOf,
    plausible,
    normalizeWeek,
    emptyWeek,
    settle,
  });
})();
