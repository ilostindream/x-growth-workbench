/* X 发展工作台 —— 页面上下文（MAIN world）注入脚本
 *
 * 在 document_start 阶段劫持 fetch / XMLHttpRequest，截获 X 的 GraphQL 响应，
 * 从中抽取「作者 + 发布时间 + 类型（原创 / 回复 / 转发）」，
 * 通过 window.postMessage 交给隔离世界的 content.js 做去重与持久化。
 *
 * 通配所有 /graphql/ 请求，再按响应体里有没有 "full_text" 判定是否为推文数据 ——
 * 不依赖 operation 名和 queryId，X 改版本时不会整条链路失效。
 */
(() => {
  'use strict';
  if (window.__xamInjected) return;
  window.__xamInjected = true;

  const SRC = '__XAM_TWEETS__';
  const DIAG = '__XAM_DIAG__';
  // graphql + v1.1 + v2 全覆盖（借鉴「互关标记 for X」的实现，它在时间线上实测有效）
  const API_RE = /\/i\/api\/(graphql|1\.1|2)\//i;
  const MAX_DEPTH = 20;
  const SEEN_CAP = 40000;

  // 信任的 endpoint：X 对 false 布尔会省略字段（followed_by 不出现 = 没关注你），
  // 只有某 endpoint 曾显式返回过 followed_by，其上的「缺字段」才可解读为 false
  const trustedOps = new Set();

  // 结构探针：开启调试后，把首个用户对象的真实结构打到控制台（用于现场排查字段位置）
  const DEBUG = (() => {
    try { return localStorage.getItem('xam:debug') === '1'; } catch (e) { return false; }
  })();
  let probed = false;
  function probeUserNode(node) {
    if (!DEBUG || probed) return;
    probed = true;
    try {
      console.log('[XAM][probe] 首个用户对象结构（请整段发回给开发者）：');
      console.log(JSON.stringify(node).slice(0, 4000));
    } catch (e) {}
  }

  let seen = new Set();
  let buf = [];
  let flushTimer = null;
  let respCount = 0;
  let hitCount = 0;
  let tweetCount = 0;

  function post(payload) {
    try { window.postMessage(payload, '*'); } catch (e) {}
  }

  post({ source: DIAG, type: 'boot' });
  try { console.info('[XAM] inject.js 已进入页面上下文'); } catch (e) {}

  function opName(url) {
    const m = /\/graphql\/(?:[^/]+\/)?([A-Za-z0-9_]+)/.exec(String(url) || '');
    return m ? m[1] : '?';
  }

  /* ---------- 抽取 ---------- */

  function pickTweet(t) {
    if (t && t.__typename === 'TweetWithVisibilityResults' && t.tweet) t = t.tweet;
    const L = t && t.legacy;
    if (!L || !t.rest_id || typeof L.full_text !== 'string') return null;

    const ur = (t.core && t.core.user_results && t.core.user_results.result) || null;
    const uc = (ur && ur.core) || {};
    const ul = (ur && ur.legacy) || {};
    const handle = uc.screen_name || ul.screen_name;
    if (!handle) return null;

    const ts = Date.parse(L.created_at || '');
    if (!isFinite(ts)) return null;

    let kind = 'post';
    if (L.retweeted_status_result || L.retweeted === true) kind = 'rt';
    else if (L.in_reply_to_status_id_str) kind = 'reply';
    // 兜底：部分转推条目可能不带 retweeted_status_result，用 RT @ 前缀识别
    else if (typeof L.full_text === 'string' && L.full_text.lastIndexOf('RT @', 0) === 0) kind = 'rt';

    const avatar = (ur && ur.avatar && ur.avatar.image_url) || ul.profile_image_url_https || '';

    return {
      id: String(t.rest_id),
      handle: String(handle),
      name: uc.name || ul.name || String(handle),
      avatar,
      uid: (ur && ur.rest_id) || '',
      fc: followersOf(ur),
      rel: relOf(ur),
      views: viewsOf(t),
      // —— 媒体备份（借鉴 MediaHarvest / X Content Backup Tool）——
      media: mediaOf(L),
      counts: countsOf(L, t),
      txt: typeof L.full_text === 'string' ? L.full_text : '',
      lang: typeof L.lang === 'string' ? L.lang : '',
      sens: L.possibly_sensitive === true,
      ts,
      kind
    };
  }

  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

  // 计数组：点赞/转推/回复/引用/书签/浏览（备份 CSV 用）
  function countsOf(L, t) {
    const v = viewsOf(t);
    const c = {
      like: num(L.favorite_count), rt: num(L.retweet_count), rep: num(L.reply_count),
      quote: num(L.quote_count), bm: num(L.bookmark_count),
      view: typeof v === 'number' ? v : null
    };
    let any = false;
    for (const k in c) if (c[k] !== null) { any = true; break; }
    return any ? c : null;
  }

  // 媒体组：photo → 原图(name=orig)；video/gif → 最高码率 mp4。附带缩略图与尺寸
  function mediaOf(L) {
    const arr = (L.extended_entities && L.extended_entities.media) ||
      (L.entities && L.entities.media);
    if (!Array.isArray(arr)) return null;
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i];
      if (!m || typeof m.media_url_https !== 'string') continue;
      const type = m.type === 'video' ? 'video' : m.type === 'animated_gif' ? 'gif' : 'photo';
      const item = {
        t: type,
        thumb: m.media_url_https,
        w: num(m.sizes && m.sizes.large && m.sizes.large.w) || 0,
        h: num(m.sizes && m.sizes.large && m.sizes.large.h) || 0
      };
      const base = m.media_url_https;
      if (type === 'photo') {
        // 原图：无参数补 ?name=orig；带 name= 则原位替换
        item.u = /[?&]name=/.test(base) ? base.replace(/name=\w+/, 'name=orig') : base + '?name=orig';
      } else {
        const vs = (m.video_info && m.video_info.variants) || [];
        let best = null, bestB = -1;
        for (let j = 0; j < vs.length; j++) {
          const v = vs[j];
          if (!v || v.content_type !== 'video/mp4' || typeof v.bitrate !== 'number') continue;
          if (v.bitrate > bestB) { best = v; bestB = v.bitrate; }
        }
        if (best && typeof best.url === 'string') item.u = best.url;
      }
      if (item.u) out.push(item);
    }
    return out.length ? out : null;
  }

  // 浏览量：新版推文对象放在 views.count，旧版在 legacy.ext_views.count（字符串数字）
  function viewsOf(t) {
    if (!t) return null;
    const v = t.views;
    if (v && v.count != null) {
      const n = parseInt(v.count, 10);
      if (isFinite(n)) return n;
    }
    const ev = t.legacy && t.legacy.ext_views;
    if (ev && ev.count != null) {
      const n = parseInt(ev.count, 10);
      if (isFinite(n)) return n;
    }
    return null;
  }

  // 粉丝数：新版用户对象放在 relationship_counts，旧版在 legacy.followers_count
  function followersOf(u) {
    if (!u) return null;
    const rc = u.relationship_counts;
    if (rc && typeof rc.followers === 'number') return rc.followers;
    const l = u.legacy;
    if (l && typeof l.followers_count === 'number') return l.followers_count;
    return null;
  }

  // 关注关系：following = 我关注了TA，followed_by = TA关注了我。
  // 【根因修复】新版 GraphQL 用户对象的关系字段在 relationship_perspectives 里
  // （借鉴「互关标记 for X」的 readUser），此前漏扫该位置导致标记永远无数据。
  // known（响应可信，缺字段可当 false）的依据：
  //   · 用户对象带 relationship_perspectives（完整用户，X 前端自己就是这么判互关的）
  //   · legacy 显式含 followed_by
  //   · 该 endpoint 在 trustedOps 里（见 handleText）
  function relOf(u) {
    if (!u) return null;
    let following = null, followedBy = null, known = false;
    const srcs = [u.relationship_perspectives, u, u.legacy, u.relationship,
      u.viewer_relationship, u.super_following];
    for (let i = 0; i < srcs.length; i++) {
      const s = srcs[i];
      if (!s || typeof s !== 'object') continue;
      if (following === null && typeof s.following === 'boolean') following = s.following;
      if (followedBy === null && typeof s.followed_by === 'boolean') followedBy = s.followed_by;
    }
    if (u.relationship_perspectives && typeof u.relationship_perspectives === 'object') known = true;
    if (u.legacy && 'followed_by' in u.legacy) known = true;
    if (following === null && followedBy === null && !known) return null;
    return { f: following, fb: followedBy, known: known };
  }

  // 从任意节点里认用户对象（有 screen_name + 粉丝数/关注关系字段），用于补全「只加载了用户、没加载推文」的场景
  function pickUser(node) {
    const uc = (node.core && typeof node.core === 'object') ? node.core : null;
    const ul = node.legacy;
    const handle = (uc && uc.screen_name) || (ul && ul.screen_name);
    if (!handle) return null;
    const fc = followersOf(node);
    const rel = relOf(node);
    if (fc === null && rel === null) return null;
    return {
      handle: String(handle),
      name: (uc && uc.name) || (ul && ul.name) || String(handle),
      avatar: (node.avatar && node.avatar.image_url) || (ul && ul.profile_image_url_https) || '',
      fc,
      rel: relOf(node)
    };
  }

  function walk(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], out, depth + 1);
      return;
    }

    const L = node.legacy;
    // full_text 是推文独有的判别标志；用户节点也有 legacy 和 created_at，但没有 full_text
    if (node.rest_id && L && typeof L.full_text === 'string') {
      const it = pickTweet(node);
      if (it) out.push(it);
      // 命中推文后不再下沉：避免把「引用推文 / 转推原文」算到原作者头上
      return;
    }

    if (node.__typename === 'TweetWithVisibilityResults' && node.tweet) {
      walk(node.tweet, out, depth + 1);
      return;
    }

    // 通用关系扫描放在用户对象识别之前：某些结构里关系字段不在 legacy 里，
    // pickUser 命中后会提前 return，先扫关系才不会漏
    const sn = typeof node.screen_name === 'string' && node.screen_name ? node.screen_name : null;
    if (sn) {
      const r = relOf(node);
      if (r) {
        if (!out.rels) out.rels = [];
        out.rels.push({ handle: sn, f: r.f, fb: r.fb, known: r.known });
      }
    }

    // 独立出现的用户对象（主页头部、搜索结果用户卡、悬停卡等）
    const u = pickUser(node);
    if (u) {
      probeUserNode(node);
      out.users.push(u);
      return;
    }

    for (const k in node) {
      if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k], out, depth + 1);
    }
  }

  /* ---------- 投递 ---------- */

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!buf.length) return;
    const items = buf;
    buf = [];
    post({ source: SRC, items });
  }

  function push(items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const k = it.handle.toLowerCase() + '|' + it.id;
      if (seen.has(k)) continue;
      seen.add(k);
      buf.push(it);
    }
    if (seen.size > SEEN_CAP) seen.clear();
    if (buf.length >= 80) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, 300);
  }

  function handleText(text, url) {
    respCount++;
    const op = opName(url);
    const hasTweet = text.indexOf('"full_text"') !== -1;
    const hasUser = text.indexOf('"followers_count"') !== -1 ||
      text.indexOf('"relationship_counts"') !== -1 ||
      text.indexOf('"relationship_perspectives"') !== -1 ||
      text.indexOf('"followed_by"') !== -1 ||
      text.indexOf('"following"') !== -1 || text.indexOf('"screen_name"') !== -1;
    if (!hasTweet && !hasUser) {
      if (respCount <= 6) post({ source: DIAG, type: 'resp', op, hasTweet: false, tweets: 0 });
      return;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return;
    }
    const out = [];
    out.users = [];
    out.rels = [];
    walk(data, out, 0);
    hitCount++;
    tweetCount += out.length;
    post({ source: DIAG, type: 'resp', op, hasTweet: out.length > 0, tweets: out.length });
    if (out.length) push(out);
    if (out.users.length) post({ source: SRC, users: out.users });
    if (out.rels.length) {
      // trustedOps：本响应里出现过显式 followed_by → 该 endpoint 此后可信，
      // 缺省布尔可当 false（借鉴「互关标记 for X」）
      const opTrusted = trustedOps.has(op);
      let makeTrusted = false;
      for (let i = 0; i < out.rels.length; i++) {
        const r = out.rels[i];
        if (r.fb !== null) makeTrusted = true;
        if (!r.known && opTrusted) r.known = true;
      }
      if (makeTrusted) trustedOps.add(op);
      post({ source: SRC, rels: out.rels });
    }
  }

  /* ---------- fetch ---------- */

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (API_RE.test(url)) {
          p.then((res) => {
            try {
              // 读文本再判定，比直接 clone().json() 更耐操，也不会因非 JSON 抛错
              res.clone().text().then((t) => handleText(t, url)).catch(() => {});
            } catch (e) {
              /* ignore */
            }
          }).catch(() => {});
        }
      } catch (e) {
        /* ignore */
      }
      return p;
    };
  }

  /* ---------- XMLHttpRequest ---------- */

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try {
        this.__xamUrl = url;
      } catch (e) {
        /* ignore */
      }
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      try {
        if (API_RE.test(String(this.__xamUrl || ''))) {
          this.addEventListener('load', () => {
            try {
              handleText(this.responseText || '', this.__xamUrl);
            } catch (e) {
              /* ignore */
            }
          });
        }
      } catch (e) {
        /* ignore */
      }
      return origSend.apply(this, arguments);
    };
  }

  window.addEventListener('pagehide', flush);

  // 供面板诊断读取
  window.__xamStats = () => ({ respCount, hitCount, tweetCount });
})();
