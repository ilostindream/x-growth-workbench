/* X 发展工作台 —— 隔离世界（ISOLATED）内容脚本
 *
 * 职责：
 *   1. 接收 inject.js 从 GraphQL 响应中截获的推文条目（接口通道）
 *   2. 兼用 DOM 兜底通道，读取已渲染推文的 time[datetime]，接口通道失效时仍能工作
 *   3. 按「推文 ID」唯一去重，接口通道的判定优先于 DOM 通道
 *   4. 在作者名旁渲染内联徽章、在右下角渲染「今日活跃榜」，并提供内置诊断区
 *
 * 统计口径：只统计「你在时间线上刷到的」内容，不向 X 发任何额外请求。
 */
(() => {
  'use strict';
  if (window.__xamContent) return;
  window.__xamContent = true;

  // 无条件打点：用来区分「脚本没运行」和「运行了但没渲染」
  try { console.info('[XAM] content.js 已运行 ·', location.href); } catch (e) {}

  const SRC = '__XAM_TWEETS__';
  const DIAG = '__XAM_DIAG__';
  const KEY = 'xam_data_v1';
  const UI_KEY = 'xam_ui_v1';
  const META_KEY = 'xam_meta_v1';
  const KINDS = ['post', 'reply', 'rt'];

  /* ---------- 附加元数据：流速热度 / 账号备注 / 改名记录 ----------
   * 独立于统计数据存储：热度与改名不限于「今天」，备注由设置页维护。
   * 写入走读-合并-写，与设置页/其他标签页共存。
   */
  let meta = { heat: {}, notes: {}, names: {}, media: {}, rel: {} };
  let metaSaveTimer = null;

  function scheduleMetaSave() {
    if (metaSaveTimer) return;
    metaSaveTimer = setTimeout(() => {
      metaSaveTimer = null;
      persistMeta();
    }, 900);
  }

  function persistMeta() {
    // 所有页签（含同步页）统一走后台串行合并：后台单线程读-合并-写，
    // 既修掉「同步页抓到的 rel/heat/media/names 被丢弃」的黑洞，也消灭多页签写竞争
    pruneHeat();
    pruneMedia();
    try {
      chrome.runtime.sendMessage({
        type: 'xam_meta_merge',
        meta: { heat: meta.heat, notes: meta.notes, names: meta.names, media: meta.media, rel: meta.rel }
      });
    } catch (e) {
      log('meta 合并发送失败', e);
    }
  }

  function pruneHeat() {
    const hk = Object.keys(meta.heat);
    if (hk.length <= 3200) return;
    hk.sort((a, b) => ((meta.heat[a] && meta.heat[a].ts) || 0) - ((meta.heat[b] && meta.heat[b].ts) || 0));
    const drop = hk.slice(0, hk.length - 2800);
    for (let i = 0; i < drop.length; i++) delete meta.heat[drop[i]];
  }

  // 媒体地址上限 400 条（按时间保留最新的）
  function pruneMedia() {
    const mk = Object.keys(meta.media);
    if (mk.length <= 400) return;
    mk.sort((a, b) => ((meta.media[a] && meta.media[a].ts) || 0) - ((meta.media[b] && meta.media[b].ts) || 0));
    const drop = mk.slice(0, mk.length - 300);
    for (let i = 0; i < drop.length; i++) delete meta.media[drop[i]];
  }

  // 改名检测：与上次见到的显示名不同时记为曾用名（借鉴 XHunt，纯本地实现）
  function trackName(h, name) {
    if (!h || !name) return;
    const n = String(name);
    const cur = meta.names[h];
    if (!cur) {
      meta.names[h] = { cur: n, prev: [] };
      scheduleMetaSave();
      return;
    }
    if (cur.cur !== n) {
      const prev = (cur.prev || []).slice();
      if (prev.indexOf(cur.cur) === -1) prev.unshift(cur.cur);
      if (prev.length > 5) prev.length = 5;
      meta.names[h] = { cur: n, prev: prev };
      scheduleMetaSave();
      scheduleScan(0);   // 时间线上的曾用名标记需要更新
    }
  }

  function loadMeta() {
    try {
      chrome.storage.local.get([META_KEY], (res) => {
        const m = res && res[META_KEY];
        if (m) meta = { heat: m.heat || {}, notes: m.notes || {}, names: m.names || {}, media: m.media || {}, rel: m.rel || {} };
        scheduleScan(0);
      });
    } catch (e) {}
  }

  // 设置页/其他标签页改了备注等 → 合并进来并重扫
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch[META_KEY]) return;
      const nv = ch[META_KEY].newValue;
      if (!nv) return;
      meta = { heat: nv.heat || {}, notes: nv.notes || {}, names: nv.names || {}, media: nv.media || {}, rel: nv.rel || {} };
      scheduleScan(0);
    });
  } catch (e) {}

  /* ---------- 设置（src/options.html 设置页可改） ---------- */

  const SET = (window.XAM && window.XAM.settings) || null;
  let S = SET
    ? SET.normSettings(null)
    : {
      showBadge: true, badgeShowReply: true, badgeShowRt: false, badgeShowFans: false,
      panelEnabled: true, panelPos: 'tr', panelWidth: 306, panelTheme: 'auto',
      listLimit: 60, sortBy: 'activity',
      autoSync: true, autoGap: 5000, autoParallel: 3, autoTTL: 15, autoMax: 60,
      selfHandle: '',
      relEnabled: true, relPos: 'name', relItems: null,
      showHeat: true, hideAds: false, showNotes: true, showNameHistory: true, collectMedia: true,
      debug: false
    };

  const DEBUG = (() => {
    try { return localStorage.getItem('xam:debug') === '1'; } catch (e) { return false; }
  })();
  function log() {
    if (!DEBUG && !S.debug) return;
    try { console.debug.apply(console, ['[XAM]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  /* ---------- 时间 ---------- */

  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
  function dayString(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  const todayStr = () => dayString(new Date());
  function localDate(ts) {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? '' : dayString(d);
  }

  /* ---------- 状态 ---------- */

  const state = {
    date: todayStr(),
    authors: {},   // handle(小写) -> { name, avatar, post:[], reply:[], rt:[] }
    self: null,
    ui: { collapsed: false, auto: true }
  };

  // h|id -> { kind, src }；src 为 'api' 或 'dom'，api 的判定优先
  const recMap = new Map();

  const stats = { rx: 0, batches: 0, stored: 0, notToday: 0, dup: 0, bad: 0, fixed: 0 };
  const chan = { boot: false, resp: 0, hit: 0, lastOp: '', lastTweets: 0 };

  let loaded = false;
  let pending = [];
  let saveTimer = null;
  let renderTimer = null;
  let scanTimer = null;
  let showDiag = false;

  function ensureState() {
    const d = todayStr();
    if (state.date !== d) {
      log('跨天，重置计数', state.date, '->', d);
      state.date = d;
      state.authors = {};
      recMap.clear();
      stats.stored = 0;
      stats.rx = 0;
      stats.batches = 0;
    }
  }

  function ensureAuthor(h, name, avatar, fc) {
    let a = state.authors[h];
    if (!a) {
      a = state.authors[h] = { name: name || h, avatar: avatar || '', fc: -1, post: [], reply: [], rt: [] };
    }
    if (name) a.name = name;
    if (avatar) a.avatar = avatar;
    if (typeof fc === 'number' && fc >= 0) a.fc = fc;
    for (let i = 0; i < KINDS.length; i++) {
      if (!Array.isArray(a[KINDS[i]])) a[KINDS[i]] = [];
    }
    return a;
  }

  // 独立的用户对象（主页头部、搜索结果用户卡等）→ 补全粉丝数与关注关系
  function updateUsers(list) {
    if (!loaded || !Array.isArray(list) || !list.length) return;
    ensureState();
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (!u || !u.handle) continue;
      const h = String(u.handle).toLowerCase();
      trackName(h, u.name);
      const a = state.authors[h];
      if (!a) continue;                 // 只为已进入统计的人补数据
      if (typeof u.fc === 'number' && a.fc !== u.fc) { a.fc = u.fc; n++; }
      if (u.name) a.name = u.name;
      if (u.avatar) a.avatar = u.avatar;
      if (u.rel && typeof u.rel === 'object') {
        const r = normRel(u.rel);
        if (r) {
          const mr = (meta.rel[h] = meta.rel[h] || { f: null, fb: null });
          if (!a.rel) { a.rel = r; n++; }
          else {
            if (r.f !== null && a.rel.f !== r.f) { a.rel.f = r.f; n++; }
            if (r.fb !== null && a.rel.fb !== r.fb) { a.rel.fb = r.fb; n++; }
          }
          if (r.f !== null) mr.f = r.f;
          if (r.fb !== null) mr.fb = r.fb;
        }
      }
    }
    if (n) {
      scheduleSave();
      scheduleMetaSave();
      scheduleScan(0);
      scheduleRender();
    }
  }

  /* ---------- 计数 ---------- */

  // 返回 'new' | 'moved' | 'dup' | 'skip'
  function addRec(h, kind, id, name, avatar, src, fc) {
    const rk = h + '|' + id;
    const prev = recMap.get(rk);
    if (prev) {
      // 接口通道纠正 DOM 通道的类型误判（同一推文只保留一份）
      if (src === 'api' && prev.src === 'dom' && prev.kind !== kind) {
        const a = state.authors[h];
        if (a && Array.isArray(a[prev.kind])) {
          const idx = a[prev.kind].indexOf(id);
          if (idx >= 0) a[prev.kind].splice(idx, 1);
          a[kind].push(id);
          prev.kind = kind;
          prev.src = 'api';
          stats.fixed++;
          return 'moved';
        }
      }
      return 'dup';
    }
    recMap.set(rk, { kind, src });
    ensureAuthor(h, name, avatar, fc)[kind].push(id);
    stats.stored++;
    return 'new';
  }

  function record(it) {
    if (!it || !it.handle || !isFinite(it.ts)) { stats.bad++; return 'skip'; }
    const h = String(it.handle).toLowerCase();
    // —— 以下三项与「今天」无关，放在日期过滤之前 ——
    // 流速勋章数据：浏览量
    if (typeof it.views === 'number' && it.views >= 0) {
      meta.heat[String(it.id)] = { h: h, ts: it.ts, v: it.views };
      scheduleMetaSave();
    }
    // 改名记录
    trackName(h, it.name);
    // 媒体收集（图片原图 / 视频最高码率 mp4），供设置页批量下载
    if (S.collectMedia !== false && Array.isArray(it.media) && it.media.length) {
      for (let i = 0; i < it.media.length; i++) {
        const md = it.media[i];
        if (!md || !md.u) continue;
        meta.media[md.u] = { h: h, id: String(it.id), t: md.t || 'photo', ts: it.ts };
      }
      scheduleMetaSave();
    }
    ensureState();
    if (localDate(it.ts) !== state.date) { stats.notToday++; return 'skip'; }   // 只算今天
    const kind = it.kind === 'reply' ? 'reply' : it.kind === 'rt' ? 'rt' : 'post';
    const a = ensureAuthor(h, it.name, it.avatar, it.fc);   // 顺手更新粉丝数（重复条目也要更新）
    if (it.rel && typeof it.rel === 'object') {
      const r = normRel(it.rel);
      if (r) {
        // 新信息优先：字段缺失时保留旧值；同时写入 meta.rel（跨天权威源）
        if (!meta.rel[h]) meta.rel[h] = { f: null, fb: null };
        if (r.f !== null) meta.rel[h].f = r.f;
        if (r.fb !== null) meta.rel[h].fb = r.fb;
        if (!a.rel) a.rel = r;
        else {
          if (r.f !== null) a.rel.f = r.f;
          if (r.fb !== null) a.rel.fb = r.fb;
        }
        scheduleMetaSave();
      }
    }
    const r2 = addRec(h, kind, String(it.id), it.name, it.avatar, it.src === 'dom' ? 'dom' : 'api', it.fc);
    if (r2 === 'dup') stats.dup++;
    return r2;
  }

  function onChanged() {
    scheduleSave();
    scheduleScan(0);
    scheduleRender();
  }

  function ingest(items) {
    if (!Array.isArray(items) || !items.length) return;
    if (!loaded) { pending = pending.concat(items); return; }
    stats.rx += items.length;
    stats.batches++;
    if (stats.batches <= 3) {
      try { console.info('[XAM] 接口通道第' + stats.batches + '批 · ' + items.length + ' 条', items[0]); } catch (e) {}
    }
    let n = 0;
    for (let i = 0; i < items.length; i++) {
      const r = record(items[i]);
      if (r === 'new' || r === 'moved') n++;
    }
    if (n) {
      log('入库', n);
      onChanged();
    }
  }

  /* ---------- 持久化 ---------- */

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persist();
    }, 700);
  }

  // 合并两份作者数据：按 id 取并集，粉丝数取新的，关注关系保留已知值
  function normRel(r) {
    if (!r || typeof r !== 'object') return null;
    const f = typeof r.f === 'boolean' ? r.f : null;
    const fb = typeof r.fb === 'boolean' ? r.fb : null;
    return f === null && fb === null ? null : { f: f, fb: fb };
  }

  function mergeAuthors(base, add) {
    const out = {};
    for (const h in base) {
      const a = base[h];
      if (!a) continue;
      out[h] = {
        name: a.name || h, avatar: a.avatar || '',
        fc: typeof a.fc === 'number' ? a.fc : -1,
        rel: normRel(a.rel),
        post: a.post ? a.post.slice() : [], reply: a.reply ? a.reply.slice() : [], rt: a.rt ? a.rt.slice() : []
      };
    }
    for (const h in add) {
      const a = add[h];
      if (!a) continue;
      const o = out[h] || (out[h] = { name: a.name || h, avatar: a.avatar || '', fc: -1, rel: null, post: [], reply: [], rt: [] });
      if (a.name) o.name = a.name;
      if (a.avatar) o.avatar = a.avatar;
      if (typeof a.fc === 'number' && a.fc >= 0) o.fc = a.fc;
      const nr = normRel(a.rel);
      if (nr) {
        if (!o.rel) o.rel = nr;
        else {
          if (nr.f !== null) o.rel.f = nr.f;
          if (nr.fb !== null) o.rel.fb = nr.fb;
        }
      }
      const kinds = { post: a.post, reply: a.reply, rt: a.rt };
      for (const k in kinds) {
        const arr = kinds[k];
        if (!Array.isArray(arr)) continue;
        for (let i = 0; i < arr.length; i++) {
          if (o[k].indexOf(arr[i]) === -1) o[k].push(arr[i]);
        }
      }
    }
    return out;
  }

  function persist(force) {
    if (IS_SYNC_TAB) return;   // 同步页的数据经后台服务合并入库，不直接写，避免多页签互相覆盖
    ensureState();
    try {
      if (force) {
        chrome.storage.local.set({
          [KEY]: { date: state.date, authors: state.authors, self: state.self, savedAt: Date.now() }
        });
        return;
      }
      // 读-合并-写：与后台服务/其他标签页的写入共存
      chrome.storage.local.get([KEY], (res) => {
        const cur = res && res[KEY];
        const base = cur && cur.date === state.date && cur.authors ? cur.authors : {};
        chrome.storage.local.set({
          [KEY]: {
            date: state.date,
            authors: mergeAuthors(base, state.authors),
            self: state.self || (cur && cur.self) || null,
            savedAt: Date.now()
          }
        });
      });
    } catch (e) {
      log('保存失败', e);
    }
  }

  function loadStored() {
    try {
      chrome.storage.local.get([KEY, UI_KEY], (res) => {
        try {
          if (res && res[UI_KEY]) {
            state.ui.collapsed = !!res[UI_KEY].collapsed;
            state.ui.auto = res[UI_KEY].auto !== false;
          }
          const d = res && res[KEY];
          if (d && d.date === todayStr() && d.authors) {
            state.date = d.date;
            state.self = d.self || null;
            for (const h in d.authors) {
              const a = d.authors[h];
            state.authors[h] = {
              name: a.name || h,
              avatar: a.avatar || '',
              fc: typeof a.fc === 'number' ? a.fc : -1,
              rel: a.rel && typeof a.rel === 'object' ? { f: typeof a.rel.f === 'boolean' ? a.rel.f : null, fb: typeof a.rel.fb === 'boolean' ? a.rel.fb : null } : null,
              post: Array.isArray(a.post) ? a.post.slice() : [],
              reply: Array.isArray(a.reply) ? a.reply.slice() : [],
              rt: Array.isArray(a.rt) ? a.rt.slice() : []
            };
              for (let i = 0; i < KINDS.length; i++) {
                const arr = state.authors[h][KINDS[i]];
                for (let j = 0; j < arr.length; j++) {
                  recMap.set(h + '|' + arr[j], { kind: KINDS[i], src: 'api' });
                }
              }
            }
            stats.stored = recMap.size;
            log('已恢复本地数据', Object.keys(state.authors).length, '位作者');
          }
        } catch (e) {
          log('读取失败', e);
        }
        loaded = true;
        const p = pending;
        pending = [];
        if (p.length) ingest(p);
        applyCollapsed();
        render();
      });
    } catch (e) {
      loaded = true;
      log('storage 不可用', e);
    }
  }

  // 多标签页同步：并集合并
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch[KEY]) return;
      const nv = ch[KEY].newValue;
      if (!nv || nv.date !== todayStr() || !nv.authors) return;
      let changed = 0;
      for (const h in nv.authors) {
        const a = nv.authors[h];
        for (let i = 0; i < KINDS.length; i++) {
          const k = KINDS[i];
          const arr = a[k] || [];
          for (let j = 0; j < arr.length; j++) {
            if (addRec(h, k, arr[j], a.name, a.avatar, 'api', a.fc) === 'new') changed++;
          }
        }
      }
      if (changed) onChanged();
    });
  } catch (e) { /* ignore */ }

  /* ---------- 徽章 ---------- */

  const BADGE_CSS = [
    'display:inline-flex!important', 'align-items:center!important',
    'margin-left:6px!important', 'padding:0 7px!important',
    'border-radius:999px!important', 'border:0!important',
    'font-size:11px!important', 'font-weight:600!important',
    'line-height:17px!important', 'letter-spacing:0!important',
    'white-space:nowrap!important', 'vertical-align:middle!important',
    'text-decoration:none!important', 'cursor:default!important',
    'user-select:none!important', 'flex:0 0 auto!important',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif!important',
    'background:rgba(136,153,166,.14)!important', 'color:#8899a6!important'
  ].join(';');

  const RESERVED = {
    home: 1, explore: 1, notifications: 1, messages: 1, i: 1, settings: 1, search: 1,
    compose: 1, tos: 1, privacy: 1, jobs: 1, logout: 1, signup: 1, login: 1, premium: 1,
    intent: 1, share: 1, hashtag: 1
  };

  function handleFromHref(href) {
    if (!href) return '';
    const seg = String(href).split('?')[0].split('#')[0].split('/').filter(Boolean);
    if (seg.length !== 1) return '';
    const h = seg[0];
    if (RESERVED[h.toLowerCase()]) return '';
    return h;
  }

  function detectHandle(art) {
    const un = art.querySelector('[data-testid="User-Name"]');
    if (un) {
      const links = un.querySelectorAll('a[href^="/"]');
      for (let i = 0; i < links.length; i++) {
        const h = handleFromHref(links[i].getAttribute('href'));
        if (h) return h;
      }
    }
    // 兜底（借鉴「互关标记 for X」）：头像容器的 data-testid 自带 handle，
    // X 虚拟列表复用节点时也只改这个属性，链接解析失败时它依然准确
    const av = art.querySelector('[data-testid^="UserAvatar-Container-"]');
    if (av) {
      const tid = av.getAttribute('data-testid') || '';
      if (/^UserAvatar-Container-[A-Za-z0-9_]{1,15}$/.test(tid)) return tid.slice(21);
    }
    return '';
  }

  function detectName(art, handle) {
    const un = art.querySelector('[data-testid="User-Name"]');
    if (!un) return handle;
    const links = un.querySelectorAll('a[href^="/"]');
    for (let i = 0; i < links.length; i++) {
      if (handleFromHref(links[i].getAttribute('href')) !== handle) continue;
      const sp = links[i].querySelector('span');
      const t = sp ? (sp.textContent || '').trim() : '';
      if (t && t.charAt(0) !== '@') return t;
    }
    return handle;
  }

  function detectAvatar(art) {
    const img = art.querySelector('[data-testid^="UserAvatar"] img') || art.querySelector('img[src*="profile_images"]');
    return img ? img.getAttribute('src') || '' : '';
  }

  function updateBadge(el) {
    const showReply = S.badgeShowReply !== false;
    const showRt = !!S.badgeShowRt;
    const showFans = !!S.badgeShowFans;
    const a = state.authors[el.dataset.handle];
    let txt, ttl, bg, color;
    if (a) {
      const parts = ['发' + a.post.length];
      if (showReply) parts.push('评' + a.reply.length);
      if (showRt) parts.push('转' + a.rt.length);
      if (showFans) parts.push('粉' + fmtFans(a.fc));
      txt = parts.join(' ');
      bg = 'rgba(29,155,240,.12)';
      color = '#1d9bf0';
      ttl = (a.name || el.dataset.handle) + ' 今天在你时间线里：原创 ' + a.post.length +
        ' 条，回复 ' + a.reply.length + ' 条，转推 ' + a.rt.length + ' 条，粉丝 ' + fmtFans(a.fc);
    } else {
      const ph = ['发–'];
      if (showReply) ph.push('评–');
      if (showRt) ph.push('转–');
      if (showFans) ph.push('粉–');
      txt = ph.join(' ');
      bg = 'rgba(136,153,166,.14)';
      color = '#8899a6';
      ttl = '今天暂未在时间线捕获该用户的内容';
    }
    // 关键：只在值真的变化时才写 DOM。
    // 无条件重写 textContent 本身会产生 childList 变更 → 触发 MutationObserver → 再扫描 → 再重写，
    // 形成每秒数次的死循环，推文头部反复重排（表现为整条推文剧烈抖动、滚动被反复重置）
    if (el.textContent !== txt) el.textContent = txt;
    if (el.title !== ttl) el.title = ttl;
    const sig = bg + '|' + color;
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.style.setProperty('background', bg, 'important');
      el.style.setProperty('color', color, 'important');
    }
  }

  /* ---------- 互关标记 ---------- */

  const REL_DEFS = [
    { k: 'mutual', label: '互关', desc: '我们互相关注' },
    { k: 'nofb', label: '未回关', desc: '我关注了 TA，TA 没关注我' },
    { k: 'followme', label: '关注我', desc: 'TA 关注了我，我没关注 TA' },
    { k: 'none', label: '无关注', desc: '互相都没有关注' },
    { k: 'self', label: '本尊', desc: '这是你自己（不参与关注关系判定）' }
  ];
  const REL_MAP = {};
  REL_DEFS.forEach((d) => { REL_MAP[d.k] = d; });

  // 关注关系持久层：meta.rel 为权威源（跨天累计、作者不在今日统计中也保留），
  // authors[].rel 作为旧数据兜底。布尔合并规则：新值非 null 才覆盖
  // normRel：known（该响应可信，X 会省略 false 布尔）时缺失字段按 false 解读；
  // 全空则返回 null（不记录，宁缺勿错）
  function normRel(rel) {
    if (!rel || typeof rel !== 'object') return null;
    let f = typeof rel.f === 'boolean' ? rel.f : null;
    let fb = typeof rel.fb === 'boolean' ? rel.fb : null;
    if (rel.known) {
      if (f === null) f = false;
      if (fb === null) fb = false;
    }
    if (f === null && fb === null) return null;
    return { f: f, fb: fb };
  }

  function getRel(h) {
    const m = meta.rel && meta.rel[h];
    if (m) return m;
    const a = state.authors[h];
    return a && a.rel ? a.rel : null;
  }

  function ingestRels(list) {
    if (!loaded || !Array.isArray(list) || !list.length) return;
    ensureState();
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r || !r.handle) continue;
      const h = String(r.handle).toLowerCase();
      const nr = normRel(r);
      if (!nr) continue;
      const f = nr.f, fb = nr.fb;
      const cur = (meta.rel[h] = meta.rel[h] || { f: null, fb: null });
      if (f !== null && cur.f !== f) { cur.f = f; n++; }
      if (fb !== null && cur.fb !== fb) { cur.fb = fb; n++; }
      // 同步给今日作者对象（旧字段，向后兼容）
      const a = state.authors[h];
      if (a) {
        if (!a.rel) a.rel = { f: null, fb: null };
        if (f !== null) a.rel.f = f;
        if (fb !== null) a.rel.fb = fb;
      }
    }
    if (n) {
      scheduleMetaSave();
      scheduleScan(0);       // 立刻刷新时间线上的互关标记
      scheduleRender();
    }
  }

  // 由截获到的关注关系判定类别；任一侧未知时不标记（宁缺勿错）
  function relKind(a) {
    if (!a || !a.rel) return '';
    const f = a.rel.f, fb = a.rel.fb;
    if (f === true && fb === true) return 'mutual';
    if (f === true && fb === false) return 'nofb';
    if (f === false && fb === true) return 'followme';
    if (f === false && fb === false) return 'none';
    return '';
  }

  function relMarker(art, handle) {
    // 自己的推文：「自己和自己」不存在关注关系，曾有接口数据把本人判成「无关注」。
    // 一律改挂「本尊」标记，不读 rel 数据
    const isSelf = !!(handle && state.self && handle.toLowerCase() === String(state.self).toLowerCase());
    let kind, cfg;
    if (isSelf) {
      kind = 'self';
      cfg = S.relEnabled && S.relItems ? (S.relItems.self || null) : null;
    } else {
      const rel = getRel(handle);
      kind = rel ? relKind({ rel: rel }) : '';
      cfg = kind && S.relEnabled && S.relItems ? (S.relItems[kind] || null) : null;
    }
    const on = cfg && cfg.on;
    let el = art.querySelector('.xam-rel');
    if (!on) {
      if (el) el.remove();
      return;
    }
    const key = kind + '|' + S.relPos + '|' + cfg.color;
    if (el && el.dataset.k === key) return;
    if (el) el.remove();
    const def = REL_MAP[kind];
    if (!def) return;
    el = document.createElement('span');
    el.className = 'xam-rel';
    el.dataset.k = key;
    el.textContent = def.label;
    el.title = '@' + handle + ' · ' + def.desc;
    if (S.relPos === 'avatar') {
      el.style.cssText = 'position:absolute;top:-7px;left:-9px;z-index:2;display:inline-flex;' +
        'padding:1px 5px;border-radius:5px;font-size:10px;font-weight:700;line-height:13px;' +
        'color:#fff!important;background:' + cfg.color + ';white-space:nowrap;pointer-events:none;letter-spacing:.5px;' +
        'box-shadow:0 1px 3px rgba(0,0,0,.25);font-family:inherit;';
      const av = art.querySelector('[data-testid^="UserAvatar"]');
      const holder = av ? (av.parentElement || av) : null;
      if (!holder) return;
      try { if (getComputedStyle(holder).position === 'static') holder.style.position = 'relative'; } catch (e) {}
      holder.appendChild(el);
    } else {
      el.style.cssText = 'display:inline-flex;margin-left:4px;padding:1px 5px;border-radius:5px;' +
        'font-size:10px;font-weight:700;line-height:13px;color:#fff!important;' +
        'background:' + cfg.color + ';white-space:nowrap;pointer-events:none;letter-spacing:.5px;font-family:inherit;';
      const un = art.querySelector('[data-testid="User-Name"]');
      if (!un) return;
      un.appendChild(el);
    }
  }

  /* ---------- DOM 关系探针 ----------
   * 数据通道的兜底：不依赖 X 的 GraphQL 结构，直接读资料页上的控件状态——
   *   · 「正在关注」按钮（data-testid="unfollow"）→ 我关注了 TA
   *   · 「关注」按钮（data-testid="follow"）      → 我没关注 TA
   *   · 「正在关注你」标识（userFollowIndicator）  → TA 关注了我
   * 在所有资料页生效（含点行同步/自动补全打开的主页），零额外请求，判定 100% 可靠 */
  const PROFILE_SEG_SKIP = ['home', 'explore', 'notifications', 'messages', 'i', 'search',
    'settings', 'compose', 'intent', 'hashtag', 'explore', 'status'];
  let probeKey = '';
  let probeAt = 0;

  function probeProfileRel() {
    try {
      const seg = (location.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
      if (!seg || PROFILE_SEG_SKIP.indexOf(seg) !== -1) return;
      if (seg === (state.self || '').toLowerCase()) return;      // 自己的主页没有这些控件
      const now = Date.now();
      if (seg === probeKey && now - probeAt < 2500) return;      // 同一主页 2.5 秒内不重复探测
      probeKey = seg;
      probeAt = now;

      let f = null, fb = null;
      const actions = document.querySelector('[data-testid="userActions"]') || document;
      if (actions.querySelector('[data-testid="unfollow"]')) f = true;
      else if (actions.querySelector('[data-testid="follow"]')) f = false;

      const badge = document.querySelector('[data-testid="userFollowIndicator"]');
      if (badge) {
        fb = true;
      } else {
        const nameEl = document.querySelector('[data-testid="UserName"]');
        const txt = nameEl && nameEl.parentElement ? (nameEl.parentElement.innerText || '') : '';
        if (/正在关注你|关注了你|Follows you|フォローされています/.test(txt)) fb = true;
      }
      if (f === null && fb === null) return;
      ingestRels([{ handle: seg, f: f, fb: fb }]);
    } catch (e) {}
  }

  /* ---------- DOM 兜底通道 ---------- */

  function recordFromDom(art, handle) {
    const t = art.querySelector('time[datetime]');
    if (!t) return;
    const ts = Date.parse(t.getAttribute('datetime') || '');
    if (!isFinite(ts)) return;
    if (localDate(ts) !== state.date) return;          // 早退，省掉后续开销

    const link = t.closest('a[href*="/status/"]');
    const m = link ? /\/status\/(\d+)/.exec(link.getAttribute('href') || '') : null;
    const id = m ? m[1] : handle.toLowerCase() + ':' + ts;

    if (recMap.has(handle.toLowerCase() + '|' + id)) return;   // 已记录，避免重复取正文

    const head = (art.textContent || '').slice(0, 400);
    // X 中文界面为「正在回复 @xxx」，英文「Replying to」，日文「返信先」等
    const kind = /正在回复|回复给|正在回复给|Replying to|回覆|返信|返信先/.test(head) ? 'reply' : 'post';

    const r = record({
      id,
      handle,
      name: detectName(art, handle),
      avatar: detectAvatar(art),
      ts,
      kind,
      src: 'dom'
    });
    if (r === 'new' || r === 'moved') {
      log('DOM 通道记录', handle, kind);
      onChanged();
    }
  }

  /* ---------- 扫描 & 装饰 ---------- */

  function scan() {
    visibleHandles.clear();
    const arts = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
    for (let i = 0; i < arts.length; i++) {
      const art = arts[i];
      const handle = detectHandle(art);
      if (!handle) continue;
      const hl = handle.toLowerCase();
      noteVisible(art, hl);

      if (S.showBadge) {
        let badge = art.querySelector('.xam-badge');
        if (!badge) {
          const un = art.querySelector('[data-testid="User-Name"]');
          if (!un) continue;
          badge = document.createElement('span');
          badge.className = 'xam-badge';
          badge.dataset.handle = handle.toLowerCase();
          badge.style.cssText = BADGE_CSS;
          un.appendChild(badge);
        } else if (badge.dataset.handle !== hl) {
          // 虚拟列表会复用 DOM 节点，必须复核徽章归属，否则会串号
          badge.dataset.handle = hl;
        }
        updateBadge(badge);
      } else {
        const stale = art.querySelector('.xam-badge');
        if (stale) stale.remove();
      }
      relMarker(art, hl);
      noteMarker(art, hl);
      nameHistMarker(art, hl);
      heatMarker(art);
      adFilter(art);
      recordFromDom(art, handle);
    }
    decorateToolbars();
    probeProfileRel();     // 资料页上读关注状态（含同步标签页）
  }

  /* ---------- 时间线增强（借鉴 BlueV / XHunt 的广受欢迎功能） ---------- */

  // 颜色 + 透明度 → rgba
  function hexA(hex, a) {
    const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
    if (!m) return 'rgba(29,155,240,' + a + ')';
    const n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // ① 账号备注色标（BlueV 同款）
  function noteMarker(art, h) {
    let el = art.querySelector('.xam-note');
    const n = S.showNotes ? meta.notes[h] : null;
    if (!n || !n.t) {
      if (el) el.remove();
      return;
    }
    const key = h + '|' + n.t + '|' + (n.c || '');
    if (el && el.dataset.k === key) return;
    if (el) el.remove();
    const c = n.c || '#1d9bf0';
    el = document.createElement('span');
    el.className = 'xam-note';
    el.dataset.k = key;
    el.textContent = '📝 ' + n.t;
    el.title = '备注 @' + h + '：' + n.t;
    el.style.cssText = 'display:inline-flex;margin-left:4px;max-width:200px;overflow:hidden;text-overflow:ellipsis;' +
      'white-space:nowrap;padding:1px 6px;border-radius:5px;font-size:10px;font-weight:600;line-height:14px;' +
      'color:' + c + ';background:' + hexA(c, .13) + ';border:1px solid ' + hexA(c, .38) + ';' +
      'vertical-align:middle;pointer-events:none;font-family:inherit;flex:0 0 auto;';
    const un = art.querySelector('[data-testid="User-Name"]');
    if (un) un.appendChild(el);
  }

  // ② 改名记录标记（借鉴 XHunt，本地实现）
  function nameHistMarker(art, h) {
    let el = art.querySelector('.xam-namehist');
    const n = S.showNameHistory ? meta.names[h] : null;
    if (!n || !n.prev || !n.prev.length) {
      if (el) el.remove();
      return;
    }
    if (el && el.dataset.k === h + '|' + n.prev.join(',')) return;
    if (el) el.remove();
    const first = n.prev[0] || '';
    const short = first.length > 10 ? first.slice(0, 10) + '…' : first;
    el = document.createElement('span');
    el.className = 'xam-namehist';
    el.dataset.k = h + '|' + n.prev.join(',');
    el.textContent = '曾名 ' + short;
    el.title = '@' + h + ' 的曾用名：' + n.prev.join('、') + '（现为「' + n.cur + '」）';
    el.style.cssText = 'display:inline-flex;margin-left:4px;max-width:150px;overflow:hidden;text-overflow:ellipsis;' +
      'white-space:nowrap;padding:1px 6px;border-radius:5px;font-size:10px;font-weight:600;line-height:14px;' +
      'color:#8899a6;background:rgba(136,153,166,.14);border:1px dashed rgba(136,153,166,.5);' +
      'vertical-align:middle;pointer-events:none;font-family:inherit;flex:0 0 auto;';
    const un = art.querySelector('[data-testid="User-Name"]');
    if (un) un.appendChild(el);
  }

  // ③ 流速勋章：推文右上角显示平均每小时浏览量（BlueV 同款思路）
  function fmtVph(v) {
    if (v < 10) return v.toFixed(1).replace(/\.0$/, '');
    if (v < 10000) return String(Math.round(v));
    return (v / 10000).toFixed(1).replace(/\.0$/, '') + 'w';
  }

  function heatMarker(art) {
    let el = art.querySelector('.xam-heat');
    if (!S.showHeat) {
      if (el) el.remove();
      return;
    }
    // 找推文自身的 status 链接（第一条 /status/数字 即本体）
    const links = art.querySelectorAll('a[href*="/status/"]');
    let id = '';
    for (let i = 0; i < links.length; i++) {
      const m = /\/status\/(\d+)/.exec(links[i].getAttribute('href') || '');
      if (m) { id = m[1]; break; }
    }
    const d = id ? meta.heat[id] : null;
    if (!d || typeof d.v !== 'number' || !(d.ts > 0)) {
      if (el) el.remove();
      return;
    }
    const hours = Math.max((Date.now() - d.ts) / 3600000, 0.5);
    const vph = d.v / hours;
    const txt = fmtVph(vph);
    if (el && el.dataset.k === id + '|' + txt) return;
    if (el) el.remove();
    const hot = vph >= 1000 ? '#f4212e' : vph >= 100 ? '#f7931a' : '#536471';
    el = document.createElement('span');
    el.className = 'xam-heat';
    el.dataset.k = id + '|' + txt;
    el.textContent = '🔥' + txt + '/h';
    el.title = '流速勋章：发布以来平均每小时浏览约 ' + Math.round(vph) +
      ' 次\n总浏览 ' + fmtFans(d.v) + ' · 发布于 ' + new Date(d.ts).toLocaleString('zh-CN');
    el.style.cssText = 'display:inline-flex;align-items:center;margin-left:6px;padding:0 6px;border-radius:999px;' +
      'font-size:10.5px;font-weight:700;line-height:16px;color:' + hot + ';' +
      'background:' + hexA(hot === '#536471' ? '#8899a6' : hot, .13) + ';' +
      'white-space:nowrap;pointer-events:none;font-family:inherit;flex:0 0 auto;';
    // 插到时间链接所在行的末尾（推文头部右侧）
    const t = art.querySelector('time[datetime]');
    const anchor = t ? t.closest('a') : null;
    if (anchor && anchor.parentElement) anchor.parentElement.appendChild(el);
    else {
      const un = art.querySelector('[data-testid="User-Name"]');
      if (un) un.appendChild(el);
      else if (el.parentElement !== art) art.appendChild(el);
    }
  }

  // ④ 广告过滤（BlueV 同款，默认关）：隐藏带广告标记的推文
  const AD_LABELS = { '广告': 1, '推广': 1, 'Promoted': 1, 'Sponsored': 1, 'プロモーション': 1 };

  function isAdArticle(art) {
    if (art.querySelector('[data-testid="placementTracking"]')) return true;
    const spans = art.querySelectorAll('span');
    for (let i = 0; i < spans.length; i++) {
      const t = (spans[i].textContent || '').trim();
      if (t && AD_LABELS[t]) return true;
    }
    return false;
  }

  function adFilter(art) {
    if (S.hideAds) {
      if (art.style.display !== 'none' && isAdArticle(art)) {
        art.style.display = 'none';
        art.dataset.xamAd = '1';
        log('隐藏广告推文');
      }
      return;
    }
    // 关闭时还原
    if (art.dataset.xamAd) {
      delete art.dataset.xamAd;
      art.style.display = '';
    }
  }

  function unhideAllAds() {
    const ads = document.querySelectorAll('[data-xam-ad]');
    for (let i = 0; i < ads.length; i++) {
      ads[i].style.display = '';
      delete ads[i].dataset.xamAd;
    }
  }

  /* ---------- AI 草稿回复 ----------
   * 回复框工具栏加「AI」按钮 → 选风格 → 后台调 OpenAI 兼容接口起草 →
   * 填入回复框，由用户本人审核后手动发送（扩展绝不代发）。
   */

  const AI_CFG_KEY = 'xam_ai_cfg_v1';
  // DeepSeek 2026-07-24 起停用 deepseek-chat / deepseek-reasoner
  const AI_DEFAULT_BASE = 'https://api.deepseek.com';
  const AI_DEFAULT_MODEL = 'deepseek-flash';
  let aiCfg = {};

  // 说话风格备注：统一生成「最高优先级」硬约束块。
  // 后台 callLLM 也用同样的 STYLE_MARK 做兜底注入与去重——页面 aiCfg 过期时由后台补上。
  const STYLE_MARK = '【说话风格·最高优先级】';
  function styleNotes(notes) {
    if (!notes) return '';
    return '\n\n' + STYLE_MARK + '\n用户的说话风格设定：' + notes + '\n' +
      '这是最高优先级约束，输出必须明显体现：语气、句长、用词习惯都要跟着它走，不要输出中性、书面化或客服腔的默认文案。' +
      '若设定中包含粗口偏好，允许使用轻度口语粗口来表达情绪，但不得出现辱骂、歧视或人身攻击。' +
      '若与「只输出内容本身」等格式要求冲突，格式要求仍优先。';
  }

  // 设置页保存配置后，已打开的 X 页面（SPA 常驻不刷新）也要立刻同步，
  // 否则 aiCfg.notes 一直是页面加载时的旧值，风格指令根本不会拼进提示词
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch[AI_CFG_KEY]) return;
      aiCfg = ch[AI_CFG_KEY].newValue || {};
    });
  } catch (e) {}

  // 按钮样式：浅灰胶囊「✨ AI」（用户指定参照样式），随 X 明暗主题换色
  const SPARK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2l1.9 5.6c.3.9 1 1.6 1.9 1.9L21.4 12l-5.6 1.9c-.9.3-1.6 1-1.9 1.9L12 21.4l-1.9-5.6c-.3-.9-1-1.6-1.9-1.9L2.6 12l5.6-1.9c.9-.3 1.6-1 1.9-1.9L12 2z"/></svg>';
  const AI_BTN_CSS = 'display:inline-flex;align-items:center;justify-content:center;gap:5px;margin-left:8px;padding:0 14px;height:30px;' +
    'border-radius:999px;border:0;font-size:13px;font-weight:700;letter-spacing:.2px;' +
    'cursor:pointer;line-height:1;user-select:none;flex:0 0 auto;font-family:inherit;transition:background .15s ease;';

  function aiBtnColors(dark) {
    return dark
      ? 'background:rgba(255,255,255,.14)!important;color:#e7e9ea!important;'
      : 'background:#eff3f4!important;color:#0f1419!important;';
  }

  let aiStyleInjected = false;
  function injectAiBtnStyle() {
    if (aiStyleInjected) return;
    aiStyleInjected = true;
    const st = document.createElement('style');
    st.textContent = '.xam-ai-btn:hover{filter:brightness(.94);}';
    document.head.appendChild(st);
  }

  const AI_STYLES = [
    // 赞同共鸣排在智能匹配左边（2026-11-04 用户要求：鼠标下滑更顺手），
    // 智能匹配仍是「换一条」的默认风格（按 label 查找，不依赖数组顺序）
    { label: '赞同共鸣', prompt: '表达真诚的赞同与共鸣，可以补充一句自己的感受或经历' },
    { label: '智能匹配', prompt: '根据推文内容自动选择最合适的口吻：内容专业就专业接话，轻松就轻松接话' },
    { label: '补充观点', prompt: '在对方观点基础上补充一个新的角度或信息，语气谦和' },
    { label: '友好提问', prompt: '表达兴趣并提出一个具体、开放式的追问，展示真的想交流' },
    { label: '专业分析', prompt: '给出理性、有信息量的分析视角，语气克制、就事论事' },
    { label: '幽默轻松', prompt: '幽默、俏皮但不刻薄，可以玩梗，避免冒犯' },
    { label: '礼貌反驳', prompt: '先肯定合理之处，再温和地提出不同看法，不抬杠' },
    { label: '简短支持', prompt: '一两句话的简短支持或助威，口号式，朗朗上口' }
  ];

  // 区分回复框与发帖框（占位文案不同）：
  //   回复框：aria-label「发送你的回复」/ Post your reply
  //   发帖框：「有什么新鲜事？」/「发帖」等 —— 回复逻辑在这里没有上下文，点了没反应
  function composerModeOf(bar) {
    let ed = null;
    let root = bar.parentElement;
    for (let i = 0; i < 8 && root && !ed; i++) {
      ed = firstEditorIn(root);
      if (ed) break;
      root = root.parentElement;
    }
    let label = ed ? (ed.getAttribute('aria-label') || '') : '';
    const lab = ed ? ed.closest('[data-testid$="_label"]') : null;
    if (lab) label += ' ' + (lab.textContent || '');
    if (/回复|reply/i.test(label)) return 'reply';
    if (label.trim()) return 'post';
    return modalRootOf(bar) ? 'reply' : 'post';
  }

  function decorateToolbars() {
    const bars = document.querySelectorAll('div[data-testid="toolBar"]');
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (bar.querySelector('.xam-ai-btn')) continue;
      injectAiBtnStyle();
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'xam-ai-btn';
      btn.setAttribute('style', AI_BTN_CSS + aiBtnColors(detectTheme() === 'dark'));
      btn.innerHTML = SPARK_SVG + '<span>AI</span>';
      const mode = composerModeOf(bar);
      btn.dataset.xamMode = mode;
      btn.title = mode === 'post'
        ? '爆帖灵感：结合热点生成发帖选题（生成后由你编辑发布）'
        : 'AI 起草回复（生成后由你审核发送）';
      // 点击不走这里：统一用下面的 document 捕获委托。
      // 弹窗里 X 的 React 重渲染会替换工具栏节点，绑在按钮上的 listener 随旧节点丢失，
      // 表现为「点了没反应」；委托到 document 不受节点替换影响

      // 位置：放在「回复」发送按钮的左侧，与它同高、垂直居中对齐
      const send = bar.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
      if (send) {
        // 找到发送按钮在 toolbar 直接子层里的外层容器，插到它前面
        let anchor = send;
        while (anchor.parentElement && anchor.parentElement !== bar) anchor = anchor.parentElement;
        const h = Math.round(send.getBoundingClientRect().height) || 36;
        btn.style.height = h + 'px';
        btn.style.marginLeft = '0';
        btn.style.marginRight = '10px';
        btn.style.alignSelf = 'center';
        bar.insertBefore(btn, anchor);
      } else {
        bar.appendChild(btn);
      }
    }
  }

  // 找到正在回复的目标推文：DOM 顺序上位于回复框之前、最靠后的最外层推文卡片
  function aiContext(toolbar) {
    let best = null;
    const arts = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
    for (let i = 0; i < arts.length; i++) {
      const a = arts[i];
      if (a.parentElement && a.parentElement.closest('article')) continue;   // 引用推文的内层卡片不算
      if (a.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING) best = a;
    }
    if (!best) return null;
    const te = best.querySelector('[data-testid="tweetText"]');
    let text = te ? (te.textContent || '').trim() : '';
    if (text.length > 600) text = text.slice(0, 600) + '…';
    return { handle: detectHandle(best) || '对方', text: text };
  }

  function aiSystemPrompt(st) {
    let s = '你在帮用户起草一条发在 X（推特）上的中文回复。硬性要求：\n' +
      '- 像真人随手打的口语，自然、有个性，不要客套话\n' +
      '- 长度 1~3 句，最多 1 个 emoji，不要 hashtag，不要 @ 对方\n' +
      '- 直接输出回复内容本身：不要引号、不要解释、不要任何前后缀\n' +
      '- 必须与推文内容具体相关，不要泛泛而谈\n' +
      '- 本条回复的风格：' + st.prompt + '\n';
    s += styleNotes(aiCfg.notes);
    return s;
  }

  function aiSetup() {
    const base = window.prompt(
      '第 1/4 步：接口地址（OpenAI 兼容）\nDeepSeek 填 https://api.deepseek.com',
      aiCfg.base || AI_DEFAULT_BASE
    );
    if (base === null) return;
    const key = window.prompt(
      '第 2/4 步：API Key\n在 platform.deepseek.com → API keys 创建，形如 sk-xxxxxxxx\n只保存在你浏览器本地，不会上传到任何服务器',
      aiCfg.key || ''
    );
    if (key === null) return;
    const model = window.prompt(
      '第 3/4 步：模型名\nDeepSeek 当前可用：deepseek-flash（快、便宜）或 deepseek-v4-pro（更强、更贵）\n换其他厂商就填它自家的模型名',
      aiCfg.model || AI_DEFAULT_MODEL
    );
    if (model === null) return;
    const notes = window.prompt(
      '第 4/4 步：你的说话风格备注（可留空）\n如：口语化、爱用网络梗、少用 emoji、常以"确实"开头',
      aiCfg.notes || ''
    );
    if (notes === null) return;

    const b = base.trim().replace(/\/+$/, '');
    const k = key.trim();
    aiCfg = { base: b, model: model.trim() || AI_DEFAULT_MODEL, key: k, notes: notes.trim() };
    saveAiCfg();

    if (!k) {
      renderToast('已保存，但没有填 Key —— AI 草稿无法使用');
      return;
    }
    if (!/^sk-[A-Za-z0-9_\-]{10,}/.test(k)) {
      renderToast('已保存。提醒：DeepSeek 的 Key 通常以 sk- 开头，请确认没复制错');
    } else {
      renderToast('已保存，正在校验 Key…');
    }

    // 校验 Key 并校准模型名：填错模型名是首次配置最常见的失败原因
    try {
      chrome.runtime.sendMessage({ type: 'xam_ai_test', base: b, key: k }, (res) => {
        if (chrome.runtime.lastError) return;
        if (!res) return;
        if (!res.ok) {
          renderToast('⚠️ Key 校验未通过：' + (res.error || '未知原因') + '（配置已保存，可改完再试）');
          return;
        }
        const list = Array.isArray(res.models) ? res.models : [];
        let m = aiCfg.model;
        if (list.length && list.indexOf(m) === -1) {
          // 当前模型名不在可用列表里 —— 自动校准，否则调用必然失败
          m = list.indexOf(AI_DEFAULT_MODEL) >= 0 ? AI_DEFAULT_MODEL : list[0];
          aiCfg.model = m;
          saveAiCfg();
          renderToast('✅ Key 有效 · 原模型名不可用，已自动校准为 ' + m);
        } else {
          renderToast('✅ Key 有效 · 模型 ' + m + (list.length ? ' · 可用 ' + list.length + ' 个' : ''));
        }
      });
    } catch (e) {}
  }

  function saveAiCfg() {
    try { chrome.storage.local.set({ [AI_CFG_KEY]: aiCfg }); } catch (e) {}
  }

  // 找回复框编辑器：弹窗里工具栏与编辑框的层距可能超过 8 层，原来的固定层数会找不到
  // 编辑框可见性：X 弹窗背后保留屏幕外的「幽灵克隆」编辑框（测量用），
  // 不做可见性校验就会把草稿插进克隆里，还误报成功
  function edVisible(ed) {
    if (!ed) return false;
    try {
      const r = ed.getBoundingClientRect();
      if (r.width < 40 || r.height < 16) return false;
      if (r.bottom < 0 || r.top > window.innerHeight) return false;
      if (r.right < 0 || r.left > window.innerWidth) return false;
      for (let n = ed; n && n !== document.body; n = n.parentElement) {
        if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return false;
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
      }
      return true;
    } catch (e) { return false; }
  }

  // 弹窗根节点：不依赖固定 testid，沿祖先逐层嗅探（X 各版本弹窗的 role/testid 不一致）
  function modalRootOf(toolbar) {
    let n = toolbar;
    for (let i = 0; i < 24 && n && n !== document.body; i++) {
      if (n.getAttribute) {
        const tid = n.getAttribute('data-testid') || '';
        if (n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true' || /modal/i.test(tid)) {
          return n;
        }
      }
      n = n.parentElement;
    }
    return null;
  }

  // 编辑器候选选择器：只做粗筛，真正的判定靠 isRealEditor()
  // （testid 同前缀的派生节点太多：_label 占位层、RichTextInputContainer 容器层，
  //   都不是可编辑元素，paste 发给它们全部静默失败）
  const EDITOR_SEL = '[role="textbox"], [data-testid^="tweetTextarea_"]';

  // 唯一可靠的判定：元素本身真的可编辑（contenteditable 生效）
  function isRealEditor(el) {
    try {
      return !!el && el.isContentEditable === true;
    } catch (e) { return false; }
  }

  // 在 root 内找第一个真正的编辑器（跳过标签层/容器层）
  function firstEditorIn(root) {
    if (!root || !root.querySelectorAll) return null;
    const list = root.querySelectorAll(EDITOR_SEL);
    for (let i = 0; i < list.length; i++) {
      if (isRealEditor(list[i])) return list[i];
    }
    return null;
  }

  function findReplyEditor(toolbar) {
    // 弹窗场景优先在弹窗容器内部找可见编辑框——X 会保留屏幕外的幽灵克隆，
    // 弹窗内的才是用户看到的那个
    const root = modalRootOf(toolbar);
    if (root) {
      const list = root.querySelectorAll(EDITOR_SEL);
      let cand = null;
      for (let i = 0; i < list.length; i++) {
        if (!isRealEditor(list[i])) continue;     // 排除标签层/容器层
        if (edVisible(list[i])) cand = list[i];   // 取弹窗内最后一个可见的（主编辑器后渲染）
      }
      if (cand) return cand;
    }
    // 兜底（内联回复框等）：全量可见编辑框，取离工具栏中心最近的
    const tr = toolbar.getBoundingClientRect();
    const tcx = tr.left + tr.width / 2, tcy = tr.top + tr.height / 2;
    let best = null, bestD = Infinity;
    const all = document.querySelectorAll(EDITOR_SEL);
    for (let i = 0; i < all.length; i++) {
      const ed = all[i];
      if (!isRealEditor(ed)) continue;            // 排除标签层/容器层
      if (!edVisible(ed)) continue;
      const r = ed.getBoundingClientRect();
      const d = (r.left + r.width / 2 - tcx) ** 2 + (r.top + r.height / 2 - tcy) ** 2;
      if (d < bestD) { bestD = d; best = ed; }
    }
    return best;
  }

  function copyDraft(text) {
    try {
      navigator.clipboard.writeText(text).then(() => {
        renderToast('无法直接填入，草稿已复制到剪贴板，请粘贴');
      });
    } catch (e) {
      renderToast('草稿已生成，但填入失败，请手动复制');
    }
  }

  // 插入结果通过 cb(filled) 异步回报。
  // 实证结论（用户发出的推文只有一条，但 DOM 里有两份）：
  //   多级阶梯插入会造成「一份进状态 + 一份 DOM 孤儿文本」，而 DOM 文本判定无法区分两者。
  //   所以这里只允许：
  //   1) 单通道插入：首选 document.execCommand('insertText')——最稳定进入 Draft/Lexical
  //      状态的方式；绝不同时叠加多个插入事件；
  //   2) 成败判定不读编辑框文本，读「回复按钮是否点亮」——aria-disabled 是 React 状态
  //      的唯一直接体现（编辑框只有裸 DOM 文本时按钮仍是灰的）；
  //   3) 若按钮没亮，先清掉可能的孤儿文本，再单独用 paste 事件补一次，仍以按钮为准。
  function insertReply(toolbar, text, cb) {
    // 全局插入锁：扩展重载后未刷新的页面里可能同时存在新旧两代内容脚本（孤儿），
    // 它们共享同一 isolated world —— 锁保证任一时刻只有一个实例在插草稿，杜绝双份。
    // 锁带时间戳自动过期：任何一次插入异常中断没解锁（如找不到编辑框的早退路径），
    // 15 秒后锁自动失效——否则一次失败就永久卡死后续所有插入，
    // 表现为「点击生成草稿后内容再也不出现在编辑框里」
    if (window.__XAM_INSERTING && Date.now() - (window.__XAM_INSERT_AT || 0) < 15000) {
      console.warn('[XAM] 检测到另一个脚本实例正在插入草稿，本次跳过');
      renderToast('上一份草稿还在插入中，请稍 1~2 秒再试');
      return;
    }
    window.__XAM_INSERTING = true;
    window.__XAM_INSERT_AT = Date.now();
    const unlock = () => { window.__XAM_INSERTING = false; };
    // 菜单/卡片打开期间 React 可能已把工具栏节点替换（脱管节点测不出位置、也找不到
    // 所属弹窗），换用当前存活的 toolBar 重新锚定
    if (toolbar && !document.contains(toolbar)) {
      const live = document.querySelector('div[data-testid="toolBar"]');
      if (live) toolbar = live;
    }
    const snip = (text || '').trim().slice(0, 12);
    const probe = () => {
      const ed = findReplyEditor(toolbar);   // 每次重新找：React 会替换节点
      return ed && edVisible(ed) ? ed : null;
    };
    const hasText = () => {
      const ed = probe();
      return !!ed && (ed.textContent || '').indexOf(snip) !== -1;
    };
    // 回复按钮：弹窗用 tweetButton，内联用 tweetButtonInline
    const replyBtn = () => {
      const root = modalRootOf(toolbar) || document;
      return root.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]') ||
        document.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
    };
    const btnLit = () => {
      const b = replyBtn();
      if (!b) return false;
      return b.getAttribute('aria-disabled') !== 'true' && !b.disabled;
    };
    const clearEditor = (ed) => {
      try {
        ed.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(ed);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        document.execCommand('delete', false, null);
      } catch (e) {}
    };
    const selectAll = (ed) => {
      try {
        ed.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(ed);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch (e) {}
    };

    const finish = (ok) => {
      if (ok) { if (cb) cb(true); return; }
      console.error('[XAM] 草稿插入失败（回复按钮未点亮），已退回剪贴板');
      copyDraft(text);
      if (cb) cb(false);
    };

    // 轮询回复按钮状态：React 状态更新是异步的
    const waitLit = (ms, then) => {
      const t0 = Date.now();
      const poll = () => {
        if (btnLit() && hasText()) { then(true); return; }
        if (Date.now() - t0 >= ms) { then(false); return; }
        setTimeout(poll, 150);
      };
      poll();
    };

    const ed = probe();
    if (!ed) {
      console.error('[XAM] 草稿插入失败：页面上找不到可见的编辑框');
      unlock();                                    // 此前漏解锁，会把之后所有插入永久卡死
      copyDraft(text);
      if (cb) cb(false);
      return;
    }
    try {
      console.log('[XAM] 草稿插入目标:', ed.getAttribute('data-testid') || '(无testid)',
        'modal=' + !!modalRootOf(toolbar), 'btnLit0=' + btnLit(), JSON.stringify(ed.getBoundingClientRect()));
    } catch (e) {}

    // 旧尝试留下的孤儿文本先清掉（否则会拼接/叠加）
    if ((ed.textContent || '').trim()) clearEditor(ed);

    // 主通道：paste 事件。Draft/Lexical 对 paste 有原生处理且会接管整个插入
    // （只进 React 状态、无默认行为）——这是唯一能保证「状态与 DOM 一致只有一份」的方式。
    // execCommand('insertText') 已实测会在 X 编辑器上产生双份（浏览器直改 DOM 一份 +
    // 框架进状态一份），只配做 paste 失败后的兜底
    const pasteInsert = (edt) => {
      try {
        try { edt.scrollIntoView({ block: 'center' }); } catch (e0) {}
        edt.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        edt.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dt, bubbles: true, cancelable: true
        }));
      } catch (e) {}
    };
    pasteInsert(ed);

    waitLit(2500, (ok) => {
      if (ok) { unlock(); finish(true); return; }
      // paste 没生效：清空后用 execCommand 兜底（可能双份，但至少内容在）
      const ed2 = probe();
      if (ed2) {
        clearEditor(ed2);
        selectAll(ed2);
        try { document.execCommand('insertText', false, text); } catch (e) {}
      }
      waitLit(2500, (ok2) => { unlock(); finish(ok2); });
    });
  }

  // 最近生成过的回复（最多 3 条）：「换一个」时喂给 AI 作防雷同约束
  const recentReplies = [];
  // 上次生成回复用的风格：「换一条」菜单项沿用，未生成过则默认智能匹配
  let lastReplyStyle = null;
  function rememberGenerated(text) {
    const t = (text || '').trim();
    if (!t) return;
    const i = recentReplies.indexOf(t);
    if (i !== -1) recentReplies.splice(i, 1);
    recentReplies.push(t);
    while (recentReplies.length > 3) recentReplies.shift();
  }

  function aiGenerate(btn, toolbar, st, avoid, onDone) {
    // 所有结束路径（成功/失败/异常）都通知调用方，用于恢复操作条按钮状态。
    // 幂等 + 35 秒兜底：避免某条路径漏调（如插入锁拦截）导致按钮永久「生成中…」
    let settled = false;
    let guard = null;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (guard) clearTimeout(guard);
      if (typeof onDone === 'function') { try { onDone(!!ok); } catch (e) {} }
    };
    guard = setTimeout(() => done(false), 35000);
    const ctx = aiContext(toolbar);
    if (!ctx || !ctx.text) {
      renderToast('没有找到要回复的推文，请在推文详情页/回复框使用');
      done(false);
      return;
    }
    lastReplyStyle = st;
    btn.textContent = '生成中…';
    btn.style.pointerEvents = 'none';
    // 15 秒还没回来提示网络慢（后台有 30s 超时兜底，不会永远转圈）
    const slowTimer = setTimeout(() => { btn.textContent = '生成中…(网络较慢)'; }, 15000);
    let userMsg = '推文作者：@' + ctx.handle + '\n推文内容：\n' + ctx.text;
    if (avoid && avoid.length) {
      userMsg += '\n\n你已经为这条推文生成过以下回复，用户不满意。新回复必须在观点、切入角度或句式上明显不同，禁止只做同义改写：\n- ' + avoid.join('\n- ');
    }
    try {
      chrome.runtime.sendMessage(
        { type: 'xam_ai', payload: { system: aiSystemPrompt(st), user: userMsg, useStyle: true } },
        (res) => {
          clearTimeout(slowTimer);
          resetAiBtn(btn);
          if (chrome.runtime.lastError || !res) {
            const msg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '无响应';
            console.error('[XAM] AI 无响应：', msg);
            showAiCard('AI 调用失败', msg + '\n\n若提示 Extension context invalidated：扩展刚重载过，刷新本页即可。', null, null);
            renderToast('AI 调用失败：' + msg);
            done(false);
            return;
          }
          if (!res.ok) {
            console.error('[XAM] AI 失败：', res.error);
            showAiCard('AI 请求失败', res.error + '\n\n常见原因：Key 无效 / 余额不足 / 模型名不对 / 网络代理不通。可到设置页点「测试连接」核对。', null, null);
            renderToast('AI 失败：' + res.error);
            done(false);
            return;
          }
          insertReply(toolbar, res.text, (filled) => {
            if (filled) {
              rememberGenerated(res.text);
              renderToast('草稿已填入回复框，请你审核后自行发送');
              showRegenBar(btn, toolbar, st);
            }
            done(!!filled);
          });
        }
      );
    } catch (e) {
      clearTimeout(slowTimer);
      resetAiBtn(btn);
      console.error('[XAM] AI 调用异常：', e);
      renderToast('AI 调用失败：' + e.message);
      done(false);
    }
  }

  /* ---------- 换一个 / 一键发布：草稿填入后的快捷操作条 ---------- */

  let regenBarEl = null;

  // 发布按钮：弹窗用 tweetButton，内联回复用 tweetButtonInline；取可见且可点的那个
  function findPublishBtn(toolbar) {
    const root = modalRootOf(toolbar) || document;
    const sel = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';
    const list = root.querySelectorAll(sel);
    for (let i = 0; i < list.length; i++) {
      if (edVisible(list[i])) return list[i];
    }
    const all = document.querySelectorAll(sel);
    for (let i = 0; i < all.length; i++) {
      if (edVisible(all[i])) return all[i];
    }
    return null;
  }

  function publishReply(toolbar) {
    const b = findPublishBtn(toolbar);
    if (!b) { renderToast('没找到「回复」按钮，请手动点击发送'); return; }
    if (b.getAttribute('aria-disabled') === 'true' || b.disabled) {
      renderToast('回复框是空的或内容未就绪，按钮不可点');
      return;
    }
    b.click();
    if (regenBarEl) { regenBarEl.remove(); regenBarEl = null; }
    renderToast('已点击回复发送 ✅');
  }

  // 底部快捷操作条：不满意 → 换一个（防雷同重新生成并替换）；满意 → 一键发布
  function showRegenBar(genBtn, toolbar, st) {
    if (regenBarEl) regenBarEl.remove();
    const dark = detectTheme() === 'dark';
    const bar = document.createElement('div');
    regenBarEl = bar;
    bar.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483115;display:flex;align-items:center;gap:8px;' +
      'padding:8px 10px 8px 14px;border-radius:999px;box-shadow:0 8px 28px rgba(0,0,0,.3);font-family:inherit;font-size:13px;' +
      (dark ? 'background:#16181c;color:#e7e9ea;border:1px solid rgba(255,255,255,.14);' : 'background:#fff;color:#0f1419;border:1px solid rgba(0,0,0,.1);');
    const tip = document.createElement('span');
    tip.textContent = '对这条回复满意吗？';
    tip.style.cssText = 'white-space:nowrap;opacity:.85;';
    const mkBtn = (label, primary, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'padding:6px 14px;border-radius:999px;border:0;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit;white-space:nowrap;' +
        (primary ? 'background:#00ba7c;color:#fff;' : (dark ? 'background:rgba(255,255,255,.12);color:#e7e9ea;' : 'background:#eff3f4;color:#0f1419;'));
      // 回调异常必须可见，否则「点了没反应」无从排查
      b.addEventListener('click', () => {
        try { fn(b); }
        catch (err) { console.error('[XAM] 操作条按钮回调异常：', err); renderToast('操作失败：' + (err && err.message ? err.message : err)); }
      });
      return b;
    };
    const close = document.createElement('i');
    close.textContent = '✕';
    close.style.cssText = 'cursor:pointer;font-style:normal;opacity:.5;padding:2px 4px;';
    close.addEventListener('click', () => { bar.remove(); if (regenBarEl === bar) regenBarEl = null; });
    // 5 分钟后自动收起，避免残留在不相关的页面上
    const expire = setTimeout(() => { bar.remove(); if (regenBarEl === bar) regenBarEl = null; }, 5 * 60 * 1000);
    bar.addEventListener('remove-clean', () => clearTimeout(expire), { once: true });
    bar.appendChild(tip);
    bar.appendChild(mkBtn('🔄 换一个', false, (b) => {
      const live = document.contains(toolbar) ? toolbar : document.querySelector('div[data-testid="toolBar"]');
      if (!live) { renderToast('回复框已关闭'); bar.remove(); if (regenBarEl === bar) regenBarEl = null; return; }
      b.textContent = '生成中…';
      b.style.pointerEvents = 'none';
      // 成功后 showRegenBar 会移除本条并重建；失败则保留本条、恢复按钮供重试
      aiGenerate(genBtn, live, st, recentReplies.slice(), (ok) => {
        if (!document.contains(bar)) return;
        if (!ok) { b.textContent = '🔄 换一个'; b.style.pointerEvents = ''; }
      });
    }));
    bar.appendChild(mkBtn('🚀 一键发布', true, () => {
      const live = document.contains(toolbar) ? toolbar : document.querySelector('div[data-testid="toolBar"]');
      publishReply(live);
    }));
    bar.appendChild(close);
    ['mousedown', 'mouseup', 'pointerdown', 'click', 'touchstart'].forEach((ev) => {
      bar.addEventListener(ev, (e) => e.stopPropagation());
    });
    document.documentElement.appendChild(bar);
  }

  /* ---------- AI 工具（借鉴 BlueV）：仿写 / 翻译 / 校对排版 / 海报 ---------- */

  // useStyle 默认 true（创作类任务都要带用户说话风格）；翻译/校对显式传 false
  function aiCall(system, user, cb, useStyle) {
    try {
      chrome.runtime.sendMessage({ type: 'xam_ai', payload: { system: system, user: user, useStyle: useStyle !== false } }, (res) => {
        if (chrome.runtime.lastError || !res) {
          cb(null, 'AI 调用失败：' + ((res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || '无响应'));
          return;
        }
        if (!res.ok) { cb(null, 'AI 失败：' + res.error); return; }
        cb(res.text, null);
      });
    } catch (e) {
      cb(null, 'AI 调用失败：' + e.message);
    }
  }

  // 浮动结果卡片：展示 AI 输出，可复制 / 执行一个动作
  let aiCardEl = null;
  function showAiCard(title, text, actionLabel, actionFn) {
    if (aiCardEl) aiCardEl.remove();
    const dark = detectTheme() === 'dark';
    const c = document.createElement('div');
    aiCardEl = c;
    c.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483120;width:380px;max-width:92vw;' +
      'max-height:70vh;display:flex;flex-direction:column;border-radius:14px;overflow:hidden;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.35);font-family:inherit;' +
      (dark ? 'background:#16181c;color:#e7e9ea;border:1px solid rgba(255,255,255,.14);' : 'background:#fff;color:#0f1419;border:1px solid rgba(0,0,0,.1);');
    const hd = document.createElement('div');
    hd.style.cssText = 'display:flex;align-items:center;gap:6px;padding:10px 14px;font-weight:700;font-size:13px;border-bottom:1px solid ' + (dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.08)') + ';';
    hd.innerHTML = SPARK_SVG + '<span></span><i style="margin-left:auto;cursor:pointer;font-style:normal;opacity:.6;padding:0 4px;">✕</i>';
    hd.querySelector('span').textContent = title;
    hd.querySelector('i').addEventListener('click', () => { c.remove(); if (aiCardEl === c) aiCardEl = null; });
    const body = document.createElement('div');
    body.style.cssText = 'padding:12px 14px;overflow-y:auto;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word;';
    body.textContent = text;
    const ft = document.createElement('div');
    ft.style.cssText = 'display:flex;gap:8px;padding:10px 14px;border-top:1px solid ' + (dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.08)') + ';';
    const mkBtn = (label, primary, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'flex:0 0 auto;padding:6px 14px;border-radius:999px;border:0;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit;' +
        (primary ? 'background:#1d9bf0;color:#fff;' : (dark ? 'background:rgba(255,255,255,.12);color:#e7e9ea;' : 'background:#eff3f4;color:#0f1419;'));
      b.addEventListener('click', fn);
      return b;
    };
    ft.appendChild(mkBtn('复制', false, () => {
      try { navigator.clipboard.writeText(text); } catch (err) {}
    }));
    if (actionLabel && actionFn) ft.appendChild(mkBtn(actionLabel, true, actionFn));
    c.appendChild(hd); c.appendChild(body); c.appendChild(ft);
    document.documentElement.appendChild(c);
  }

  function aiRewrite(toolbar) {
    const ctx = aiContext(toolbar);
    if (!ctx || !ctx.text) { renderToast('没有找到推文，请在推文详情页/回复框使用'); return; }
    let sys = '你在帮用户「仿写」一条推文：模仿它的选题、结构和表达密度，但用用户自己的口吻重写一条全新的推文，而不是回复它。硬性要求：\n' +
      '- 输出一条可直接发布的推文草稿，中文，280 字以内\n' +
      '- 保留原推的核心信息点，但句式和例子必须重新组织，不要照抄原句\n' +
      '- 直接输出内容本身，不要引号、解释或前后缀\n';
    sys += styleNotes(aiCfg.notes);
    renderToast('AI 仿写中…');
    aiCall(sys, '原推文（作者 @' + ctx.handle + '）：\n' + ctx.text, (text, err) => {
      if (err) { renderToast(err); return; }
      insertReply(toolbar, text, (filled) => {
        if (filled) renderToast('仿写草稿已填入回复框，由你审核修改');
      });
    });
  }

  function aiTranslate() {
    const arts = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
    let best = null;
    for (let i = 0; i < arts.length; i++) {
      const a = arts[i];
      if (a.parentElement && a.parentElement.closest('article')) continue;
      const r = a.getBoundingClientRect();
      if (r.top >= 0 && r.top < window.innerHeight * 0.6) { best = a; break; }
    }
    if (!best) best = arts[0];
    const te = best ? best.querySelector('[data-testid="tweetText"]') : null;
    const text = te ? (te.textContent || '').trim() : '';
    if (!text) { renderToast('没有找到可翻译的推文'); return; }
    renderToast('AI 翻译中…');
    aiCall('你是专业翻译。把用户发来的推文翻译成简体中文：保留原意与语气，人名/专业术语可保留原文，只输出译文。',
      text, (out, err) => {
        if (err) { renderToast(err); return; }
        showAiCard('翻译结果', out, null, null);
      }, false);
  }

  function aiProofread(toolbar) {
    let root = toolbar.parentElement;
    let editor = null;
    for (let i = 0; i < 8 && root; i++) {
      editor = firstEditorIn(root);
      if (editor) break;
      root = root.parentElement;
    }
    const text = editor ? (editor.innerText || '').trim() : '';
    if (!text) { renderToast('草稿框是空的，先写点内容再校对'); return; }
    renderToast('AI 校对排版中…');
    aiCall('你在帮用户校对一条将发布到 X 的中文内容：只做错别字修正、断句、分段和标点规范，保留原意与用词习惯，不要改写句子风格、不要增删观点。直接输出处理后的文本。',
      text, (out, err) => {
        if (err) { renderToast(err); return; }
        if (out === text) { renderToast('AI 认为无需修改'); return; }
        showAiCard('校对结果（对比下方原文）', out, '替换草稿', () => {
          if (!editor) return;
          editor.focus();
          let ok = false;
          try {
            document.execCommand('selectAll', false, null);
            ok = document.execCommand('insertText', false, out);
          } catch (e) {}
          if (!ok) { try { navigator.clipboard.writeText(out); renderToast('无法直接替换，已复制到剪贴板'); } catch (e2) {} }
        });
      }, false);
  }

  /* ---------- 爆帖灵感（发帖窗口专用）----------
   * 主页/个人页的发帖框没有「回复对象」，原回复菜单在这里全部无从下手；
   * 改为结合时间线热点与用户领域备注，生成发帖选题方向，
   * 每条可一键扩写成完整草稿填入发帖框（仍由用户审核后手动发送）。
   */

  // 收集当前时间线上可见推文的文本作为热点参考（去重、截断）
  function collectHotTweets(n) {
    const seen = {};
    const out = [];
    const arts = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
    for (let i = 0; i < arts.length && out.length < n; i++) {
      const a = arts[i];
      if (a.parentElement && a.parentElement.closest('article')) continue;
      const te = a.querySelector('[data-testid="tweetText"]');
      if (!te) continue;
      let t = (te.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 8) continue;
      if (t.length > 100) t = t.slice(0, 100) + '…';
      const key = t.slice(0, 24);
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(t);
    }
    return out;
  }

  const IDEA_KINDS = [
    { label: '热点借势', icon: '🔥', sys: '结合当下正在讨论的热点话题给出借势选题：角度要新，不要复读热门观点，避开敏感争议事件' },
    { label: '干货清单', icon: '💎', sys: '围绕用户的领域给出干货类选题：清单、避坑、经验总结、工具推荐，强调对读者有实际用处' },
    { label: '提问互动', icon: '🙋', sys: '给出能引发评论和讨论的提问式选题：问题要具体、有张力，让人有话说，不要泛泛的「大家怎么看」' },
    { label: '观点金句', icon: '💡', sys: '给出有态度、容易被转发的观点/金句类选题：可以反常识但必须站得住脚，一句顶十句' },
    { label: '真诚分享', icon: '📖', sys: '给出个人经历类选题：踩坑、成长、转折点，真实具体有细节，不鸡汤不吹嘘' },
    { label: '轻松段子', icon: '😄', sys: '给出幽默段子类选题：反差、自嘲、神转折，让人会心一笑想转发；梗要新，不炒冷梗，不低俗不刻薄' }
  ];

  function resetAiBtn(btn) {
    btn.innerHTML = SPARK_SVG + '<span>AI</span>';
    btn.style.pointerEvents = '';
  }

  // 用户在发帖框里已经输入的内容（可为空）：选题要顺着它来
  function composerTyped(toolbar) {
    let root = toolbar.parentElement;
    for (let i = 0; i < 8 && root; i++) {
      const ed = firstEditorIn(root);
      if (ed) return (ed.innerText || '').trim();
      root = root.parentElement;
    }
    return '';
  }

  function ideaGenerate(btn, toolbar, kind) {
    if (!aiCfg || !aiCfg.key) { aiSetup(); return; }
    btn.innerHTML = '<span>生成中…</span>';
    btn.style.pointerEvents = 'none';
    const sys = '你在帮用户在 X（推特）上发能火的帖子，任务：给出 5 条发帖选题。' + kind.sys + '。硬性要求：\n' +
      '- 每条两行，格式严格如下（共 5 条，编号 1~5）：\n' +
      '1.【方向】一句话说清这条帖子写什么角度\n钩子：可直接粘贴使用的开头一句，15~30 字，有钩子感\n' +
      '- 只输出这 5 条，不要解释、不要前后缀、不要分隔线\n' +
      '- 中文，口语化，像真人随手打的' +
      styleNotes(aiCfg.notes);
    const typed = composerTyped(toolbar);
    let userMsg = '';
    if (typed) userMsg += '用户已在发帖框输入（选题顺着这个方向）：\n' + typed.slice(0, 300) + '\n\n';
    if (kind.label === '热点借势') {
      const hot = collectHotTweets(8);
      userMsg += '当前时间线上的热点参考（仅作话题参考，不要照抄原文）：\n' +
        (hot.length ? hot.map((t, i) => (i + 1) + '. ' + t).join('\n') : '（未获取到，自行判断近期大众话题）');
    } else if (!typed && aiCfg.notes) {
      userMsg += '用户关注的领域见个人风格备注，围绕它展开。';
    }
    aiCall(sys, userMsg || '（用户未输入内容，自由发挥）', (out, err) => {
      resetAiBtn(btn);
      if (err) { showAiCard('爆帖灵感失败', err, null, null); return; }
      const blocks = out.trim().split(/\n(?=\d+\s*[.、【])/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
      showIdeaCard('爆帖灵感 · ' + kind.label, blocks.length ? blocks : [out.trim()], toolbar, out);
    });
  }

  // 选题卡片：每条选题独立成块，附「写成草稿」按钮 → 扩写成完整推文填入发帖框
  let ideaCardEl = null;
  function showIdeaCard(title, blocks, toolbar, raw) {
    if (ideaCardEl) ideaCardEl.remove();
    const dark = detectTheme() === 'dark';
    const c = document.createElement('div');
    ideaCardEl = c;
    c.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483120;width:400px;max-width:92vw;' +
      'max-height:70vh;display:flex;flex-direction:column;border-radius:14px;overflow:hidden;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.35);font-family:inherit;' +
      (dark ? 'background:#16181c;color:#e7e9ea;border:1px solid rgba(255,255,255,.14);' : 'background:#fff;color:#0f1419;border:1px solid rgba(0,0,0,.1);');
    const hd = document.createElement('div');
    hd.style.cssText = 'display:flex;align-items:center;gap:6px;padding:10px 14px;font-weight:700;font-size:13px;border-bottom:1px solid ' + (dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.08)') + ';';
    hd.innerHTML = SPARK_SVG + '<span></span><i style="margin-left:auto;cursor:pointer;font-style:normal;opacity:.6;padding:0 4px;">✕</i>';
    hd.querySelector('span').textContent = title;
    hd.querySelector('i').addEventListener('click', () => { c.remove(); if (ideaCardEl === c) ideaCardEl = null; });
    const body = document.createElement('div');
    body.style.cssText = 'padding:10px 12px;overflow-y:auto;font-size:13px;line-height:1.6;display:flex;flex-direction:column;gap:8px;';
    const expandSys = '你在帮用户把一条发帖选题扩写成可直接发布到 X 的中文推文草稿：\n' +
      '- 像真人随手打的口语，自然、有个性\n- 280 字以内，最多 2 个 emoji，不要 hashtag 堆砌\n' +
      '- 直接输出内容本身，不要引号、解释或前后缀' +
      styleNotes(aiCfg.notes);
    for (let i = 0; i < blocks.length; i++) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:10px;' +
        (dark ? 'background:rgba(255,255,255,.05);' : 'background:rgba(0,0,0,.035);');
      const tx = document.createElement('div');
      tx.style.cssText = 'flex:1 1 auto;white-space:pre-wrap;word-break:break-word;';
      tx.textContent = blocks[i];
      const go = document.createElement('button');
      go.textContent = '✍️ 草稿';
      go.style.cssText = 'flex:0 0 auto;padding:5px 10px;border-radius:999px;border:0;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit;white-space:nowrap;' +
        'background:#1d9bf0;color:#fff;';
      go.addEventListener('click', () => {
        go.textContent = '生成中…';
        go.style.pointerEvents = 'none';
        aiCall(expandSys, '选题：\n' + blocks[i], (draft, err) => {
          go.textContent = '✍️ 草稿';
          go.style.pointerEvents = '';
          if (err) { renderToast(err); return; }
          insertReply(toolbar, draft, (filled) => {
            if (filled) renderToast('草稿已填入发帖框，由你审核后发送');
          });
        });
      });
      row.appendChild(tx); row.appendChild(go);
      body.appendChild(row);
    }
    const ft = document.createElement('div');
    ft.style.cssText = 'display:flex;gap:8px;padding:10px 14px;border-top:1px solid ' + (dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.08)') + ';';
    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'flex:0 0 auto;padding:6px 14px;border-radius:999px;border:0;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit;' +
        (dark ? 'background:rgba(255,255,255,.12);color:#e7e9ea;' : 'background:#eff3f4;color:#0f1419;');
      b.addEventListener('click', fn);
      return b;
    };
    ft.appendChild(mkBtn('复制全部', () => {
      try { navigator.clipboard.writeText(raw); renderToast('已复制全部选题'); } catch (e) {}
    }));
    c.appendChild(hd); c.appendChild(body); c.appendChild(ft);
    document.documentElement.appendChild(c);
  }

  /* ---------- 文案优化（发帖框里已写好内容时）----------
   * 与「校对排版」的区别：校对只纠错别字/标点/分段，不动写法；
   * 文案优化会给诊断 + 改写版 + 两个不同角度的备选，且可一键替换发帖框内容。
   */

  function aiOptimizeDraft(toolbar) {
    if (!aiCfg || !aiCfg.key) { aiSetup(); return; }
    const text = composerTyped(toolbar);
    if (!text) { renderToast('发帖框还是空的，先写点内容再优化'); return; }
    renderToast('AI 文案优化中…');
    const sys = '你是资深推文文案优化师。用户发来一条他自己写好的 X（推特）发帖草稿，请完成：\n' +
      '- 【诊断】用 2~3 条要点指出主要问题（钩子是否抓人、结构、口语感、长度），直接说问题，不客套\n' +
      '- 【优化版】在保留原意的前提下改写成更抓人的版本，280 字以内，像真人随手打的口语\n' +
      '- 【备选 A】换一个切入角度或结构的版本\n' +
      '- 【备选 B】换一种风格的版本（更犀利或更幽默，选与内容更搭的）\n' +
      '- 严格使用【诊断】【优化版】【备选 A】【备选 B】四个分节标记，节内不要再加小标题或编号\n' +
      '- 不要 hashtag 堆砌，不要解释改法，不要任何前后缀' +
      styleNotes(aiCfg.notes);
    aiCall(sys, text.slice(0, 600), (out, err) => {
      if (err) { showAiCard('文案优化失败', err, null, null); return; }
      const secs = parseDraftSections(out);
      if (secs) {
        showOptimizeCard('文案优化', secs, toolbar, out);
      } else {
        // 模型没按分节格式输出：整卡展示，整体填入兜底
        showAiCard('文案优化结果', out, '填入发帖框', () => {
          insertReply(toolbar, out.trim(), (filled) => {
            if (filled) renderToast('已填入发帖框（原内容已替换），由你审核后发布');
          });
        });
      }
    });
  }

  // 按【诊断】【优化版】【备选 A】【备选 B】分节解析；缺优化版视为解析失败
  function parseDraftSections(out) {
    const marks = ['【诊断】', '【优化版】', '【备选 A】', '【备选 B】'];
    const pos = marks.map((mk) => out.indexOf(mk));
    if (pos[1] === -1) return null;
    const cut = (i, j) => {
      if (pos[i] === -1) return '';
      const end = (j !== undefined && pos[j] !== -1) ? pos[j] : out.length;
      return out.slice(pos[i] + marks[i].length, end).trim();
    };
    const secs = { diag: cut(0, 1), main: cut(1, 2), altA: cut(2, 3), altB: cut(3) };
    return secs.main ? secs : null;
  }

  // 优化结果卡片：诊断（纯展示）+ 优化版/备选（各带「填入发帖框」按钮）
  let optCardEl = null;
  function showOptimizeCard(title, secs, toolbar, raw) {
    if (optCardEl) optCardEl.remove();
    const dark = detectTheme() === 'dark';
    const c = document.createElement('div');
    optCardEl = c;
    c.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483120;width:400px;max-width:92vw;' +
      'max-height:70vh;display:flex;flex-direction:column;border-radius:14px;overflow:hidden;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.35);font-family:inherit;' +
      (dark ? 'background:#16181c;color:#e7e9ea;border:1px solid rgba(255,255,255,.14);' : 'background:#fff;color:#0f1419;border:1px solid rgba(0,0,0,.1);');
    const hd = document.createElement('div');
    hd.style.cssText = 'display:flex;align-items:center;gap:6px;padding:10px 14px;font-weight:700;font-size:13px;border-bottom:1px solid ' + (dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.08)') + ';';
    hd.innerHTML = SPARK_SVG + '<span></span><i style="margin-left:auto;cursor:pointer;font-style:normal;opacity:.6;padding:0 4px;">✕</i>';
    hd.querySelector('span').textContent = title;
    hd.querySelector('i').addEventListener('click', () => { c.remove(); if (optCardEl === c) optCardEl = null; });
    const body = document.createElement('div');
    body.style.cssText = 'padding:10px 12px;overflow-y:auto;font-size:13px;line-height:1.6;display:flex;flex-direction:column;gap:8px;';
    const addBlock = (label, text, btn) => {
      if (!text) return;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:10px;' +
        (dark ? 'background:rgba(255,255,255,.05);' : 'background:rgba(0,0,0,.035);');
      const wrap = document.createElement('div');
      wrap.style.cssText = 'flex:1 1 auto;min-width:0;';
      const lb = document.createElement('div');
      lb.style.cssText = 'font-size:11px;font-weight:700;opacity:.55;margin-bottom:3px;letter-spacing:.05em;';
      lb.textContent = label;
      const tx = document.createElement('div');
      tx.style.cssText = 'white-space:pre-wrap;word-break:break-word;';
      tx.textContent = text;
      wrap.appendChild(lb); wrap.appendChild(tx);
      row.appendChild(wrap);
      if (btn) {
        const go = document.createElement('button');
        go.textContent = '填入发帖框';
        go.style.cssText = 'flex:0 0 auto;padding:5px 10px;border-radius:999px;border:0;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit;white-space:nowrap;' +
          (btn === 'primary' ? 'background:#1d9bf0;color:#fff;' :
            (dark ? 'background:rgba(255,255,255,.12);color:#e7e9ea;' : 'background:#eff3f4;color:#0f1419;'));
        go.addEventListener('click', () => {
          // insertReply 会先清空编辑框再插入 —— 语义就是「替换」
          insertReply(toolbar, text, (filled) => {
            if (filled) renderToast('已填入发帖框（原内容已替换），由你审核后发布');
          });
        });
        row.appendChild(go);
      }
      body.appendChild(row);
    };
    addBlock('诊断', secs.diag);
    addBlock('优化版（推荐）', secs.main, 'primary');
    addBlock('备选 A · 换角度', secs.altA, 'alt');
    addBlock('备选 B · 换风格', secs.altB, 'alt');
    const ft = document.createElement('div');
    ft.style.cssText = 'display:flex;gap:8px;padding:10px 14px;border-top:1px solid ' + (dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.08)') + ';';
    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'flex:0 0 auto;padding:6px 14px;border-radius:999px;border:0;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit;' +
        (dark ? 'background:rgba(255,255,255,.12);color:#e7e9ea;' : 'background:#eff3f4;color:#0f1419;');
      b.addEventListener('click', fn);
      return b;
    };
    ft.appendChild(mkBtn('复制全部', () => {
      try { navigator.clipboard.writeText(raw); renderToast('已复制全部内容'); } catch (e) {}
    }));
    c.appendChild(hd); c.appendChild(body); c.appendChild(ft);
    document.documentElement.appendChild(c);
  }

  // 发帖框专用菜单：文案优化 + 爆帖灵感选题方向（无回复工具/回复风格）
  function openIdeaMenu(btn, toolbar, cx, cy) {
    closeAiMenu();
    document.querySelectorAll('#xam-ai-menu').forEach((el) => { try { el.remove(); } catch (e) {} });
    const dark = detectTheme() === 'dark';
    const m = document.createElement('div');
    m.id = 'xam-ai-menu';
    aiMenuEl = m;
    m.style.cssText = 'position:fixed;inset:auto;margin:0;z-index:2147483100;width:216px;padding:6px;border-radius:12px;font-size:13px;box-shadow:0 8px 28px rgba(0,0,0,.25);' +
      'max-height:min(430px,72vh);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;' +
      (dark ? 'background:#16181c;color:#e7e9ea;border:1px solid rgba(255,255,255,.12);' : 'background:#fff;color:#0f1419;border:1px solid rgba(0,0,0,.08);');
    const mk = (label, fn, grid) => {
      const it = document.createElement('div');
      it.style.cssText = 'padding:7px 10px;border-radius:8px;cursor:pointer;line-height:1.25;white-space:nowrap;';
      it.textContent = label;
      it.addEventListener('mouseenter', () => { it.style.background = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.05)'; });
      it.addEventListener('mouseleave', () => { it.style.background = 'transparent'; });
      it.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeAiMenu();
        fn();
      });
      return it;
    };
    const cap = (t) => {
      const c = document.createElement('div');
      c.style.cssText = 'padding:4px 10px 2px;font-size:10px;letter-spacing:.05em;opacity:.5;user-select:none;';
      c.textContent = t;
      m.appendChild(c);
    };
    const sep = () => {
      const s = document.createElement('div');
      s.style.cssText = 'height:1px;margin:5px 4px;background:' + (dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.08)') + ';';
      m.appendChild(s);
    };
    const hasKey = !!(aiCfg && aiCfg.key);
    if (!hasKey) m.appendChild(mk('⚙ 先设置 AI 接口', aiSetup));
    cap('文案打磨');
    m.appendChild(mk('✨ 文案优化', () => aiOptimizeDraft(toolbar)));
    sep();
    cap(hasKey ? '爆帖灵感' : '爆帖灵感（先配置接口）');
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:2px;';
    for (let i = 0; i < IDEA_KINDS.length; i++) {
      const k = IDEA_KINDS[i];
      grid.appendChild(mk(k.icon + ' ' + k.label, () => ideaGenerate(btn, toolbar, k), true));
    }
    m.appendChild(grid);
    sep();
    m.appendChild(mk('🧹 校对排版', () => aiProofread(toolbar)));
    document.documentElement.appendChild(m);
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'touchstart'].forEach((ev) => {
      m.addEventListener(ev, (e) => e.stopPropagation());
    });
    positionMenu(m, btn, cx, cy);
    setTimeout(() => document.addEventListener('mousedown', aiDocDown, true), 0);
  }

  /* ---------- 推文海报（BlueV 同款思路，全部本地 canvas 完成，不上传） ---------- */

  function posterWrapText(ctx, text, maxW) {
    const out = [];
    const paras = String(text).split(/\n/);
    for (let p = 0; p < paras.length; p++) {
      const para = paras[p];
      if (!para) { out.push(''); continue; }
      let line = '';
      const tokens = para.match(/[A-Za-z0-9@#_$'’\-.\/]+|\s+|[\s\S]/g) || [];
      for (let i = 0; i < tokens.length; i++) {
        const tk = tokens[i];
        const test = line + tk;
        if (ctx.measureText(test).width > maxW && line) {
          out.push(line.replace(/\s+$/, ''));
          line = tk.replace(/^\s+/, '');
        } else {
          line = test;
        }
      }
      if (line) out.push(line.replace(/\s+$/, ''));
    }
    return out;
  }

  function makePoster(toolbar) {
    // 找当前推文卡片（与 aiContext 同逻辑，但要完整正文与头像）
    const arts = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
    let best = null;
    for (let i = 0; i < arts.length; i++) {
      const a = arts[i];
      if (a.parentElement && a.parentElement.closest('article')) continue;
      const r = a.getBoundingClientRect();
      if (r.top >= -100 && r.top < window.innerHeight * 0.7) { best = a; break; }
    }
    if (!best && arts.length) best = arts[0];
    if (!best) { renderToast('没有找到推文'); return; }
    const te = best.querySelector('[data-testid="tweetText"]');
    const text = te ? (te.innerText || '').trim() : '';
    if (!text) { renderToast('没有找到推文内容'); return; }
    const handle = detectHandle(best) || 'unknown';
    const name = detectName(best, handle);
    const tEl = best.querySelector('time[datetime]');
    const dt = tEl ? new Date(Date.parse(tEl.getAttribute('datetime') || '')) : new Date();
    const avUrl = detectAvatar(best).replace(/_normal/, '_400x400');

    renderToast('正在生成海报…');
    const draw = (avImg) => {
      try {
        const W = 1080, pad = 84, textW = W - pad * 2;
        const mc = document.createElement('canvas').getContext('2d');
        const T_FONT = '36px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
        mc.font = T_FONT;
        const lines = posterWrapText(mc, text.slice(0, 1600), textW).slice(0, 26);
        const lh = 56;
        const headH = 220;
        const H = headH + lines.length * lh + 150;
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const ctx = c.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, '#0f1419');
        g.addColorStop(1, '#173b57');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#1d9bf0';
        ctx.fillRect(0, 0, 10, H);
        // 头像
        const ax = pad, ay = 64, ar = 44;
        if (avImg) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(ax + ar, ay + ar, ar, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(avImg, ax, ay, ar * 2, ar * 2);
          ctx.restore();
        } else {
          ctx.fillStyle = 'rgba(29,155,240,.25)';
          ctx.beginPath();
          ctx.arc(ax + ar, ay + ar, ar, 0, Math.PI * 2);
          ctx.fill();
        }
        // 名字与账号
        const nx = ax + (avImg ? ar * 2 + 24 : 0);
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 40px ' + T_FONT.slice(6);
        ctx.fillText(name, nx, ay + 40, W - pad - nx);
        ctx.fillStyle = 'rgba(255,255,255,.55)';
        ctx.font = '30px ' + T_FONT.slice(6);
        ctx.fillText('@' + handle, nx, ay + 84);
        // 正文
        ctx.font = T_FONT;
        ctx.fillStyle = '#f7f9f9';
        let y = headH - lh + 46;
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], pad, y);
          y += lh;
        }
        // 底部
        ctx.fillStyle = 'rgba(255,255,255,.45)';
        ctx.font = '26px ' + T_FONT.slice(6);
        ctx.fillText(dt.toLocaleDateString('zh-CN') + ' · 来自 X', pad, H - 56);
        ctx.fillStyle = '#1d9bf0';
        ctx.font = '700 40px ' + T_FONT.slice(6);
        ctx.textAlign = 'right';
        ctx.fillText('𝕏', W - pad, H - 56);
        ctx.textAlign = 'left';
        c.toBlob((blob) => {
          if (!blob) { renderToast('海报生成失败'); return; }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'xam-poster-' + handle + '-' + Date.now() + '.png';
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
          renderToast('海报已保存到下载');
        }, 'image/png');
      } catch (e) {
        renderToast('海报生成失败：' + e.message);
      }
    };
    if (avUrl) {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => draw(im);
      im.onerror = () => draw(null);
      im.src = avUrl;
    } else {
      draw(null);
    }
  }



  let aiMenuEl = null;   // 当前打开的 AI 菜单元素（曾漏声明导致 openAiMenu 抛 ReferenceError）

  function aiDocDown(e) {
    if (aiMenuEl && !aiMenuEl.contains(e.target)) closeAiMenu();
  }

  // 事件委托：document 捕获阶段统一接管所有 AI 按钮点击（按钮节点可被 React 随意替换）
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('.xam-ai-btn') : null;
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const bar = t.closest('div[data-testid="toolBar"]');
      // dataset 可能随 React 换节点丢失，丢了现场重新判定
      const mode = t.dataset.xamMode || (bar ? composerModeOf(bar) : 'reply');
      if (mode === 'post') openIdeaMenu(t, bar, e.clientX, e.clientY);
      else openAiMenu(t, bar, e.clientX, e.clientY);
    }
    catch (err) { console.error('[XAM] AI 菜单打开失败：', err); }
  }, true);

  function closeAiMenu() {
    if (aiMenuEl) { aiMenuEl.remove(); aiMenuEl = null; }
    document.removeEventListener('mousedown', aiDocDown, true);
  }

  function openAiMenu(btn, toolbar, cx, cy) {
    closeAiMenu();
    // 清掉页面上的残留菜单：包括旧版本脚本（孤儿）创建的、没有 id 的菜单。
    // 判据：inline style 里 position:fixed 且文本含「生成海报」+「仿写此推」的短元素
    document.querySelectorAll('div[style]').forEach((el) => {
      const st = el.getAttribute('style') || '';
      if (st.indexOf('position: fixed') === -1 && st.indexOf('position:fixed') === -1) return;
      const t = el.textContent || '';
      if (t.indexOf('生成海报') !== -1 && t.indexOf('仿写此推') !== -1 && t.length < 600) {
        try { el.remove(); } catch (e) {}
      }
    });
    document.querySelectorAll('#xam-ai-menu').forEach((el) => { try { el.remove(); } catch (e) {} });
    const dark = detectTheme() === 'dark';
    const m = document.createElement('div');
    m.id = 'xam-ai-menu';
    aiMenuEl = m;
    m.style.cssText = 'position:fixed;inset:auto;margin:0;z-index:2147483100;width:216px;padding:6px;border-radius:12px;font-size:13px;box-shadow:0 8px 28px rgba(0,0,0,.25);' +
      'max-height:min(430px,72vh);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;' +
      (dark ? 'background:#16181c;color:#e7e9ea;border:1px solid rgba(255,255,255,.12);' : 'background:#fff;color:#0f1419;border:1px solid rgba(0,0,0,.08);');
    // 单行紧凑条目（不带描述行）：菜单整体高度减半，不再盖住整条推文
    const mk = (label, fn, grid) => {
      const it = document.createElement('div');
      it.style.cssText = 'padding:7px 10px;border-radius:8px;cursor:pointer;line-height:1.25;white-space:nowrap;' +
        (grid ? '' : 'margin:0;');
      it.textContent = label;
      it.addEventListener('mouseenter', () => { it.style.background = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.05)'; });
      it.addEventListener('mouseleave', () => { it.style.background = 'transparent'; });
      it.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeAiMenu();
        fn();
      });
      return it;
    };
    const sep = () => {
      const s = document.createElement('div');
      s.style.cssText = 'height:1px;margin:5px 4px;background:' + (dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.08)') + ';';
      m.appendChild(s);
    };
    const hasKey = !!(aiCfg && aiCfg.key);
    // 分组小标题：10px 灰字，视觉上把工具和风格分开
    const cap = (t) => {
      const c = document.createElement('div');
      c.style.cssText = 'padding:4px 10px 2px;font-size:10px;letter-spacing:.05em;opacity:.5;user-select:none;';
      c.textContent = t;
      m.appendChild(c);
    };
    if (!hasKey) m.appendChild(mk('⚙ 先设置 AI 接口', aiSetup));
    // 8 种回复风格：两列网格 + 图标，压缩纵向空间。
    // 风格是高频操作，放在「回复工具」上面（2026-11-04 用户要求）
    const STYLE_ICONS = {
      '智能匹配': '✨', '赞同共鸣': '👍', '补充观点': '🧩', '友好提问': '🙋',
      '专业分析': '📊', '幽默轻松': '😄', '礼貌反驳': '⚖️', '简短支持': '💪'
    };
    cap(hasKey ? '回复风格' : 'AI 回复风格（先配置接口）');
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:2px;';
    for (let i = 0; i < AI_STYLES.length; i++) {
      const st = AI_STYLES[i];
      grid.appendChild(mk((STYLE_ICONS[st.label] || '·') + ' ' + st.label, () => {
        if (!hasKey) { aiSetup(); return; }
        aiGenerate(btn, toolbar, st);
      }, true));
    }
    m.appendChild(grid);
    if (hasKey) {
      // 换一条 / 一键发布：常驻菜单项（右下角操作条只在生成后短暂出现）
      sep();
      cap('不满意？');
      const act = document.createElement('div');
      act.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:2px;';
      act.appendChild(mk('🔄 换一条', () => {
        const live = document.contains(toolbar) ? toolbar : document.querySelector('div[data-testid="toolBar"]');
        if (!live) { renderToast('回复框已关闭'); return; }
        aiGenerate(btn, live, lastReplyStyle || AI_STYLES.find((s) => s.label === '智能匹配'), recentReplies.slice());
      }, true));
      act.appendChild(mk('🚀 一键发布', () => {
        const live = document.contains(toolbar) ? toolbar : document.querySelector('div[data-testid="toolBar"]');
        publishReply(live);
      }, true));
      m.appendChild(act);
      // 回复工具组（借鉴 BlueV）：仿写 / 翻译 / 校对排版，双栏与风格区一致
      sep();
      cap('回复工具');
      const tools = document.createElement('div');
      tools.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:2px;';
      tools.appendChild(mk('✍️ 仿写此推', () => aiRewrite(toolbar), true));
      tools.appendChild(mk('🌐 翻译此推', () => aiTranslate(), true));
      tools.appendChild(mk('🧹 校对排版', () => aiProofread(toolbar), true));
      m.appendChild(tools);
    }
    sep();
    // 海报不依赖 AI Key，始终可用；接口/风格统一在扩展设置页配置，菜单里不再占位
    m.appendChild(mk('🖼 生成海报', () => makePoster(toolbar)));
    // 菜单挂到根节点 + 尽量进浏览器顶层（popover）：
    // 1) 弹窗容器常有 transform 动画，transform 祖先会把 position:fixed 变成相对该祖先定位、
    //    再被 overflow 裁剪 → 菜单其实创建了但看不见，同样表现为「点了没反应」
    // 2) 顶层渲染不受任何 z-index / transform / overflow 影响，永远置顶可见
    // 不用 popover：popover 自带 UA 样式（inset:0 + margin:auto 居中），
    // 会和下面设置的 left/top 打架，导致菜单跑到屏幕中间/右侧
    document.documentElement.appendChild(m);
    // 菜单内的事件不再向外传播，避免 X 把这些点击当成「点在弹窗外」而关掉弹窗
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'touchstart'].forEach((ev) => {
      m.addEventListener(ev, (e) => e.stopPropagation());
    });
    positionMenu(m, btn, cx, cy);
    setTimeout(() => document.addEventListener('mousedown', aiDocDown, true), 0);
  }

  // 菜单定位：锚定点击坐标（点哪弹哪），按钮 rect 只作兜底——弹窗里 X 会保留
  // 隐藏的合成器克隆节点，按钮 rect 可能取到克隆的屏幕外「幽灵位置」
  function positionMenu(m, btn, cx, cy) {
    const r = btn.getBoundingClientRect();
    const mw = m.offsetWidth || 216;
    const mh = m.offsetHeight || 330;
    const ax = (typeof cx === 'number' && cx > 0) ? cx : r.right;   // 锚点：点击处 / 按钮右下
    const ay = (typeof cy === 'number' && cy > 0) ? cy : r.bottom;
    let left = ax - mw;
    let top;
    if (ay + 10 + mh <= window.innerHeight - 8) {
      top = ay + 10;                       // 下方放得下 → 紧贴点击点下方
    } else {
      top = Math.max(8, ay - mh - 8);      // 放不下 → 底边贴着点击点上方
    }
    if (left < 8) left = 8;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    if (top < 8) top = 8;
    m.style.left = left + 'px';
    m.style.top = top + 'px';
    try {
      console.log('[XAM] AI 菜单位置', { left: left, top: top, cx: cx, cy: cy, rect: { l: r.left, t: r.top, w: r.width }, vw: window.innerWidth, vh: window.innerHeight });
    } catch (e) {}
  }

  try {
    chrome.storage.local.get([AI_CFG_KEY], (res) => {
      aiCfg = (res && res[AI_CFG_KEY]) || {};
    });
  } catch (e) {}

  /* ---------- 限流检测：后台临时标签页内的本地采集 ----------
   * 只读取当前页面 DOM，不调用任何外部接口、不上传数据。
   * 采集失败一律返回「无法判定」，绝不把读取失败当成「正常」。
   */
  function limitParseCount(s) {
    if (!s) return null;
    const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([KkMm万]?)/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    if (/[Kk]/.test(m[2])) n *= 1e3;
    else if (/[Mm]/.test(m[2])) n *= 1e6;
    else if (m[2] === '万') n *= 1e4;
    return Math.round(n);
  }

  function limitProfileData(handle) {
    const body = (document.body && document.body.innerText) || '';
    let state = 'unknown';
    if (/Account suspended|已被停用|账号已停用|has been suspended/i.test(body)) state = 'suspended';
    else if (/doesn'?t exist|账号不存在|用户不存在|does not exist/i.test(body)) state = 'missing';
    else if (document.querySelector('[data-testid="primaryColumn"]') ||
             document.querySelector('article[data-testid="tweet"]')) state = 'ok';
    const isProtected = /These posts are protected|这些帖子受保护|受保护的帖子/i.test(body);

    let followers = null;
    const fl = document.querySelector('a[href$="/followers"], a[href*="/followers"]');
    if (fl) followers = limitParseCount(fl.getAttribute('aria-label') || fl.textContent || '');

    const arts = Array.prototype.slice.call(
      document.querySelectorAll('article[data-testid="tweet"]')
    ).slice(0, 12);
    const engs = [];
    arts.forEach((art) => {
      const grp = art.querySelector('div[role="group"]');
      if (!grp) return;
      const read = (id) => {
        const el = grp.querySelector('[data-testid="' + id + '"]');
        if (!el) return 0;
        return limitParseCount(el.getAttribute('aria-label') || el.innerText || '') || 0;
      };
      const sum = read('reply') + read('retweet') + read('like');
      if (sum > 0) engs.push(sum);
    });
    const avgEng = engs.length
      ? Math.round(engs.reduce((a, b) => a + b, 0) / engs.length) : null;
    const ownTweets = arts.filter((a) =>
      a.querySelector('a[href^="/' + handle + '/status/"]')).length;
    return {
      ok: true, task: 'profile', state: state, protected: isProtected,
      followers: followers, visibleTweets: arts.length, ownTweets: ownTweets,
      avgEng: avgEng, engSamples: engs.length
    };
  }

  function limitSearchData(handle) {
    const body = (document.body && document.body.innerText) || '';
    const arts = Array.prototype.slice.call(
      document.querySelectorAll('article[data-testid="tweet"]')
    );
    const ownHits = arts.filter((a) =>
      a.querySelector('a[href^="/' + handle + '/status/"]')).length;
    return {
      ok: true, task: 'search', resultCount: arts.length, ownHits: ownHits,
      noResult: /No results for|没有找到|没有结果|Try searching for/i.test(body),
      error: /Something went wrong|出错了|Try again|重试/i.test(body)
    };
  }

  function limitProbe(task, handle) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const body = (document.body && document.body.innerText) || '';
        const arts = document.querySelectorAll('article[data-testid="tweet"]').length;
        const ready = arts > 0 ||
          /Account suspended|doesn'?t exist|账号不存在|No results|没有结果|Something went wrong|出错了/i.test(body);
        if (ready || Date.now() - started > 12000) {
          resolve(task === 'search' ? limitSearchData(handle) : limitProfileData(handle));
          return;
        }
        setTimeout(tick, 600);
      };
      tick();
    });
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'xam_limit_probe') return;
      limitProbe(msg.task, msg.handle)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;   // 异步响应
    });
  } catch (e) {}


  // 滚动感知：用户滚动期间完全不扫描。
  // 停在顶部时 X 会持续拉流新推文，MutationObserver 高频触发全量扫描，
  // 每条推文多次写 DOM 造成主线程饱和，滚轮事件得不到处理 → 表现为「滚不动、卡在顶部」
  let lastScrollAt = 0;
  let lastScrollTop = 0;
  let suppressUntil = 0;    // 跳回顶部后的静默期：让 X 自己完成位置校正，不与之抢 DOM
  let topGuard = false;     // 顶部保护区：回到顶部后，只要还停在顶部就不扫描（否则 X 的
                            // 虚拟列表锚点会被我们的 DOM 写入打断，出现「下拉一点被弹回顶部」）
  let topGuardUntil = 0;
  let wasFarAt = 0;         // 最近一次处于远处（>600px）的时间
  const TOP_ZONE = 160;     // 顶部区域阈值 px
  const curTop = () => {
    const se = document.scrollingElement;
    return se ? se.scrollTop : (window.pageYOffset || 0);
  };
  window.addEventListener('scroll', (e) => {
    lastScrollAt = Date.now();
    let top = 0;
    const t = e.target;
    if (t && typeof t.scrollTop === 'number' && t !== document && t !== document.documentElement) top = t.scrollTop;
    else top = curTop();
    if (top > 600) wasFarAt = Date.now();
    // 回到顶部（无论整段跳转还是「返回顶部」扩展的平滑滚动）：近期从远处过来即触发保护
    if (!topGuard && top < TOP_ZONE && Date.now() - wasFarAt < 5000 && lastScrollTop > TOP_ZONE) {
      suppressUntil = Date.now() + 3000;
      topGuard = true;
      topGuardUntil = Date.now() + 15000;   // 保护上限 15s，防误判把首屏扫描永久关掉
      try { console.log('[XAM] 检测到回到顶部，进入顶部保护区'); } catch (err) {}
    }
    if (topGuard && top > TOP_ZONE) topGuard = false;   // 用户离开顶部区，恢复正常扫描
    lastScrollTop = top;
    try { window.__XAM_TOPGUARD = topGuard; } catch (err) {}   // 供 backup.js 同步避让
  }, { capture: true, passive: true });

  function scheduleScan(delay) {
    if (scanTimer) return;   // 已有待执行扫描就不再叠加，避免持续滚动时被反复重置
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (Date.now() < suppressUntil) { scheduleScan(400); return; }
      // 顶部保护区：跳回顶部后停留在顶部期间，一个字节都不写 DOM，
      // 完全让 X 稳定住虚拟列表（下拉不再被弹回）。超时或离开顶部后恢复
      if (topGuard && curTop() < TOP_ZONE) {
        if (Date.now() < topGuardUntil) { scheduleScan(500); return; }
        topGuard = false;
      }
      // 刚滚过（400ms 内）就推迟，等滚动停下来再扫
      if (Date.now() - lastScrollAt < 400) { scheduleScan(250); return; }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scan);
      else scan();
    }, typeof delay === 'number' ? delay : 200);
  }

  /* ---------- 面板 ---------- */

  const PANEL_CSS = `
:host { all: initial; }
.wrap {
  width: 306px; border-radius: 14px; overflow: hidden;
  background: #fff; border: 1px solid rgba(0,0,0,.08);
  box-shadow: 0 8px 28px rgba(0,0,0,.14);
  color: #0f1419;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 12px; line-height: 1.4;
  text-align: left;
}
.wrap[data-theme="dark"] {
  background: #16181c; border-color: rgba(255,255,255,.12);
  box-shadow: 0 8px 28px rgba(0,0,0,.6); color: #e7e9ea;
}
.hd { display: flex; align-items: center; gap: 6px; padding: 9px 12px; border-bottom: 1px solid rgba(0,0,0,.06); }
.wrap[data-theme="dark"] .hd { border-color: rgba(255,255,255,.08); }
.ttl { font-weight: 700; font-size: 12.5px; letter-spacing: .2px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: #00ba7c; flex: 0 0 auto; }
.dt { margin-left: auto; color: #536471; font-size: 11px; font-variant-numeric: tabular-nums; }
.wrap[data-theme="dark"] .dt { color: #71767b; }
.mini {
  border: 0; background: rgba(29,155,240,.12); color: #1d9bf0;
  border-radius: 999px; padding: 2px 9px; font-size: 11px; font-weight: 600;
  cursor: pointer; font-family: inherit;
}
.mini:hover { background: rgba(29,155,240,.2); }
.sum { padding: 7px 12px 5px; color: #536471; font-size: 11px; display: flex; gap: 8px; flex-wrap: wrap; }
.wrap[data-theme="dark"] .sum { color: #8b98a5; }
.sum b { color: #1d9bf0; font-variant-numeric: tabular-nums; font-weight: 700; }
.cols { display: flex; gap: 6px; position: sticky; top: 0; z-index: 2; padding: 2px 6px 4px; color: #8b98a5; font-size: 10px; background: #fff; }
.wrap[data-theme="dark"] .cols { background: #16181c; }
.cols .c-name { flex: 1; text-align: left; }
.cols .c-n { width: 26px; text-align: right; }
.cols .c-f { width: 54px; text-align: right; }
.list { max-height: 40vh; overflow-y: auto; padding: 0 6px 6px; scrollbar-width: thin; }
.row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 8px; }
.row:hover { background: rgba(29,155,240,.07); }
.row.me { background: rgba(29,155,240,.1); }
.av { width: 18px; height: 18px; border-radius: 50%; object-fit: cover; flex: 0 0 auto; background: #cfd9de; }
.nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm .h { color: #8b98a5; font-size: 10.5px; margin-left: 3px; }
.n { width: 26px; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; font-size: 11.5px; }
.n.f { width: 54px; font-size: 10px; font-weight: 500; color: #536471; overflow: hidden; white-space: nowrap; }
.wrap[data-theme="dark"] .n.f { color: #8b98a5; }
.n.z { color: #9aa4ae; font-weight: 400; }
.n.p { color: #1d9bf0; }
.n.c { color: #00ba7c; }
.n.r { color: #f91880; }
.ft { padding: 6px 12px 8px; color: #8b98a5; font-size: 10px; border-top: 1px solid rgba(0,0,0,.06); display: flex; gap: 10px; align-items: center; }
.wrap[data-theme="dark"] .ft { border-color: rgba(255,255,255,.08); }
.ft a { color: #1d9bf0; cursor: pointer; text-decoration: none; }
.ft a:hover { text-decoration: underline; }
.empty { padding: 20px 14px; text-align: center; color: #8b98a5; font-size: 11px; line-height: 1.7; }
.more { padding: 2px 12px 6px; color: #8b98a5; font-size: 10px; }
.diag { display: none; padding: 6px 12px 8px; font-size: 10px; line-height: 1.8; color: #8b98a5; border-top: 1px solid rgba(0,0,0,.06); }
.wrap[data-theme="dark"] .diag { border-color: rgba(255,255,255,.08); }
.diag .dl { display: inline-block; width: 54px; }
.diag .dv { color: #0f1419; font-variant-numeric: tabular-nums; }
.wrap[data-theme="dark"] .diag .dv { color: #e7e9ea; }
.diag .warn { color: #f7931a; }
.wrap.diag-on .diag { display: block; }
.hint { padding: 5px 8px; margin: 0 6px 6px; border-radius: 8px; background: rgba(247,147,26,.1); color: #c9720a; font-size: 10px; line-height: 1.6; }
.wrap[data-theme="dark"] .hint { background: rgba(247,147,26,.14); color: #f7931a; }
.toast { display: none; padding: 5px 12px; font-size: 10.5px; color: #1d9bf0; background: rgba(29,155,240,.08); border-top: 1px solid rgba(0,0,0,.04); }
.wrap[data-theme="dark"] .toast { border-color: rgba(255,255,255,.08); }
.row { cursor: pointer; }
.wrap.collapsed .sum, .wrap.collapsed .cols, .wrap.collapsed .list,
.wrap.collapsed .ft, .wrap.collapsed .more, .wrap.collapsed .diag { display: none; }
`;

  let host = null;
  let root = null;
  let wrap = null;
  let listEl = null;
  let sumEl = null;
  let moreEl = null;
  let diagEl = null;

  // 表头放进滚动区并吸顶，才能和数字列严格对齐（滚动条占位会挤偏表外的表头）
  const COLS_HTML = '<div class="cols"><span class="c-name">用户</span>' +
    '<span class="c-f">粉丝</span><span class="c-n">发</span><span class="c-n">评</span><span class="c-n">转</span></div>';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function detectTheme() {
    if (S.panelTheme === 'light') return 'light';
    if (S.panelTheme === 'dark') return 'dark';
    try {
      const bg = getComputedStyle(document.body).backgroundColor || '';
      const m = bg.match(/\d+(\.\d+)?/g);
      if (!m || m.length < 3) return 'light';
      const r = +m[0], g = +m[1], b = +m[2];
      return (0.299 * r + 0.587 * g + 0.114 * b) > 140 ? 'light' : 'dark';
    } catch (e) {
      return 'light';
    }
  }

  // 左侧面板的横向锚点：避开 X 的左侧导航栏（header[role="banner"]），
  // 贴到导航栏右缘之外，不遮挡 Home/探索/通知 等菜单项
  function leftAnchor() {
    let x = 16;
    try {
      const nav = document.querySelector('header[role="banner"]');
      if (nav) {
        const r = nav.getBoundingClientRect();
        if (r.width > 0 && r.right > 0 && r.right < window.innerWidth * 0.6) {
          x = Math.round(r.right + 12);
        }
      }
    } catch (e) {}
    return x;
  }

  // 按设置摆放面板：四角定位 + 自定义宽度
  function applyPanelLayout() {
    if (!host || !wrap) return;
    const off = 16;
    let css = 'all:initial;position:fixed;z-index:2147483000;pointer-events:auto;';
    if (S.panelPos === 'bl') css += 'left:' + leftAnchor() + 'px;bottom:96px;';
    else if (S.panelPos === 'tr') css += 'right:' + off + 'px;top:' + off + 'px;';
    else if (S.panelPos === 'tl') css += 'left:' + leftAnchor() + 'px;top:' + off + 'px;';
    else css += 'right:' + off + 'px;bottom:96px;';
    host.style.cssText = css;
    wrap.style.width = (S.panelWidth || 306) + 'px';
  }

  // 窗口尺寸变化时重算位置：X 左侧导航在窄窗口会收成图标栏，锚点随之变化
  let layoutTimer = null;
  window.addEventListener('resize', () => {
    if (layoutTimer) return;
    layoutTimer = setTimeout(() => { layoutTimer = null; applyPanelLayout(); }, 200);
  });

  function ensurePanel() {
    if (host || !document.documentElement || S.panelEnabled === false) return;
    host = document.createElement('div');
    host.id = 'xam-host';
    document.documentElement.appendChild(host);

    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;

    wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.setAttribute('data-theme', detectTheme());
    wrap.innerHTML = `
      <div class="hd">
        <span class="dot"></span>
        <span class="ttl">今日活跃</span>
        <span class="dt"></span>
        <button class="mini" data-act="toggle">收起</button>
      </div>
      <div class="sum"></div>
      <div class="list"></div>
      <div class="more"></div>
      <div class="diag"></div>
      <div class="toast"></div>
      <div class="ft"><a data-act="auto"></a><a data-act="diag" style="margin-left:auto">诊断</a><a data-act="set">设置</a><a data-act="clear">清空</a></div>
    `;

    root.appendChild(style);
    root.appendChild(wrap);
    applyPanelLayout();

    listEl = wrap.querySelector('.list');
    sumEl = wrap.querySelector('.sum');
    moreEl = wrap.querySelector('.more');
    diagEl = wrap.querySelector('.diag');

    wrap.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.getAttribute) return;
      const act = t.getAttribute('data-act');
      if (act === 'toggle') {
        state.ui.collapsed = !state.ui.collapsed;
        applyCollapsed();
        try { chrome.storage.local.set({ [UI_KEY]: state.ui }); } catch (err) {}
      } else if (act === 'sync') {
        startSync(t.getAttribute('data-handle'));
      } else if (act === 'auto') {
        state.ui.auto = !state.ui.auto;
        if (SET) SET.saveSettings({ autoSync: state.ui.auto });
        refreshAutoLink();
        renderToast(state.ui.auto ? '自动补全已开启：视口内的活跃用户会节流地自动补数据' : '自动补全已关闭');
      } else if (act === 'set') {
        // 打开设置页必须经后台 chrome.runtime.openOptionsPage()：
        // 网页上下文里的 window.open(chrome-extension://…) 会被浏览器当页面发起的
        // 导航拦截（资源不在 web_accessible_resources），表现就是「打开一个打不开的页面」
        try {
          chrome.runtime.sendMessage({ type: 'xam_open_options' }, () => void chrome.runtime.lastError);
        } catch (err) {}
      } else if (act === 'diag') {
        showDiag = !showDiag;
        wrap.classList.toggle('diag-on', showDiag);
        renderDiag();
      } else if (act === 'clear') {
        state.authors = {};
        recMap.clear();
        stats.stored = 0;
        stats.dup = 0;
        stats.notToday = 0;
        stats.bad = 0;
        persist(true);   // 清空要立即生效且不做并集合并，否则旧数据会被合并回来
        scheduleScan(0);
        scheduleRender();
      }
    });

    applyCollapsed();
    refreshAutoLink();
    setInterval(() => {
      if (!wrap) return;
      const th = detectTheme();
      if (wrap.getAttribute('data-theme') !== th) wrap.setAttribute('data-theme', th);
    }, 4000);
  }

  function refreshAutoLink() {
    if (!wrap) return;
    const el = wrap.querySelector('[data-act="auto"]');
    if (el) el.textContent = '自动补全：' + (state.ui.auto ? '开' : '关');
  }

  function applyCollapsed() {
    if (!wrap) return;
    wrap.classList.toggle('collapsed', !!state.ui.collapsed);
    const btn = wrap.querySelector('[data-act="toggle"]');
    if (btn) btn.textContent = state.ui.collapsed ? '展开' : '收起';
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, 250);
  }

  function render() {
    if (!wrap) return;
    const selfKey = state.self ? state.self.toLowerCase() : '';

    const rows = [];
    let tp = 0, tc = 0, tr = 0;
    for (const h in state.authors) {
      const a = state.authors[h];
      const p = a.post.length, c = a.reply.length, r = a.rt.length;
      tp += p; tc += c; tr += r;
      if (h === selfKey) continue;                      // 自己单独置顶
      rows.push({ h, name: a.name, avatar: a.avatar, fc: a.fc, p, c, r });
    }
    // 排序方式（设置页可选）
    const act = (x) => x.p + x.c;
    if (S.sortBy === 'post') rows.sort((x, y) => y.p - x.p || act(y) - act(x) || (x.h < y.h ? -1 : 1));
    else if (S.sortBy === 'reply') rows.sort((x, y) => y.c - x.c || act(y) - act(x) || (x.h < y.h ? -1 : 1));
    else if (S.sortBy === 'fans') rows.sort((x, y) => ((y.fc >= 0 ? y.fc : -1) - (x.fc >= 0 ? x.fc : -1)) || act(y) - act(x) || (x.h < y.h ? -1 : 1));
    else rows.sort((x, y) => act(y) - act(x) || y.p - x.p || (x.h < y.h ? -1 : 1));

    const dt = wrap.querySelector('.dt');
    if (dt) dt.textContent = state.date.slice(5);

    let html = '';
    if (selfKey) {      const me = state.authors[selfKey];
      const mp = me ? me.post.length : 0, mc = me ? me.reply.length : 0, mr = me ? me.rt.length : 0;
      html += rowHtml({ h: selfKey, name: '你', avatar: me ? me.avatar : '', fc: me ? me.fc : -1, p: mp, c: mc, r: mr, me: true });
      if (mp + mc + mr === 0) {
        // 自己的帖子不会出现在自己的主页时间线里
        html += '<div class="hint">你的帖子不会出现在自己的时间线里。点上面「你」这一行，扩展会后台打开你的主页（含回复）抓取今天的真实数据，约数秒。</div>';
      }
    }

    const LIMIT = Math.max(10, Math.min(200, S.listLimit || 60));
    const shown = rows.slice(0, LIMIT);
    for (let i = 0; i < shown.length; i++) html += rowHtml(shown[i]);

    if (!rows.length && !selfKey) {
      html = '<div class="empty">还没有数据<br>向下滚动时间线即可开始统计</div>';
    }

    if (listEl) listEl.innerHTML = COLS_HTML + html;
    if (moreEl) moreEl.textContent = rows.length > LIMIT ? ('另有 ' + (rows.length - LIMIT) + ' 位未显示') : '';

    if (sumEl) {
      const n = rows.length + (selfKey ? 1 : 0);
      sumEl.innerHTML = '<span>已记录 <b>' + n + '</b> 位</span><span>发 <b>' + tp + '</b></span>' +
        '<span>评 <b>' + tc + '</b></span><span>转 <b>' + tr + '</b></span>';
    }

    renderDiag();
  }

  function renderDiag() {
    if (!diagEl || !showDiag) return;
    const ch = chan.hit > 0
      ? '<span class="warn" style="color:#00ba7c">接口通道正常</span>（命中 ' + chan.hit + ' 批）'
      : '<span class="warn">接口通道未命中 · 正在用 DOM 兜底</span>';
    diagEl.innerHTML =
      '<div><span class="dl">通道</span><span class="dv">' + ch + '</span></div>' +
      '<div><span class="dl">收到</span><span class="dv">' + stats.rx + ' 条 / ' + stats.batches + ' 批</span></div>' +
      '<div><span class="dl">入库</span><span class="dv">' + stats.stored + ' 条</span>' +
      (stats.fixed ? '（纠正类型 ' + stats.fixed + '）' : '') + '</div>' +
      '<div><span class="dl">过滤</span><span class="dv">非今日 ' + stats.notToday + ' · 重复 ' + stats.dup + ' · 无效 ' + stats.bad + '</span></div>' +
      '<div><span class="dl">本人</span><span class="dv">' + (state.self ? '@' + esc(state.self) : '未识别') + '</span></div>' +
      '<div><span class="dl">关系库</span><span class="dv">' + Object.keys(meta.rel || {}).length + ' 人（资料页探针 + 接口扫描）</span></div>' +
      '<div><span class="dl">日期</span><span class="dv">' + state.date + '</span></div>';
  }

  // 粉丝数：精确到个位，带千分位分隔符
  function fmtFans(n) {
    if (typeof n !== 'number' || n < 0) return '–';
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function rowHtml(r) {
    const av = r.avatar
      ? '<img class="av" src="' + esc(r.avatar) + '" alt="">'
      : '<div class="av"></div>';
    const nm = esc(r.name || r.h);
    const hh = esc(r.h);
    const sub = (String(r.name || '').replace(/^@/, '') === r.h) ? '' : '<span class="h">@' + hh + '</span>';
    const fans = fmtFans(r.fc);
    return '<div class="row' + (r.me ? ' me' : '') + '" data-act="sync" data-handle="' + hh + '" title="@' + hh + ' · 粉丝 ' + fans + '｜点击后台搜索同步该用户今天发的全部帖子与回复（约数秒）">' +
      av +
      '<span class="nm">' + nm + sub + '</span>' +
      '<span class="n f' + (typeof r.fc === 'number' && r.fc >= 0 ? '' : ' z') + '" title="粉丝 ' + fans + '">' + fans + '</span>' +
      '<span class="n p' + (r.p ? '' : ' z') + '">' + r.p + '</span>' +
      '<span class="n c' + (r.c ? '' : ' z') + '">' + r.c + '</span>' +
      '<span class="n r' + (r.r ? '' : ' z') + '">' + r.r + '</span>' +
      '</div>';
  }

  /* ---------- 自我识别 ---------- */

  function detectSelf() {
    // 设置页手动指定优先（识别错时用）
    const manual = (S.selfHandle || '').toLowerCase();
    if (manual) {
      if (manual !== (state.self || '').toLowerCase()) {
        state.self = manual;
        log('本人账号（手动指定）', manual);
        scheduleRender();
        scheduleSave();
      }
      return;
    }
    let h = '';
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (a) h = handleFromHref(a.getAttribute('href'));
    if (!h) {
      const btn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
      if (btn) {
        const span = btn.querySelector('span');
        const txt = span ? span.textContent || '' : '';
        if (txt.charAt(0) === '@') h = txt.slice(1);
      }
    }
    if (h && h.toLowerCase() !== (state.self || '').toLowerCase()) {
      state.self = h;
      log('识别到本人账号', h);
      render();
      scheduleSave();
    }
  }

  /* ---------- 按需同步（后台标签页回填） ----------
   * 点面板里某一行：后台打开该用户主页的「回复」标签（帖子+回复都在这页），
   * 页面自身的 GraphQL 响应被 inject.js 截获入库，抓到新数据后自动关闭标签页。
   * 完全复用 X 自己的请求，不伪造任何接口参数。
   */

  let sync = null;   // { handle, tabId, before, t0, timer, stableAt }
  let toastTimer = null;

  function recordsOf(h) {
    const a = state.authors[h];
    return a ? a.post.length + a.reply.length + a.rt.length : 0;
  }

  // （搜索算符通道已弃用：X 搜索会做质量过滤漏掉部分回复，改用主页「帖子+回复」完整序列）
  function sinceDateStr() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return new Date(d).toISOString().slice(0, 10);
  }

  function renderToast(text) {
    // 优先用面板里的 toast
    if (wrap) {
      const el = wrap.querySelector('.toast');
      if (el) {
        el.textContent = text;
        el.style.display = 'block';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.style.display = 'none'; }, 5000);
        return;
      }
    }
    // 兜底：独立 toast。回复弹窗场景下面板可能不存在或被盖住，
    // 此前在这里静默 return，把所有 AI 报错都吞掉了（表现为「无任何反应」）
    let t = document.getElementById('xam-toast-fallback');
    if (!t) {
      t = document.createElement('div');
      t.id = 'xam-toast-fallback';
      t.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:2147483647;' +
        'max-width:70vw;padding:10px 18px;border-radius:999px;font-size:13px;font-weight:600;' +
        'background:rgba(29,155,240,.95);color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.3);' +
        'font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:none;';
      document.documentElement.appendChild(t);
    }
    t.textContent = text;
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = 'none'; }, 6000);
  }

  function startSync(handle) {
    if (!handle) return;
    const h = String(handle).toLowerCase();
    if (sync) {
      renderToast('正在同步 @' + sync.handle + '，请稍候…');
      return;
    }
    const before = recordsOf(h);
    sync = { handle: h, tabId: null, before, t0: Date.now(), timer: null, stableAt: 0 };
    renderToast('后台同步 @' + h + ' …');
    try {
      // 数据源用个人主页「帖子+回复」标签：完整的时间序列，不经过搜索质量过滤
      //（X 搜索 from:user 会漏掉部分回复；同步页会被短暂置前，翻完即自动关闭）
      const url = 'https://x.com/' + encodeURIComponent(h) + '/with_replies#xam_sync=1&h=' + encodeURIComponent(h);
      chrome.runtime.sendMessage(
        { type: 'xam_open_tab', url: url },
        (res) => {
          if (chrome.runtime.lastError || !res || !res.ok || !res.tabId) {
            finishSync(false);
            return;
          }
          sync.tabId = res.tabId;
          sync.timer = setInterval(pollSync, 500);
        }
      );
    } catch (e) {
      finishSync(false);
    }
  }

  function pollSync() {
    if (!sync) return;
    const now = recordsOf(sync.handle);
    const elapsed = Date.now() - sync.t0;
    if (now > sync.before) {
      // 手动同步要翻页，等得久；翻页期间数字持续增长
      if (!sync.stableAt) sync.stableAt = Date.now();
      if (Date.now() - sync.stableAt > 6000 || elapsed > 75000) closeSyncTab();
    } else if (elapsed > 35000) {
      closeSyncTab();
    }
  }

  function closeSyncTab() {
    const s = sync;
    if (!s) return;
    if (s.timer) clearInterval(s.timer);
    const done = () => finishSync(true);
    try {
      if (s.tabId != null) {
        chrome.runtime.sendMessage({ type: 'xam_close_tab', tabId: s.tabId }, () => {
          void chrome.runtime.lastError;
          done();
        });
      } else {
        done();
      }
    } catch (e) {
      done();
    }
  }

  function finishSync(ok) {
    const s = sync;
    sync = null;
    const added = s ? Math.max(0, recordsOf(s.handle) - s.before) : 0;
    // 读取同步页写回的「页面今日条数」审计值：页面有 M 条而只新增 N 条 → 抓取有漏；M 本身就少 → 数据源被过滤
    const show = (auditTxt) => {
      if (!ok) renderToast('同步失败：标签页没有打开成功');
      else {
        renderToast('已同步 @' + (s ? s.handle : '') + (added ? ' · 新增 ' + added + ' 条' : ' · 今天没有更多内容') + auditTxt);
      }
      scheduleRender();
    };
    try {
      chrome.storage.local.get(['xam:audit'], (res) => {
        const au = res && res['xam:audit'];
        const auditTxt = (au && s && au.h === s.handle && typeof au.audited === 'number')
          ? ' · 页面今日共 ' + au.audited + ' 条' : '';
        show(auditTxt);
      });
    } catch (e) {
      show('');
    }
  }

  /* ---------- 自动补全（借鉴节流队列思路，不直接调内部 GraphQL） ----------
   * 对「视口内 + 今天有动静」的用户，按节流队列自动后台补拉其主页第一页（约 20 条）；
   * 需要完整数据时仍点行做前台全量同步。全程复用 X 自己的页面请求，
   * 避开「直接调 GraphQL 需要 x-client-transaction-id / queryId 轮换」两个坑。
   */

  const AS_KEY = 'xam_autosync_v1';
  const AS_LOCK_KEY = 'xam_as_lock_v1';
  const AS_RID = Math.random().toString(36).slice(2) + ':' + Date.now();
  // 节流参数全部来自设置页（S.autoGap / S.autoParallel / S.autoTTL / S.autoMax）
  const asTTL = () => (S.autoTTL || 15) * 60000;   // 同一用户冷却
  const asGap = () => S.autoGap || 5000;           // 两次启动的间隔
  const asPar = () => S.autoParallel || 3;         // 并行后台页签数
  const asMax = () => (typeof S.autoMax === 'number' ? S.autoMax : 60);
  let asMap = {};                  // handle -> 上次自动补拉时间戳
  let asQueue = [];
  let asLast = 0;
  let asCount = 0;
  let autoSyncs = [];              // 进行中的后台补拉（并行）
  const visibleHandles = new Set();

  function noteVisible(art, h) {
    try {
      const r = art.getBoundingClientRect();
      if (r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth) {
        visibleHandles.add(h);
      }
    } catch (e) {}
  }

  function asMark(h) {
    asMap[h] = Date.now();
    try {
      const entries = Object.keys(asMap).map((k) => [k, asMap[k]]);
      entries.sort((a, b) => b[1] - a[1]);
      const keep = {};
      for (let i = 0; i < entries.length && i < 200; i++) keep[entries[i][0]] = entries[i][1];
      asMap = keep;
      chrome.storage.local.set({ [AS_KEY]: asMap });
    } catch (e) {}
  }

  function asEnqueue() {
    const now = Date.now();
    const selfKey = (state.self || '').toLowerCase();
    const cands = [];
    // 自己今天还没有数据时优先补一次
    if (selfKey && recordsOf(selfKey) === 0 && now - (asMap[selfKey] || 0) >= asTTL()) cands.push(selfKey);
    visibleHandles.forEach((h) => {
      if (h === selfKey) return;
      const a = state.authors[h];
      if (!a || a.post.length + a.reply.length === 0) return;   // 只补今天有动静的人
      if (now - (asMap[h] || 0) < asTTL()) return;
      cands.push(h);
    });
    for (let i = 0; i < cands.length; i++) {
      if (asQueue.indexOf(cands[i]) === -1) asQueue.push(cands[i]);
    }
    if (asQueue.length > 30) asQueue = asQueue.slice(-30);
  }

  function asTick() {
    if (IS_SYNC_TAB) return;
    if (!state.ui.auto || sync || document.visibilityState !== 'visible') return;
    // 跨标签页单执行者锁：多窗口/多标签时只有一个标签页允许启动自动补全，
    // 否则每个标签页各开一条队列，会同时弹出多个后台标签页（用户可感知的 bug）
    const run = () => {
      if (asCount >= asMax() || autoSyncs.length >= asPar()) return;
      if (Date.now() - asLast < asGap()) return;
      asEnqueue();
      while (asQueue.length) {
        const h = asQueue.shift();
        if (Date.now() - (asMap[h] || 0) < asTTL()) continue;
        startAuto(h);
        return;
      }
    };
    try {
      chrome.storage.local.get([AS_LOCK_KEY], (res) => {
        const cur = res && res[AS_LOCK_KEY];
        const now = Date.now();
        // 锁被其他标签页持有且 10 秒内有心跳 → 让它跑，本页只旁观
        if (cur && cur.rid !== AS_RID && now - cur.at < 10000) return;
        chrome.storage.local.set({ [AS_LOCK_KEY]: { rid: AS_RID, at: now } }, run);
      });
    } catch (e) {
      run();
    }
  }

  function startAuto(h) {
    const entry = { handle: h, tabId: null, before: recordsOf(h), t0: Date.now(), timer: null, stableAt: 0 };
    autoSyncs.push(entry);
    asLast = Date.now();
    asCount++;
    asMark(h);
    try {
      chrome.runtime.sendMessage(
        { type: 'xam_open_tab', active: false, url: 'https://x.com/' + encodeURIComponent(h) + '/with_replies#xam_sync=1&mode=bg&h=' + encodeURIComponent(h) },
        (res) => {
          if (chrome.runtime.lastError || !res || !res.ok || !res.tabId) {
            closeAuto(entry);
            return;
          }
          entry.tabId = res.tabId;
          entry.timer = setInterval(() => pollAuto(entry), 400);
        }
      );
    } catch (e) {
      closeAuto(entry);
    }
  }

  function pollAuto(e) {
    const now = recordsOf(e.handle);
    const elapsed = Date.now() - e.t0;
    if (now > e.before) {
      // 第一页通常 1–2 秒内到；稳定 2 秒即收
      if (!e.stableAt) e.stableAt = Date.now();
      if (Date.now() - e.stableAt > 2000 || elapsed > 9000) closeAuto(e);
    } else if (elapsed > 8000) {
      closeAuto(e);
    }
  }

  function closeAuto(e) {
    if (e.timer) clearInterval(e.timer);
    autoSyncs = autoSyncs.filter((x) => x !== e);
    try {
      if (e.tabId != null) {
        chrome.runtime.sendMessage({ type: 'xam_close_tab', tabId: e.tabId }, () => {
          void chrome.runtime.lastError;
        });
      }
    } catch (err) {}
  }

  try {
    chrome.storage.local.get([AS_KEY], (res) => {
      asMap = (res && res[AS_KEY]) || {};
    });
  } catch (e) {}

  setInterval(asTick, 5000);

  /* ---------- 启动 ---------- */

  // 由「同步」打开的标签页（会被置前）：自动滚动翻页，把该用户今天的内容抓完后写回审计值并自行关闭
  function startAutoScroll() {
    // 目标 handle 优先取 hash 参数，其次从路径解析
    const target = (SYNC_TARGET ||
      (location.pathname.split('/').filter(Boolean)[0] || '')).toLowerCase() || null;
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayStartTs = dayStart.getTime();

    let last = -1;
    let idle = 0;
    let elapsed = 0;
    let sawOld = 0;
    // bg 模式 = 自动补全的后台标签页：不渲染、滚不动，等第一页（约 20 条）抓完即收
    const BG_MODE = /mode=bg/.test(location.hash || '');

    // 时间线按时间倒序：只有当「最下面那条」变成昨天，才说明今天的内容都加载完了。
    // 不能看「任意一条是旧的」——搜索/主页里可能有置顶等旧内容。
    function lastArticleIsOld() {
      const arts = document.querySelectorAll('article');
      if (!arts.length) return false;
      const t = arts[arts.length - 1].querySelector('time[datetime]');
      if (!t) return false;
      const ts = Date.parse(t.getAttribute('datetime') || '');
      return isFinite(ts) && ts < dayStartTs;
    }

    // 审计：页面上实际渲染了有多少条「今天」的推文（按状态链接去重）
    function auditToday() {
      const set = new Set();
      const arts = document.querySelectorAll('article');
      for (let i = 0; i < arts.length; i++) {
        const t = arts[i].querySelector('time[datetime]');
        if (!t) continue;
        const ts = Date.parse(t.getAttribute('datetime') || '');
        if (!isFinite(ts) || ts < dayStartTs) continue;
        const a = arts[i].querySelector('a[href*="/status/"]');
        set.add(a ? String(a.getAttribute('href') || '').split('?')[0] : 'a' + i);
      }
      return set.size;
    }

    function finish() {
      clearInterval(timer);
      const audited = auditToday();
      log('同步完成', target, 'sawOld=' + sawOld, '页面今日=' + audited);
      // 把本页捕获到的全部数据经后台服务合并入库（串行写，避免多页签互相覆盖）
      try {
        const authors = {};
        for (const h in state.authors) {
          const a = state.authors[h];
          authors[h] = {
            name: a.name, avatar: a.avatar, fc: a.fc,
            rel: a.rel ? { f: a.rel.f, fb: a.rel.fb } : null,   // 关系字段必须带上，否则主页白开
            post: a.post.slice(), reply: a.reply.slice(), rt: a.rt.slice()
          };
        }
        chrome.runtime.sendMessage({ type: 'xam_merge', authors: authors, self: state.self });
      } catch (e) {}
      persistMeta();   // 立即落盘 meta（rel/heat/media/names），不等 900ms 防抖——本页随时会被关闭
      const close = () => {
        try { chrome.runtime.sendMessage({ type: 'xam_close_self' }); } catch (e) {}
      };
      try {
        chrome.storage.local.set({ 'xam:audit': { h: target, audited: audited, at: Date.now() } }, () => {
          setTimeout(close, 200);
        });
      } catch (e) {
        close();
      }
      setTimeout(close, 1500);   // 兜底，防止 storage 回调卡住导致标签页不关
    }

    const timer = setInterval(() => {
      elapsed += BG_MODE ? 500 : 450;
      const n = target ? recordsOf(target) : recMap.size;
      if (n === last) idle++; else { idle = 0; last = n; }

      // 每轮都探测一次资料页的关注状态（后台页 rAF 不触发，scan 不会跑，必须在这里直调）
      probeProfileRel();

      if (lastArticleIsOld()) sawOld++; else sawOld = 0;

      if (!BG_MODE) {
        // 兼容两种滚动容器：整页滚动 与 内层可滚动列
        window.scrollTo(0, document.documentElement.scrollHeight);
        const se = document.scrollingElement;
        if (se) se.scrollTop = se.scrollHeight;
      }

      const done = BG_MODE
        ? (elapsed > 2500 && idle >= 4) || elapsed > 9000
        : (elapsed > 5000 && sawOld >= 2 && n > 0) ||   // 已翻过今天边界
          (elapsed > 8000 && idle >= 9) ||              // 连续约 4 秒没新增
          elapsed > 65000;
      if (done) finish();
    }, 600);
  }


  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d) return;
    if (d.source === SRC) {
      if (Array.isArray(d.items) && d.items.length) ingest(d.items);
      if (Array.isArray(d.users) && d.users.length) updateUsers(d.users);
      if (Array.isArray(d.rels) && d.rels.length) ingestRels(d.rels);
    } else if (d.source === DIAG) {
      if (d.type === 'boot') chan.boot = true;
      else if (d.type === 'resp') {
        chan.resp++;
        chan.lastOp = d.op || '';
        if (d.hasTweet) { chan.hit++; chan.lastTweets = d.tweets || 0; }
      }
      if (showDiag) renderDiag();
    }
  });

  // 由「同步」打开的标签页：只负责被截获入库，不渲染任何 UI
  const IS_SYNC_TAB = /xam_sync/.test(location.hash || '');
  const SYNC_TARGET = ((location.hash.match(/[?&]h=([A-Za-z0-9_]+)/) || [])[1] || '').toLowerCase();

  /* ---------- 设置生效 ---------- */

  let booted = false;

  // 设置变更后的统一应用点（首次启动与设置页实时修改都走这里）
  function applySettings() {
    if (!booted) return;   // 启动流程会统一应用，此处只处理运行中的变更
    if (!IS_SYNC_TAB) {
      if (S.panelEnabled) {
        ensurePanel();
        applyPanelLayout();
      } else if (host) {
        host.remove();
        host = null; root = null; wrap = null;
        listEl = null; sumEl = null; moreEl = null; diagEl = null;
      }
    }
    state.ui.auto = S.autoSync;
    refreshAutoLink();
    if (!S.showBadge) {
      // 只清徽章；互关/备注/曾用名标记由各自函数在下次扫描时按设置自行增删
      const bs = document.querySelectorAll('.xam-badge');
      for (let i = 0; i < bs.length; i++) bs[i].remove();
    }
    if (!S.hideAds) unhideAllAds();
    scheduleScan(0);
    scheduleRender();
  }

  function loadSettings() {
    if (!SET) return;
    SET.getSettings((s) => {
      S = s;
      state.ui.auto = S.autoSync;
      applySettings();
    });
    SET.onSettings((s) => {
      S = s;
      applySettings();
    });
  }

  function boot() {
    if (IS_SYNC_TAB) {
      startAutoScroll();
      return;
    }
    ensurePanel();
    applyPanelLayout();
    detectSelf();
    scan();
    booted = true;
    loadSettings();

    // 忽略由我们自己写入引起的变更（徽章/标记/按钮），否则「扫描→写 DOM→再扫描」会自激成死循环
    const obs = new MutationObserver((muts) => {
      for (let i = 0; i < muts.length; i++) {
        const t = muts[i].target;
        if (t && t.nodeType === 1 && t.closest &&
          t.closest('.xam-badge, .xam-rel, .xam-note, .xam-namehist, .xam-heat, .xam-ai-btn, .xam-bk-btn')) continue;
        scheduleScan(150);
        return;
      }
    });
    const startObserve = () => {
      if (!document.body) return;
      obs.observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) startObserve();
    else document.addEventListener('DOMContentLoaded', startObserve, { once: true });

    setInterval(() => {
      detectSelf();
      scheduleScan(0);
    }, 2500);

    log('已启动');
    try {
      console.info('[XAM] 已启动 · 面板=' + !!host + ' · 作者=' + Object.keys(state.authors).length);
    } catch (e) {}
  }

  function safeBoot() {
    try {
      boot();
    } catch (e) {
      try { console.error('[XAM] 启动失败', e); } catch (err) {}
    }
  }

  loadStored();
  loadMeta();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeBoot, { once: true });
    setTimeout(() => { if (!host) safeBoot(); }, 800);
  } else {
    safeBoot();
  }
})();
