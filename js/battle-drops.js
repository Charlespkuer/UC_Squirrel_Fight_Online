// Original pickup system, read from the shipped client's js/ssdz-pkg2.js

(function () {
  'use strict';

  const RULES = Object.freeze({ fps: 15, frames: [30, 180, 340], jitter: 130, lifetime: 31 / 15 * 1000 });

  const BLUE_MUL = (typeof GData !== 'undefined' && Number(GData.BLUE_SHARD_DROP_MUL)) || 1;
  const POOL = [
    { id: 15, name: '经验', count: 5, weight: 30 },
    { id: 8, name: '金松果', count: 2, weight: 25 },
    { id: 21, name: '技能卷轴', count: 1, weight: 12 },
    { id: 22, name: '武器卷轴', count: 1, weight: 12 },
    // 权重可以是小数：`plan()` 只按权重和摇号，不要求整数（改这里就够了，别处不用同步）。
    { id: 1, name: '小体力药剂', count: 1, weight: 2.5 },
    { id: 2, name: '大体力药剂', count: 1, weight: 0.5 },
    { id: 45, name: '天使果实种子', count: 1, weight: 3 },
    { id: 46, name: '恶魔果实种子', count: 1, weight: 1.5 },
    { id: 24, name: '白色碎片', count: 1, weight: 5 },
    { id: 25, name: '绿色碎片', count: 1, weight: 3 },
    { id: 26, name: '蓝色碎片', count: 1, weight: 1 * BLUE_MUL },
  ];

  const LADDER_POOL = [
    { id: 51, name: '属性碎片', count: 1, weight: 34 },
    { id: 46, name: '恶魔果实种子', count: 1, weight: 15 },
    { id: 15, name: '经验', count: 5, weight: 22 },
    { id: 8, name: '金松果', count: 2, weight: 18 },
    { id: 21, name: '技能卷轴', count: 1, weight: 8 },
    { id: 22, name: '武器卷轴', count: 1, weight: 8 },
    { id: 26, name: '蓝色碎片', count: 1, weight: 6 * BLUE_MUL },
  ];
  const poolFor = (kind) => (kind === 'rank' ? LADDER_POOL : POOL);

  function plan(random, kind) {
    random = random || Math.random;
    const pool = poolFor(kind);
    const offset = Math.round(random() * RULES.jitter), total = pool.reduce((n, p) => n + p.weight, 0);
    return RULES.frames.map((frame, index) => {
      let value = random() * total, reward = pool[pool.length - 1];
      for (const item of pool) { value -= item.weight; if (value < 0) { reward = item; break; } }
      return { ...reward, index, at: (frame + offset) / RULES.fps * 1000 };
    });
  }
  // 用跳过键跳过战斗播放时整场最多收 2/3 的战斗中悬浮奖励 ——
  // ⚠ 只有玩家按了跳过键才吃这个代价；战斗自然打完（还有飘物没来得及捡）
  function trimOne(list, random) {
    const arr = (list || []).slice();
    if (arr.length < 2) return { list: arr, lost: null };
    const rnd = random || Math.random;
    const at = Math.max(0, Math.min(arr.length - 1, Math.floor(rnd() * arr.length)));
    const lost = arr.splice(at, 1)[0];
    return { list: arr, lost: lost || null };
  }

  function create(options) {
    const opts = options || {}, drops = opts.plan || plan(opts.random, opts.kind), collected = [], upgrades = [], awarded = new Set(), pending = [];
    const owner = State.state();
    let elapsed = 0, next = 0, active = null, closed = false, button = null, notice = null, noticeUntil = 0;
    const root = opts.root;
    function removeButton() { if (button) button.remove(); button = null; active = null; }
    // 点击拾取后的「获得…」提示（与单机版同一句文案 / 同一套 `.battle-pickup-notice`）。
    // 单机版发奖是同步的，点击后立刻亮；联机版等服务端确认回包后用回包里的 `prize` 亮，
    function showPickupNotice(reward) {
      if (!root || closed) return;
      if (notice) notice.remove(); notice = document.createElement('div');
      notice.className = 'battle-pickup-notice'; notice.setAttribute('role', 'status');
      notice.textContent = '获得' + reward.name + ' ×' + reward.count; root.appendChild(notice); noticeUntil = elapsed + 1700;
    }
    // 掉落图标复用背包同一张原版矢量路径表（`propIconSrc`），不再单独切 sprites/draw-*。
    const iconSrc = (id) => {
      const classic = window.UI && UI.classic;
      if (classic && typeof classic.propIconSrc === 'function') return classic.propIconSrc(id);
      return 'images/ui/icons/prop/prop-' + id + '.png';
    };
    function show(reward) {
      removeButton(); active = reward;
      if (!root) return;
      const ladder = opts.kind === 'rank';
      button = document.createElement('button'); button.type = 'button';
      button.className = 'battle-pickup' + (ladder ? ' rank' : '');
      button.setAttribute('aria-label', '拾取' + reward.name + ' ×' + reward.count);
      button.innerHTML = '<span class="pickup-card"><img alt="" src="' + iconSrc(reward.id) + '"></span><span class="pickup-prompt">' + (ladder ? '请点确定' : '请点击') + '</span>';
      button.onclick = () => collect(reward.index);
      root.appendChild(button);
    }
    function collect(index) {
      if (closed || !active || active.index !== index || State.state() !== owner || elapsed >= active.at + RULES.lifetime) return false;
      const reward = active; removeButton();
      return award(reward, true);
    }
    function award(reward, showNotice) {
      if (awarded.has(reward.index) || State.state() !== owner) return false;
      awarded.add(reward.index);
      if (opts.onCollect) {
        collected.push({ id: reward.id, name: reward.name, count: reward.count });
        const request = Promise.resolve().then(() => opts.onCollect(reward.index)).then(out => {
          if (out && out.ups) upgrades.push(...out.ups);
          // 服务端确认后才提示：回包里的 `prize` 才是实际入账的那一件；
          if (showNotice) showPickupNotice((out && out.prize) || reward);
        }).catch(error => {
          const i = collected.findIndex(item => item.id === reward.id && item.count === reward.count);
          if (i >= 0) collected.splice(i, 1);
          if (opts.onError) opts.onError(error);
        });
        pending.push(request);
        return true;
      }
      if (reward.id === 15) upgrades.push(...State.gainExp(reward.count));
      else if (reward.id === 8) State.addGold(reward.count);
      else owner.props[reward.id] = (owner.props[reward.id] || 0) + reward.count;
      if (State.bumpDaily) State.bumpDaily('pickup', 1, true);
      State.save(); collected.push({ id: reward.id, name: reward.name, count: reward.count });
      if (showNotice) showPickupNotice(reward);
      return true;
    }
    // `trimOne` 仍是塔的「每场跳过随机抹一包」的公共件，不要删。
    let lostReward = null;

    function skip(penalize) {
      if (closed) return;
      const remaining = drops.filter((drop) => !awarded.has(drop.index));
      if (!penalize) {
        for (const drop of remaining) award(drop, false);
        close();
        return;
      }
      // 已收件数 + 本次补发件数不超过 2（3 件里的 2/3）。
      // 只从「还没捡的」里随机挑一项丢掉，其余按原顺序补发 —— 这样不会打乱
      // 战果页的拾取顺序，也只消耗一个随机数（与旧测试的固定随机流兼容）。
      const target = Math.max(0, Math.min(remaining.length, 2 - collected.length));
      const dropIndex = remaining.length > target
        ? Math.floor((opts.random ? opts.random() : Math.random()) * remaining.length)
        : -1;
      lostReward = dropIndex >= 0 ? remaining[Math.min(dropIndex, remaining.length - 1)] : null;
      for (const drop of remaining) if (drop !== lostReward) award(drop, false);
      close();
    }
    function tick(dt) {
      if (closed) return;
      elapsed += Math.max(0, Math.min(100, Number(dt) || 0));
      if (active && elapsed >= active.at + RULES.lifetime) removeButton();
      if (notice && elapsed >= noticeUntil) { notice.remove(); notice = null; }
      if (next < drops.length && elapsed >= drops[next].at) { const drop = drops[next++]; if (elapsed < drop.at + RULES.lifetime) show(drop); }
    }
    function close() { closed = true; removeButton(); if (notice) notice.remove(); notice = null; }

    function summary() {
      return { items: collected.map(item => ({ ...item })), ups: upgrades.slice(),
        lost: lostReward ? { id: lostReward.id, name: lostReward.name, count: lostReward.count } : null };
    }
    return { tick, collect, close, skip, summary, flush: () => Promise.all(pending) };
  }

  function grant(list) {
    const owner = State.state(), items = [], ups = [];
    let picks = 0;
    for (const reward of list || []) {
      if (!reward || !reward.count) continue;
      picks++;
      if (reward.id === 15) ups.push(...State.gainExp(reward.count));
      else if (reward.id === 8) State.addGold(reward.count);
      else owner.props[reward.id] = (owner.props[reward.id] || 0) + reward.count;
      const hit = items.find((x) => x.id === reward.id);
      if (hit) hit.count += reward.count;
      else items.push({ id: reward.id, name: reward.name, count: reward.count });
    }
    State.save();
    return { items, ups, picks };
  }
  window.BattleDrops = { create, plan, trimOne, grant, rules: RULES, pool: POOL, ladderPool: LADDER_POOL, poolFor };
})();
