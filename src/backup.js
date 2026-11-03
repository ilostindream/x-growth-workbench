/* X 发展工作台 —— 媒体备份模块（借鉴 MediaHarvest / X Content Backup Tool）
 *
 * 全功能集（无登录、无每日次数限制，全部本地）：
 *  · 单推备份按钮：下载该推文全部图片原图 + 最高码率视频（+缩略图）
 *  · 批量下载悬浮窗：自动滚动收集 → 按条件筛选（日期/点赞/浏览/转发/评论/关键词/前 N 条）
 *    → 下载队列（并发+间隔防 429）→ 可选 zip 分卷打包 → 推文数据表格 CSV
 *  · 搜索页模式：按日期范围构造 from:user since:until: 搜索页收集更早的帖子
 *  · 下载历史（跳过已下载）、文件名模板、子文件夹/按用户分组
 *  · 自动显示敏感内容
 *
 * 数据源：inject.js 截获的 GraphQL 推文对象（含 media/counts），经 background 串行合并入
 * xam_bk_tweets_v1 缓存（LRU 3000）。视频地址只存在于接口数据，DOM 兜底仅覆盖图片。
 */
(() => {
  'use strict';
  if (window.__xamBackup) return;
  window.__xamBackup = true;

  const SRC = '__XAM_TWEETS__';
  const HISTORY_KEY = 'xam_bk_history_v1';
  const CACHE_KEY = 'xam_bk_tweets_v1';
  const ZIP_PER_VOL = 120;          // 每卷文件数
  const STALL_MS = 25000;           // 无新数据超时（结束收集）
  const cap = (v, a, b) => Math.min(b, Math.max(a, v));

  let S = window.XAM && window.XAM.settings ? window.XAM.settings.DEFAULTS : {};
  window.XAM = window.XAM || {};

  /* ---------- 小工具 ---------- */

  function sendBG(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          void chrome.runtime.lastError;
          resolve(r || { ok: false, error: 'no response' });
        });
      } catch (e) { resolve({ ok: false, error: String(e) }); }
    });
  }

  function toast(text, ms) {
    try {
      let t = document.querySelector('.xam-bk-toast');
      if (!t) {
        t = document.createElement('div');
        t.className = 'xam-bk-toast';
        t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
          'z-index:2147483647;background:rgba(15,20,25,.92);color:#fff;padding:10px 16px;' +
          'border-radius:10px;font-size:13px;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.35);transition:opacity .25s;opacity:0;pointer-events:none;max-width:70vw;';
        document.body.appendChild(t);
      }
      t.textContent = text;
      t.style.opacity = '1';
      clearTimeout(t.__tm);
      t.__tm = setTimeout(() => { t.style.opacity = '0'; }, ms || 2600);
    } catch (e) {}
  }

  function sanitizeName(s) {
    return String(s || '').replace(/[<>:"\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDate(ts) { const d = new Date(ts); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function fmtDateTime(ts) { const d = new Date(ts); return fmtDate(ts) + '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()); }

  // 从媒体地址推扩展名（photo 靠 format= 参数或路径后缀；video 恒 mp4）
  function extOf(m) {
    if (m.t === 'photo') {
      const fm = /[?&]format=([a-z0-9]+)/i.exec(m.u);
      if (fm) return fm[1].toLowerCase();
      const pe = /\.([a-z0-9]{3,4})(?:[?#]|$)/i.exec(m.u);
      if (pe) return pe[1].toLowerCase();
      return 'jpg';
    }
    return 'mp4';
  }

  function hashOf(url) {
    const m = /\/([^/?#]+?)(?:\?|#|$)/.exec(url);
    return m ? m[1].replace(/\.[a-z0-9]{3,4}$/i, '') : '';
  }

  // 文件名模板：{account} {tweetid} {serial} {hash} {date} {datetime} {tweetdate} {tweetdatetime}
  function makeName(tw, m, serial) {
    const base = S.bkPattern || '{account}_{tweetid}_{serial}';
    const out = base
      .replace(/\{account\}/g, tw.h || 'unknown')
      .replace(/\{tweetid\}/g, tw.id || '')
      .replace(/\{serial\}/g, String(serial))
      .replace(/\{hash\}/g, hashOf(m.u))
      .replace(/\{date\}/g, fmtDate(Date.now()))
      .replace(/\{datetime\}/g, fmtDateTime(Date.now()))
      .replace(/\{tweetdate\}/g, fmtDate(tw.ts || Date.now()))
      .replace(/\{tweetdatetime\}/g, fmtDateTime(tw.ts || Date.now()));
    return sanitizeName(out) + '.' + extOf(m);
  }

  // 下载相对路径：子文件夹 / 用户文件夹 / 文件名
  function pathFor(tw, m, serial) {
    const parts = [];
    if (S.bkFolder) parts.push(S.bkFolder);
    if (S.bkByUser && tw.h) parts.push(tw.h);
    parts.push(makeName(tw, m, serial));
    return parts.join('/');
  }

  /* ---------- 推文缓存 ---------- */

  const cache = new Map();          // id → tweet
  let cacheFlushTimer = null;

  function putTweet(it) {
    if (!it || !it.id || !it.handle) return;
    const h = String(it.handle).toLowerCase();
    const tw = {
      id: String(it.id), h: h, n: it.name || h, uid: it.uid || '',
      ts: it.ts, kind: it.kind === 'reply' ? 'reply' : it.kind === 'rt' ? 'rt' : 'post',
      txt: it.txt || '', lang: it.lang || '', sens: it.sens === true,
      counts: it.counts || null, media: it.media || null,
      t: it.ts
    };
    cache.delete(tw.id);          // Map 顺序 = 新鲜度
    cache.set(tw.id, tw);
    if (cache.size > 6000) {
      const ks = Array.from(cache.keys()).slice(0, cache.size - 6000);
      ks.forEach((k) => cache.delete(k));
    }
    if (tw.media || tw.counts) {
      clearTimeout(cacheFlushTimer);
      cacheFlushTimer = setTimeout(flushCache, 2000);
    }
  }

  function flushCache() {
    if (!cache.size) return;
    const out = {};
    let n = 0;
    for (const tw of cache.values()) {
      if (!tw.media && !tw.counts) continue;
      out[tw.id] = tw;
      if (++n >= 500) break;
    }
    if (n) sendBG({ type: 'xam_bk_cache', tweets: out });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== SRC) return;
    if (Array.isArray(e.data.items)) {
      for (let i = 0; i < e.data.items.length; i++) putTweet(e.data.items[i]);
      if (run.on) onPoolChanged();
      scheduleScan();   // 新截获的媒体可能让某条推文需要补插「⬇」
    }
  });

  (async () => {
    try {
      const res = await chrome.storage.local.get([CACHE_KEY]);
      const stored = (res && res[CACHE_KEY]) || {};
      for (const id in stored) {
        const t = stored[id];
        if (t && t.id && t.h) cache.set(t.id, t);
      }
      if (Object.keys(stored).length) scheduleScan();   // 历史缓存里的媒体数据影响按钮显隐
    } catch (e) {}
  })();

  /* ---------- 下载历史 ---------- */

  let histMap = null;             // url → rec（启动时加载）
  (async () => {
    try {
      const res = await chrome.storage.local.get([HISTORY_KEY]);
      histMap = (res && res[HISTORY_KEY]) || {};
    } catch (e) { histMap = {}; }
  })();

  function saveHistory(recs) {
    if (!recs.length) return;
    const items = recs.map((r) => ({ u: r.u, f: r.f, h: r.h, id: r.id, t: r.t, ts: r.ts }));
    sendBG({ type: 'xam_bk_history', items: items });
    if (!histMap) histMap = {};
    recs.forEach((r) => { histMap[r.u] = { u: r.u, ts: r.ts }; });
  }

  function alreadyDl(url) {
    return !!(histMap && histMap[url]);
  }

  /* ---------- 下载引擎（单推与批量共用）---------- */

  const engine = {
    queue: [], running: 0, concurrency: 2, delay: 600,
    onDone: null, onItem: null, stopped: false,
    results: []                    // {ok, rec} 供历史落库
  };

  function enqueueDownload(task) {  // {tw, m, serial} 或 {tw, m, name, path}
    engine.queue.push(task);
  }

  function pump() {
    while (engine.running < engine.concurrency && engine.queue.length && !engine.stopped) {
      engine.running++;
      runTask(engine.queue.shift()).then(() => {
        engine.running--;
        if (engine.queue.length) setTimeout(pump, engine.delay);
        else pump();
      });
    }
    if (!engine.queue.length && engine.running === 0 && engine.onDone) {
      const cb = engine.onDone;
      engine.onItem = null;
      engine.onDone = null;      // 只触发一次
      cb();
    }
  }

  async function runTask(task) {
    const tw = task.tw, m = task.m;
    const serial = task.serial || 1;
    const name = task.name || makeName(tw, m, serial);
    const path = task.path || pathFor(tw, m, serial);
    if (S.bkSkipDl !== false && alreadyDl(m.u)) {
      engine.results.push({ ok: false, skip: true, rec: { u: m.u, f: path, h: tw.h, id: tw.id, t: m.t, ts: tw.ts } });
      if (engine.onItem) engine.onItem(task, 'skip');
      return;
    }
    const r = await sendBG({ type: 'xam_bk_download', url: m.u, filename: path });
    if (r && r.ok) {
      engine.results.push({ ok: true, rec: { u: m.u, f: path, h: tw.h, id: tw.id, t: m.t, ts: tw.ts } });
      if (engine.onItem) engine.onItem(task, 'ok');
    } else {
      engine.results.push({ ok: false, rec: { u: m.u, f: path, h: tw.h, id: tw.id, t: m.t, ts: tw.ts } });
      if (engine.onItem) engine.onItem(task, 'fail');
    }
  }

  /* ---------- 单推备份按钮 ---------- */

  function tweetIdOf(art) {
    const links = art.querySelectorAll('a[href*="/status/"]');
    for (let i = 0; i < links.length; i++) {
      const m = /\/status\/(\d+)/.exec(links[i].getAttribute('href') || '');
      if (m) return m[1];
    }
    return null;
  }

  // 该推文是否带媒体：优先查缓存（接口数据含视频），DOM 兜底只覆盖图片和 video 标签
  function hasMedia(art, tw) {
    if (tw && Array.isArray(tw.media) && tw.media.length) return true;
    if (art.querySelector('img[src*="pbs.twimg.com/media"]')) return true;
    if (art.querySelector('video, [data-testid="videoPlayer"]')) return true;
    return false;
  }

  function decorate(art) {
    if (S.bkBtn === false) return;
    // 锚定工具栏的「回复」按钮：不能拿第一个 div[role="group"]——
    // 视频推文里播放器控件（播放/静音）也包在 role=group 里且排在前面，
    // 会把按钮插进视频控件导致永远不可见
    const id = tweetIdOf(art);
    const stale = art.querySelector('.xam-bk-btn');
    // 只在带图片/视频的推文上显示；无媒体的推文要清掉残留按钮
    //（X 虚拟列表复用 article 时，上一条有媒体、下一条没有）
    if (!id) { if (stale) stale.remove(); return; }
    const tw = cache.get(id);
    if (!hasMedia(art, tw)) { if (stale) stale.remove(); return; }
    const reply = art.querySelector('[data-testid="reply"]');
    const group = reply ? reply.closest('div[role="group"]') : art.querySelector('div[role="group"]');
    if (!group) return;
    if (group.querySelector('.xam-bk-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'xam-bk-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', '备份这条推文的媒体');
    btn.title = '备份这条推文的媒体（原图/视频）';
    btn.textContent = '⬇';
    btn.style.cssText = 'background:none;border:none;cursor:pointer;color:rgb(113,118,123);' +
      'font-size:13px;line-height:1;padding:8px;border-radius:9999px;user-select:none;';
    btn.addEventListener('mouseenter', () => { btn.style.color = 'rgb(29,155,240)'; btn.style.backgroundColor = 'rgba(29,155,240,.1)'; });
    btn.addEventListener('mouseleave', () => { btn.style.color = 'rgb(113,118,123)'; btn.style.backgroundColor = 'transparent'; });
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      backupOne(id);
    });
    group.appendChild(btn);
  }

  async function backupOne(id) {
    const tw = cache.get(id);
    const items = [];
    if (tw && Array.isArray(tw.media)) {
      tw.media.forEach((m, i) => items.push({ tw: tw, m: m, serial: i + 1 }));
      if (S.bkThumb && tw.media.some((m) => m.t === 'video')) {
        tw.media.forEach((m, i) => {
          if (m.t !== 'video') return;
          const th = { t: 'photo', u: (m.thumb || '') + '?name=small' };
          items.push({ tw: tw, m: th, serial: i + 1, name: makeName(tw, th, i + 1).replace(/\.[a-z0-9]+$/i, '_thumb.jpg') });
        });
      }
    } else {
      // 缓存未命中：DOM 图片兜底（转原图），视频只能等接口数据
      const art = Array.from(document.querySelectorAll('article[data-testid="tweet"], article[role="article"]'))
        .find((a) => tweetIdOf(a) === id);
      if (art) {
        let serial = 1;
        art.querySelectorAll('img[src*="pbs.twimg.com/media"]').forEach((img) => {
          const raw = img.getAttribute('src') || '';
          const u = /[?&]name=/.test(raw) ? raw.replace(/name=\w+/, 'name=orig') : raw + '?name=orig';
          items.push({ tw: { id: id, h: profileHandle() || 'unknown', ts: Date.now() }, m: { t: 'photo', u: u }, serial: serial++ });
        });
      }
      if (!items.length) { toast('这条推文的媒体还没加载到缓存，请滚动到它出现后再试（视频数据只能来自接口截获）'); return; }
    }
    if (!items.length) { toast('这条推文没有图片或视频'); return; }
    engine.results = []; engine.stopped = false; engine.onDone = null;
    engine.concurrency = cap(S.bkConcurrent || 2, 1, 5);
    engine.delay = cap(S.bkDelay || 600, 100, 10000);
    engine.queue = items.slice();
    const total = engine.queue.length;
    let okN = 0, failN = 0, skipN = 0;
    engine.onItem = (t, st) => {
      if (st === 'ok') okN++; else if (st === 'skip') skipN++; else failN++;
      toast('备份中 ' + (okN + skipN + failN) + '/' + total + (skipN ? ' · 跳过 ' + skipN : '') + (failN ? ' · 失败 ' + failN : ''), 1500);
    };
    engine.onDone = () => {
      const recs = engine.results.filter((r) => r.ok).map((r) => r.rec);
      saveHistory(recs);
      toast('备份完成：成功 ' + okN + (skipN ? ' · 跳过 ' + skipN : '') + (failN ? ' · 失败 ' + failN : ''));
    };
    pump();
  }

  /* ---------- 批量下载面板 ---------- */

  let panel = null, fab = null;
  const run = {
    on: false, paused: false, handle: '', target: 0, pool: new Map(),
    lastNew: 0, timer: null, tasks: [], csv: true
  };

  function profileHandle() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const m = link && /^\/([A-Za-z0-9_]{1,15})$/.exec(link.getAttribute('href') || '');
    return m ? m[1].toLowerCase() : '';
  }

  // 当前页面上下文的作者 handle：资料页取路径第一段；时间线/搜索页取本人
  function pageHandle() {
    const m = /^\/([A-Za-z0-9_]{1,15})(?:$|[/?#])/.exec(location.pathname);
    if (m && ['home', 'explore', 'notifications', 'messages', 'i', 'search', 'settings'].indexOf(m[1]) === -1) return m[1].toLowerCase();
    return profileHandle();
  }

  function $(id) { return panel ? panel.querySelector('#' + id) : null; }

  function buildUI() {
    if (panel) return;
    panel = document.createElement('div');
    panel.className = 'xam-bk-panel';
    panel.style.cssText = 'position:fixed;right:76px;bottom:112px;z-index:2147483646;width:330px;' +
      'max-height:66vh;overflow-y:auto;display:none;background:var(--background, #fff);color:var(--theme-color, #0f1419);' +
      'border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.28);border:1px solid rgba(0,0,0,.08);' +
      'font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;';
    panel.innerHTML = [
      '<div style="padding:12px 14px;font-weight:700;font-size:14px;display:flex;justify-content:space-between;align-items:center;">',
      '  <span>⬇ 媒体批量备份</span>',
      '  <span id="bkClose" style="cursor:pointer;opacity:.5;font-size:16px;">×</span>',
      '</div>',
      '<div style="padding:0 14px 14px;display:grid;grid-gap:8px;">',
      '  <label>作者 handle<input id="bkH" placeholder="自动识别当前主页" style="width:100%;box-sizing:border-box;margin-top:2px;padding:6px 8px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:transparent;color:inherit;"></label>',
      '  <div style="display:flex;grid-gap:8px;">',
      '    <label style="flex:1">只分析前<input id="bkN" type="number" min="0" placeholder="0=不限" style="width:100%;box-sizing:border-box;margin-top:2px;padding:6px 8px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:transparent;color:inherit;">条</label>',
      '    <label style="flex:1">最低点赞<input id="bkLike" type="number" min="0" placeholder="0" style="width:100%;box-sizing:border-box;margin-top:2px;padding:6px 8px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:transparent;color:inherit;"></label>',
      '  </div>',
      '  <div style="display:flex;grid-gap:8px;">',
      '    <label style="flex:1">最低浏览<input id="bkView" type="number" min="0" placeholder="0" style="width:100%;box-sizing:border-box;margin-top:2px;padding:6px 8px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:transparent;color:inherit;"></label>',
      '    <label style="flex:1">最低转发<input id="bkRt" type="number" min="0" placeholder="0" style="width:100%;box-sizing:border-box;margin-top:2px;padding:6px 8px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:transparent;color:inherit;"></label>',
      '  </div>',
      '  <label>包含关键词（逗号分隔，可空）<input id="bkKw" placeholder="新闻,科技" style="width:100%;box-sizing:border-box;margin-top:2px;padding:6px 8px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:transparent;color:inherit;"></label>',
      '  <div style="display:flex;grid-gap:8px;">',
      '    <label style="flex:1">开始日期<input id="bkFrom" type="date" style="width:100%;box-sizing:border-box;margin-top:2px;padding:6px 8px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:transparent;color:inherit;"></label>',
      '    <label style="flex:1">结束日期<input id="bkTo" type="date" style="width:100%;box-sizing:border-box;margin-top:2px;padding:6px 8px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:transparent;color:inherit;"></label>',
      '  </div>',
      '  <div style="display:flex;grid-gap:10px;flex-wrap:wrap;">',
      '    <label><input id="bkImg" type="checkbox" checked> 图片</label>',
      '    <label><input id="bkVid" type="checkbox" checked> 视频/GIF</label>',
      '    <label><input id="bkZip" type="checkbox"> 打包 zip</label>',
      '    <label><input id="bkCsv" type="checkbox" checked> 数据表格</label>',
      '  </div>',
      '  <div style="display:flex;grid-gap:8px;margin-top:2px;">',
      '    <button id="bkStart" style="flex:2;padding:8px 0;border:none;border-radius:9999px;background:rgb(29,155,240);color:#fff;font-weight:700;cursor:pointer;">开始搜索并下载</button>',
      '    <button id="bkPause" style="flex:1;padding:8px 0;border:1px solid rgba(127,127,127,.4);border-radius:9999px;background:transparent;color:inherit;cursor:pointer;">暂停</button>',
      '    <button id="bkStop" style="flex:1;padding:8px 0;border:1px solid rgba(127,127,127,.4);border-radius:9999px;background:transparent;color:inherit;cursor:pointer;">停止</button>',
      '  </div>',
      '  <div id="bkStat" style="margin-top:4px;line-height:1.7;opacity:.85;">已发现推文 0 · 已入队 0 · 已下载 0 · 已跳过 0</div>',
      '  <div style="opacity:.55;font-size:11px;line-height:1.6;">先用日期范围可走搜索页下载更早的帖子；填了开始+结束日期时自动切搜索页模式。</div>',
      '</div>'
    ].join('\n');
    document.body.appendChild(panel);

    fab = document.createElement('button');
    fab.className = 'xam-bk-fab';
    fab.type = 'button';
    fab.title = 'X 媒体批量备份';
    fab.textContent = '⬇';
    // 右侧垂直居中：右下角被「今日活跃」排行面板占用，放底部会被完全盖住
    fab.style.cssText = 'position:fixed;right:20px;bottom:112px;z-index:2147483646;width:44px;height:44px;' +
      'border:none;border-radius:50%;background:linear-gradient(135deg,#1d9bf0,#8b5cf6);color:#fff;font-size:19px;' +
      'cursor:pointer;box-shadow:0 4px 14px rgba(29,155,240,.45);display:' + (S.bkFab === false ? 'none' : 'block') + ';';
    fab.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      if (panel.style.display === 'block' && !$('bkH').value) {
        $('bkH').value = pageHandle() || '';
        $('bkH').placeholder = '自动识别：' + ($('bkH').value || '无');
      }
    });
    document.body.appendChild(fab);

    $('bkClose').addEventListener('click', () => { panel.style.display = 'none'; });
    $('bkStart').addEventListener('click', startBatch);
    $('bkPause').addEventListener('click', () => {
      run.paused = !run.paused;
      $('bkPause').textContent = run.paused ? '继续' : '暂停';
    });
    $('bkStop').addEventListener('click', stopBatch);
  }

  function collectOpts() {
    return {
      h: ($('bkH').value || pageHandle() || '').toLowerCase().replace(/^@+/, ''),
      n: parseInt($('bkN').value, 10) || 0,
      like: parseInt($('bkLike').value, 10) || 0,
      view: parseInt($('bkView').value, 10) || 0,
      rt: parseInt($('bkRt').value, 10) || 0,
      kw: ($('bkKw').value || '').split(/[,，]/).map((s) => s.trim().toLowerCase()).filter(Boolean),
      from: $('bkFrom').value || '',
      to: $('bkTo').value || '',
      img: $('bkImg').checked,
      vid: $('bkVid').checked,
      zip: $('bkZip').checked,
      csv: $('bkCsv').checked
    };
  }

  function matchTweet(tw, o) {
    if (tw.h !== o.h) return false;
    if (tw.kind === 'rt') return false;               // 转推无自有媒体
    if (o.from && fmtDate(tw.ts) < o.from) return false;
    if (o.to && fmtDate(tw.ts) > o.to) return false;
    const c = tw.counts || {};
    if (o.like > 0 && !((c.like || 0) >= o.like)) return false;
    if (o.view > 0 && !((c.view || 0) >= o.view)) return false;
    if (o.rt > 0 && !((c.rt || 0) >= o.rt)) return false;
    if (o.kw.length) {
      const txt = (tw.txt || '').toLowerCase();
      if (!o.kw.some((k) => txt.indexOf(k) !== -1)) return false;
    }
    return true;
  }

  function poolFor(o) {
    const pool = new Map();
    for (const tw of cache.values()) {
      if (!matchTweet(tw, o)) continue;
      if (!o.img && (!tw.media || !tw.media.some((m) => m.t === 'photo'))) continue;
      if (!o.vid && (!tw.media || !tw.media.some((m) => m.t !== 'photo'))) continue;
      if (!tw.media || !tw.media.length) continue;
      pool.set(tw.id, tw);
      if (o.n > 0 && pool.size >= o.n) break;
    }
    return pool;
  }

  function onPoolChanged() {
    if (!run.on || run.paused) return;
    const o = run.opts;
    run.pool = poolFor(o);
    if (run.pool.size !== run.foundN) {
      run.foundN = run.pool.size;
      run.lastNew = Date.now();
      stat();
    }
    if (o.n > 0 && run.foundN >= o.n) finishCollect();
    else if (Date.now() - run.lastNew > STALL_MS) finishCollect(true);
  }

  function stat() {
    if (!panel) return;
    $('bkStat').textContent = '已发现推文 ' + (run.foundN || 0) + ' · 已入队 ' + run.enqueued +
      ' · 已下载 ' + run.doneN + (run.skipN ? ' · 已跳过 ' + run.skipN : '') +
      (run.failN ? ' · 失败 ' + run.failN : '') + (run.phase ? ' · ' + run.phase : '');
  }

  function startBatch() {
    const o = collectOpts();
    if (!o.h) { toast('没有识别到作者 handle，请在面板里手动填写'); return; }
    // 搜索页模式：同时填了日期范围 → 打开搜索页收集更早的帖子
    if (o.from && o.to && !/\/search\?/.test(location.search)) {
      const toEx = new Date(o.to + 'T00:00:00');
      toEx.setDate(toEx.getDate() + 1);                     // until 为开区间，取次日
      const until = toEx.getFullYear() + '-' + pad2(toEx.getMonth() + 1) + '-' + pad2(toEx.getDate());
      const q = 'from%3A' + o.h + '%20since%3A' + o.from + '%20until%3A' + until +
        (o.kw.length ? '%20' + o.kw.map((k) => encodeURIComponent('"' + k + '"')).join('%20') : '');
      const hash = '#xam_bk=1&h=' + encodeURIComponent(o.h) +
        (o.n ? '&n=' + o.n : '') + (o.like ? '&like=' + o.like : '') +
        (o.view ? '&view=' + o.view : '') + (o.rt ? '&rt=' + o.rt : '') +
        (o.kw.length ? '&kw=' + encodeURIComponent(o.kw.join(',')) : '') +
        '&img=' + (o.img ? 1 : 0) + '&vid=' + (o.vid ? 1 : 0) +
        '&zip=' + (o.zip ? 1 : 0) + '&csv=' + (o.csv ? 1 : 0);
      sendBG({ type: 'xam_open_tab', url: 'https://x.com/search?q=' + q + '&f=live' + hash, active: true });
      toast('已打开搜索页（' + o.from + ' ~ ' + o.to + '），将在新页签自动开始');
      run.on = false;
      return;
    }
    if (run.on) { toast('批量任务进行中'); return; }
    run.on = true; run.paused = false;
    run.opts = o;
    run.foundN = 0; run.lastNew = Date.now();
    run.doneN = 0; run.skipN = 0; run.failN = 0; run.enqueued = 0; run.phase = '搜索中';
    run.pool = new Map();
    if (panel) { $('bkPause').textContent = '暂停'; }
    toast('开始收集 @' + o.h + ' 的媒体推文，页面将自动滚动…');
    stat();
    // 自动滚动：随机节奏（设置 bkScrollMin/Max），X 虚拟列表需要持续向下
    const sMin = cap(S.bkScrollMin || 900, 300, 10000);
    const sMax = cap(Math.max(S.bkScrollMax || 1800, sMin), sMin, 20000);
    const step = () => {
      if (!run.on) return;
      if (!run.paused) {
        window.scrollBy({ top: 700 + Math.floor(Math.random() * 600), behavior: 'instant' });
        onPoolChanged();
      }
      run.timer = setTimeout(step, sMin + Math.floor(Math.random() * (sMax - sMin)));
    };
    step();
  }

  function finishCollect(stalled) {
    if (!run.on) return;
    run.on = false;
    clearTimeout(run.timer);
    const o = run.opts;
    const pool = run.pool;
    run.phase = stalled ? '已到无新数据边界' : '准备下载';
    stat();
    if (!pool.size) { toast('@' + o.h + ' 没有匹配条件的媒体推文'); run.phase = ''; stat(); return; }
    // 组任务
    const tasks = [];
    const sorted = Array.from(pool.values()).sort((a, b) => b.ts - a.ts);
    for (const tw of sorted) {
      (tw.media || []).forEach((m, i) => {
        if (m.t === 'photo' && !o.img) return;
        if (m.t !== 'photo' && !o.vid) return;
        tasks.push({ tw: tw, m: m, serial: i + 1 });
      });
    }
    if (!tasks.length) { toast('没有可下载的媒体文件'); return; }
    run.enqueued = tasks.length;
    run.phase = o.zip ? 'zip 打包中' : '下载中';
    stat();
    engine.results = []; engine.stopped = false;
    engine.concurrency = cap(S.bkConcurrent || 2, 1, 5);
    engine.delay = cap(S.bkDelay || 600, 100, 10000);

    if (o.zip) {
      // zip：分卷（每 ZIP_PER_VOL 卷），文件名卷内全路径
      const vols = [];
      for (let i = 0; i < tasks.length; i += ZIP_PER_VOL) vols.push(tasks.slice(i, i + ZIP_PER_VOL));
      let volI = 0;
      const nextVol = () => {
        if (volI >= vols.length) { finishBatch(o, tasks.length); return; }
        const vol = vols[volI];
        const files = vol.map((t) => {
          const name = (S.bkByUser ? (t.tw.h + '/') : '') + makeName(t.tw, t.m, t.serial);
          return { url: t.m.u, name: name };
        });
        const outBase = 'xam-backup-' + o.h + '-' + fmtDate(Date.now()) + (vols.length > 1 ? '-part' + (volI + 1) : '') + '.zip';
        const total = files.length;
        const progHandler = (msg) => {
          if (msg && msg.type === 'xam_bk_zip_prog') {
            run.doneN += 0;
            run.phase = 'zip 第' + (volI + 1) + '/' + vols.length + '卷 ' + msg.done + '/' + msg.total;
            stat();
          }
        };
        try { chrome.runtime.onMessage.addListener(progHandler); } catch (e) {}
        sendBG({ type: 'xam_bk_zip', files: files, out: outBase }).then((r) => {
          try { chrome.runtime.onMessage.removeListener(progHandler); } catch (e) {}
          if (r && r.ok) {
            run.doneN += total;
            const recs = vol.map((t) => ({ u: t.m.u, f: outBase + '!' + ((S.bkByUser ? t.tw.h + '/' : '') + makeName(t.tw, t.m, t.serial)), h: t.tw.h, id: t.tw.id, t: t.m.t, ts: t.tw.ts }));
            saveHistory(recs);
          } else run.failN += total;
          volI++;
          nextVol();
        });
      };
      nextVol();
    } else {
      engine.queue = tasks.slice();
      engine.onItem = (t, st) => {
        if (st === 'ok') run.doneN++; else if (st === 'skip') run.skipN++; else run.failN++;
        stat();
      };
      engine.onDone = () => finishBatch(o, tasks.length);
      pump();
    }
  }

  function finishBatch(o, total) {
    run.phase = '完成';
    stat();
    // 历史落库（zip 已逐卷落过）
    if (!o.zip) {
      const recs = engine.results.filter((r) => r.ok).map((r) => r.rec);
      saveHistory(recs);
    }
    // CSV 数据表格
    if (o.csv) {
      const pool = run.pool;
      exportCsv(Array.from(pool.values()));
    }
    toast('备份完成：' + total + ' 个文件' + (run.skipN ? '（跳过 ' + run.skipN + '）' : '') + (run.failN ? '，失败 ' + run.failN : ''));
    setTimeout(() => { run.phase = ''; if (panel) stat(); }, 4000);
  }

  function stopBatch() {
    run.on = false;
    clearTimeout(run.timer);
    engine.stopped = true;
    engine.queue = [];
    run.phase = '已停止';
    stat();
    toast('已停止');
  }

  /* ---------- CSV 导出（字段对齐原扩展 xlsxExport*）---------- */

  function csvCell(s) {
    const v = String(s == null ? '' : s);
    return '"' + v.replace(/"/g, '""') + '"';
  }

  function exportCsv(tweets) {
    const header = ['推文ID', '推文链接', '用户名', '用户昵称', '用户ID', '推文内容', '发布时间',
      '点赞数', '转发数', '评论数', '浏览量', '书签数', '媒体类型', '媒体数量', '媒体链接',
      '是否敏感内容', '语言', '话题标签', '提及用户'];
    const rows = [header];
    tweets.sort((a, b) => b.ts - a.ts).forEach((tw) => {
      const c = tw.counts || {};
      const tags = [];
      const mens = [];
      // 从正文提取话题与提及（接口 entities 不在缓存里，正文兜底）
      (tw.txt || '').replace(/#([\w\u4e00-\u9fa5]+)/g, (all, t) => { tags.push(t); return all; });
      (tw.txt || '').replace(/@([A-Za-z0-9_]{1,15})/g, (all, t) => { mens.push(t); return all; });
      rows.push([
        tw.id,
        'https://x.com/' + tw.h + '/status/' + tw.id,
        tw.h, tw.n, tw.uid,
        tw.txt, new Date(tw.ts).toISOString(),
        c.like != null ? c.like : '', c.rt != null ? c.rt : '', c.rep != null ? c.rep : '',
        c.view != null ? c.view : '', c.bm != null ? c.bm : '',
        tw.media ? Array.from(new Set(tw.media.map((m) => m.t === 'gif' ? '视频' : m.t === 'video' ? '视频' : '图片'))).join('/') : '',
        tw.media ? tw.media.length : 0,
        tw.media ? tw.media.map((m) => m.u).join(' ') : '',
        tw.sens ? '是' : '否',
        tw.lang, tags.join(' '), mens.join(' ')
      ]);
    });
    const csv = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'xam-tweets-' + run.opts.h + '-' + fmtDate(Date.now()) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
  }

  /* ---------- 自动显示敏感内容 ---------- */

  // 只匹配敏感内容真实遮罩文案；不能匹配「显示更多/Show more」——那会把每条长推文的展开按钮
  // 每轮扫描都点一次，X 反复重渲染 → 推文剧烈抖动
  const NSFW_RE = /显示可能包含敏感内容|敏感内容|Show (possibly )?sensitive|sensitive content/i;
  const NSFW_EXCLUDE = /更多|more|回复|repl/i;

  function revealNsfw() {
    if (S.bkNsfw !== true) return;
    // 1) 自动点「显示」遮罩按钮（X 的敏感内容遮罩是覆盖在媒体上的按钮）
    const btns = document.querySelectorAll('div[role="button"], button');
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (b.__xamNsfw) continue;
      const txt = (b.textContent || '').trim();
      if (txt.length <= 40 && NSFW_RE.test(txt) && !NSFW_EXCLUDE.test(txt) && b.querySelector) {
        // 必须在媒体容器内，不能只看 article（article 里任何按钮都算）
        const inMedia = b.closest('[data-testid="tweetPhoto"], [data-testid="tweet-photo"], [data-testid="videoPlayer"], [data-testid="videoComponent"]');
        if (inMedia) {
          b.__xamNsfw = true;
          try { b.click(); } catch (e) {}
        }
      }
    }
    // 2) 时间线内被模糊的图片直接去模糊
    const imgs = document.querySelectorAll('article img[src*="pbs.twimg.com/media"]');
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (img.__xamNsfw) continue;
      const f = img.style.filter || '';
      if (/blur/.test(f)) { img.__xamNsfw = true; img.style.filter = 'none'; }
    }
  }

  /* ---------- 扫描循环 ---------- */

  let sched = false;
  let lastScrollAt = 0;
  window.addEventListener('scroll', () => { lastScrollAt = Date.now(); }, { capture: true, passive: true });

  function scan() {
    sched = false;
    // 顶部保护区（由 content.js 在「返回顶部」跳转后置位）：停在顶部期间不写任何 DOM，
    // 否则会打断 X 虚拟列表的位置校正，出现「下拉一点被弹回顶部」
    try {
      const se = document.scrollingElement;
      if (window.__XAM_TOPGUARD && se && se.scrollTop < 160) { scheduleScan(600); return; }
    } catch (e) {}
    const arts = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
    for (let i = 0; i < arts.length; i++) decorate(arts[i]);
    revealNsfw();
  }

  function scheduleScan() {
    if (sched) return;
    sched = true;
    // 节流：原来每帧都扫，X 的时间线（视频进度、计数刷新）会持续触发，
    // 全量扫描 + 写入会和 X 自身渲染叠加成高频重排（抖动）。
    // 滚动期间整体让路：不与 X 的虚拟列表抢主线程，否则会出现「滚不动」
    setTimeout(() => {
      if (Date.now() - lastScrollAt < 400) { sched = false; scheduleScan(); return; }
      requestAnimationFrame(scan);
    }, 300);
  }

  // 忽略我们自己插入的节点引起的变更，避免扫描自激
  new MutationObserver((muts) => {
    for (let i = 0; i < muts.length; i++) {
      const t = muts[i].target;
      if (t && t.nodeType === 1 && t.closest && t.closest('.xam-bk-btn, .xam-bk-fab, #xam-bk-panel')) continue;
      scheduleScan();
      return;
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  /* ---------- 设置热更新 + hash 自动启动 ---------- */

  if (window.XAM && window.XAM.settings) {
    window.XAM.settings.getSettings((s) => { S = s; });
    window.XAM.settings.onSettings((s) => {
      S = s;
      if (fab) fab.style.display = S.bkFab === false ? 'none' : 'block';
      if (S.bkBtn === false) {
        document.querySelectorAll('.xam-bk-btn').forEach((b) => b.remove());
        scheduleScan();
      }
    });
  }

  function autoStartFromHash() {
    const m = /xam_bk=1/.test(location.hash) ? new URLSearchParams(location.hash.slice(1)) : null;
    if (!m) return false;
    setTimeout(() => {
      buildUI();
      panel.style.display = 'block';
      $('bkH').value = m.get('h') || '';
      if (m.get('n')) $('bkN').value = m.get('n');
      if (m.get('like')) $('bkLike').value = m.get('like');
      if (m.get('view')) $('bkView').value = m.get('view');
      if (m.get('rt')) $('bkRt').value = m.get('rt');
      if (m.get('kw')) $('bkKw').value = m.get('kw');
      if (m.get('img')) $('bkImg').checked = m.get('img') === '1';
      if (m.get('vid')) $('bkVid').checked = m.get('vid') === '1';
      if (m.get('zip')) $('bkZip').checked = m.get('zip') === '1';
      if (m.get('csv')) $('bkCsv').checked = m.get('csv') !== '0';
      history.replaceState(null, '', location.pathname + location.search);
      setTimeout(startBatch, 2000);   // 等搜索页首批数据
    }, 800);
    return true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { if (S.bkFab !== false || S.bkBtn !== false) buildUI(); autoStartFromHash(); });
  } else {
    if (S.bkFab !== false || S.bkBtn !== false) buildUI();
    autoStartFromHash();
  }
})();
