/* X 发展工作台 —— 后台服务
 * 1. 开/关同步标签页
 * 2. 接收各同步页捕获的数据，串行合并入本地存储（并行补拉时多页签同写会互相覆盖，
 *    所以所有同步页都不直接写 KEY，统一经这里排队合并）
 * 3. AI 草稿：代调 OpenAI 兼容接口（服务进程无跨域限制，密钥存本地）
 */

const KEY = 'xam_data_v1';
const META_KEY = 'xam_meta_v1';
let writeChain = Promise.resolve();

const KINDS = ['post', 'reply', 'rt'];

function uniq(arr) {
  const out = [];
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] === 'string' && out.indexOf(arr[i]) === -1) out.push(arr[i]);
  }
  return out;
}

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
      post: uniq(a.post), reply: uniq(a.reply), rt: uniq(a.rt)
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
    for (let ki = 0; ki < KINDS.length; ki++) {
      const k = KINDS[ki];
      const arr = a[k];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        if (typeof arr[i] === 'string' && o[k].indexOf(arr[i]) === -1) o[k].push(arr[i]);
      }
    }
  }
  return out;
}

function todayStr() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function mergeIntoStorage(authors, self) {
  const res = await chrome.storage.local.get([KEY]);
  const cur = res && res[KEY];
  const today = todayStr();
  const base = cur && cur.date === today && cur.authors ? cur.authors : {};
  await chrome.storage.local.set({
    [KEY]: {
      date: today,
      authors: mergeAuthors(base, authors),
      self: self || (cur && cur.self) || null,
      savedAt: Date.now()
    }
  });
}

/* meta（rel/heat/media/notes）串行合并。
 * 布尔关系用「新值非 null 才覆盖」；heat/media 超限按 ts 淘汰。
 * notes 整体按键覆盖。 */
const HEAT_CAP = 3200;
const MEDIA_CAP = 400;

function capByTs(obj, cap) {
  const ks = Object.keys(obj);
  if (ks.length <= cap) return obj;
  ks.sort((a, b) => ((obj[a] && obj[a].ts) || 0) - ((obj[b] && obj[b].ts) || 0));
  const drop = ks.slice(0, ks.length - cap);
  for (let i = 0; i < drop.length; i++) delete obj[drop[i]];
  return obj;
}

function mergeRelMap(base, add) {
  const out = Object.assign({}, base);
  for (const h in add) {
    const r = normRel(add[h]);
    if (!r) continue;
    const cur = out[h] && typeof out[h] === 'object' ? out[h] : { f: null, fb: null };
    if (r.f !== null) cur.f = r.f;
    if (r.fb !== null) cur.fb = r.fb;
    out[h] = cur;
  }
  return out;
}

async function mergeMetaIntoStorage(delta) {
  const res = await chrome.storage.local.get([META_KEY]);
  const base = (res && res[META_KEY]) || {};
  const d = delta || {};

  const out = {
    heat: capByTs(Object.assign({}, base.heat, d.heat || {}), HEAT_CAP),
    media: capByTs(Object.assign({}, base.media, d.media || {}), MEDIA_CAP),
    notes: Object.assign({}, base.notes, d.notes || {}),
    rel: mergeRelMap(base.rel || {}, d.rel || {})
  };
  await chrome.storage.local.set({ [META_KEY]: out });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'xam_open_tab' && typeof msg.url === 'string' &&
      /^https:\/\/(x|twitter)\.com\//.test(msg.url)) {
    // 手动同步（active:true）必须前台：Chrome 节流后台页，无限滚动不加载第二页；
    // 自动补全（active:false）只取第一页，不受影响
    chrome.tabs.create({ url: msg.url, active: msg.active !== false }, (tab) => {
      sendResponse({ ok: true, tabId: tab ? tab.id : null });
    });
    return true;   // 异步响应
  }

  if (msg.type === 'xam_open_options') {
    // 设置页必须由扩展上下文打开：内容脚本的 window.open(chrome-extension://…) 会被拦截
    try {
      if (typeof chrome.runtime.openOptionsPage === 'function') {
        chrome.runtime.openOptionsPage(() => void chrome.runtime.lastError);
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL('src/options.html') });
      }
    } catch (e) {}
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'xam_close_self' && sender && sender.tab && Number.isInteger(sender.tab.id)) {
    // 同步标签页抓取完成，自行关闭
    chrome.tabs.remove(sender.tab.id, () => {
      void chrome.runtime.lastError;
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'xam_close_tab' && Number.isInteger(msg.tabId)) {
    chrome.tabs.remove(msg.tabId, () => {
      void chrome.runtime.lastError;   // 标签页可能已被用户手动关掉，忽略
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'xam_merge' && msg.authors && typeof msg.authors === 'object') {
    // 串行合并：所有同步页的写入在此排队，杜绝读-改-写竞争
    writeChain = writeChain
      .then(() => mergeIntoStorage(msg.authors, msg.self))
      .catch(() => {})
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'xam_meta_merge' && msg.meta && typeof msg.meta === 'object') {
    // meta（rel/heat/media/notes）统一在此串行合并：
    // 同步页抓到的关系数据以前被「同步页不落盘」守卫直接丢弃，现在与推文同路入库
    writeChain = writeChain
      .then(() => mergeMetaIntoStorage(msg.meta))
      .catch(() => {})
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'xam_ai' && msg.payload && typeof msg.payload === 'object') {
    callLLM(msg.payload)
      .then((text) => sendResponse({ ok: true, text: text }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === 'xam_ai_test' && typeof msg.base === 'string' && typeof msg.key === 'string') {
    // 校验 Key 并拉取可用模型列表（首次配置时用，避免填错模型名白折腾）
    testLLM(msg.base, msg.key)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  /* ---------- 媒体备份（借鉴 MediaHarvest / X Content Backup Tool）---------- */

  if (msg.type === 'xam_bk_download' && typeof msg.url === 'string') {
    // 单文件下载：filename 相对浏览器默认下载目录；uniquify 自动重名加序号
    chrome.downloads.download({
      url: msg.url,
      filename: msg.filename || undefined,
      saveAs: false,
      conflictAction: 'uniquify'
    }, (id) => {
      if (chrome.runtime.lastError || !id) {
        sendResponse({ ok: false, error: String(chrome.runtime.lastError && chrome.runtime.lastError.message || 'download failed') });
      } else {
        sendResponse({ ok: true, id: id });
      }
    });
    return true;
  }

  if (msg.type === 'xam_bk_zip' && Array.isArray(msg.files) && msg.files.length && typeof msg.out === 'string') {
    // zip 打包：后台逐个 fetch（pbs.twimg.com / video.twimg.com 已在 host_permissions）
    makeZip(msg.files)
      .then((blob) => new Promise((resolve, reject) => {
        const u = URL.createObjectURL(blob);
        chrome.downloads.download({ url: u, filename: msg.out, saveAs: false, conflictAction: 'uniquify' }, (id) => {
          setTimeout(() => URL.revokeObjectURL(u), 60000);
          if (chrome.runtime.lastError || !id) reject(new Error(chrome.runtime.lastError && chrome.runtime.lastError.message || 'zip download failed'));
          else resolve(id);
        });
      }))
      .then((id) => sendResponse({ ok: true, id: id }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === 'xam_bk_history' && Array.isArray(msg.items)) {
    // 下载历史入库（串行合并，LRU 5000）
    writeChain = writeChain
      .then(() => mergeBkHistory(msg.items))
      .catch(() => {})
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'xam_bk_cache' && msg.tweets && typeof msg.tweets === 'object') {
    // 推文详情缓存入库（串行合并，LRU 3000，供备份面板按推文取媒体/计数）
    writeChain = writeChain
      .then(() => mergeBkCache(msg.tweets))
      .catch(() => {})
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  return;
});

/* ---------- 媒体备份：存储与 zip ---------- */

const BK_HISTORY_KEY = 'xam_bk_history_v1';
const BK_CACHE_KEY = 'xam_bk_tweets_v1';
const BK_HISTORY_CAP = 5000;
const BK_CACHE_CAP = 3000;

// 通用 LRU 淘汰：对象值需含 ts（秒或毫秒均可，只比相对大小）
function capObjByTs(obj, cap) {
  const ks = Object.keys(obj);
  if (ks.length <= cap) return obj;
  ks.sort((a, b) => ((obj[a] && obj[a].ts) || 0) - ((obj[b] && obj[b].ts) || 0));
  const drop = ks.slice(0, ks.length - cap);
  for (let i = 0; i < drop.length; i++) delete obj[drop[i]];
  return obj;
}

async function mergeBkHistory(items) {
  const res = await chrome.storage.local.get([BK_HISTORY_KEY]);
  const cur = (res && res[BK_HISTORY_KEY]) || {};
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it.u !== 'string') continue;
    cur[it.u] = {
      u: it.u, f: it.f || '', h: it.h || '', id: it.id || '',
      t: it.t || 'photo', ts: it.ts || Date.now()
    };
  }
  await chrome.storage.local.set({ [BK_HISTORY_KEY]: capObjByTs(cur, BK_HISTORY_CAP) });
}

async function mergeBkCache(tweets) {
  const res = await chrome.storage.local.get([BK_CACHE_KEY]);
  const cur = (res && res[BK_CACHE_KEY]) || {};
  for (const id in tweets) {
    const t = tweets[id];
    if (!t || typeof t !== 'object') continue;
    // 新值覆盖旧值，但 media 缺失时保留旧 media（分批截获可能只有一条含 extended_entities）
    const old = cur[id];
    if (old && old.media && !(t.media && t.media.length)) t.media = old.media;
    cur[id] = t;
  }
  await chrome.storage.local.set({ [BK_CACHE_KEY]: capObjByTs(cur, BK_CACHE_CAP) });
}

/* STORE（不压缩）zip writer：图片/视频本身已是压缩格式，STORE 零损耗且实现简单。
 * CRC32 表驱动；分卷由调用方控制（content 端按 120 文件/卷切分）。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const nameBytes = enc.encode(f.name);
    let data;
    try {
      const r = await fetch(f.url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      // 单个失败不影响整卷，记录占位便于排查
      data = enc.encode('XAM-DOWNLOAD-FAILED: ' + f.url);
    }
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);          // version
    lh.setUint16(6, 0x0800, true);      // UTF-8 flag
    lh.setUint16(8, 0, true);           // STORE
    lh.setUint16(10, 0, true);          // time
    lh.setUint16(12, 0x21, true);       // date (1980-1-1, 无关紧要)
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    chunks.push(lh.buffer, nameBytes, data);
    central.push({ nameBytes, crc, size: data.length, offset: offset });
    offset += 30 + nameBytes.length + data.length;
    if (i % 5 === 0 || i === files.length - 1) {
      try { chrome.runtime.sendMessage({ type: 'xam_bk_zip_prog', done: i + 1, total: files.length }); } catch (e) {}
    }
  }
  const cdStart = offset;
  for (let i = 0; i < central.length; i++) {
    const c = central[i];
    const dh = new DataView(new ArrayBuffer(46));
    dh.setUint32(0, 0x02014b50, true);
    dh.setUint16(4, 20, true);
    dh.setUint16(6, 20, true);
    dh.setUint16(8, 0x0800, true);
    dh.setUint16(10, 0, true);
    dh.setUint16(12, 0, true);
    dh.setUint16(14, 0x21, true);
    dh.setUint32(16, c.crc, true);
    dh.setUint32(20, c.size, true);
    dh.setUint32(24, c.size, true);
    dh.setUint16(28, c.nameBytes.length, true);
    dh.setUint32(42, c.offset, true);
    chunks.push(dh.buffer, c.nameBytes);
    offset += 46 + c.nameBytes.length;
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, offset - cdStart, true);
  eocd.setUint32(16, cdStart, true);
  chunks.push(eocd.buffer);
  return new Blob(chunks, { type: 'application/zip' });
}

/* ---------- AI 草稿：OpenAI 兼容接口 ---------- */

const AI_CFG_KEY = 'xam_ai_cfg_v1';
// DeepSeek 于 2026-07-24 停用 deepseek-chat / deepseek-reasoner，现行为 deepseek-flash / deepseek-v4-pro
const DEFAULT_MODEL = 'deepseek-flash';

async function callLLM(p) {
  const res = await chrome.storage.local.get([AI_CFG_KEY]);
  const cfg = (res && res[AI_CFG_KEY]) || {};
  if (!cfg.key) throw new Error('未设置 API Key');
  const base = String(cfg.base || 'https://api.deepseek.com').replace(/\/+$/, '');
  const isDS = /deepseek\.com/i.test(base);
  const model = cfg.model || DEFAULT_MODEL;

  // 风格备注统一兜底：后台每次调用都从 storage 读最新配置，
  // 内容脚本里的 aiCfg 可能过期（X 是 SPA，页面长期不刷新），以此处为准。
  // 仅对 useStyle 任务生效（翻译/校对不带，避免把口语粗口带进译文）。
  const STYLE_MARK = '【说话风格·最高优先级】';
  let system = p.system || '';
  if (p.useStyle && cfg.notes && system.indexOf(STYLE_MARK) === -1) {
    system += '\n\n' + STYLE_MARK + '\n用户的说话风格设定：' + cfg.notes + '\n' +
      '这是最高优先级约束，输出必须明显体现：语气、句长、用词习惯都要跟着它走，不要输出中性、书面化或客服腔的默认文案。' +
      '若设定中包含粗口偏好，允许使用轻度口语粗口来表达情绪，但不得出现辱骂、歧视或人身攻击。' +
      '若与「只输出内容本身」等格式要求冲突，格式要求仍优先。';
  }

  function buildBody(m) {
    const b = {
      model: m,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: p.user }
      ],
      max_tokens: 400
    };
    if (isDS) {
      // DeepSeek-V4 默认开启思考模式：思维链会吃掉 max_tokens 预算，导致 content 为空。
      // 短回复不需要推理，显式关闭；关闭后才支持 temperature。
      b.thinking = { type: 'disabled' };
      b.temperature = 0.9;
    } else {
      b.temperature = 0.9;
    }
    return b;
  }

  async function once(m) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let r;
    try {
      r = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cfg.key
        },
        body: JSON.stringify(buildBody(m)),
        signal: ctrl.signal
      });
    } catch (e) {
      // 无超时的话，网络/代理挂起会让「生成中…」永远转圈
      if (e && e.name === 'AbortError') throw new Error('请求 30 秒无响应（超时）——多为网络或代理不通');
      throw e;
    } finally {
      clearTimeout(timer);
    }
    const raw = await r.text().catch(() => '');
    if (!r.ok) {
      const err = new Error('HTTP ' + r.status + (raw ? ' · ' + raw.slice(0, 200) : ''));
      err.status = r.status;
      err.body = raw;
      throw err;
    }
    let j = null;
    try { j = JSON.parse(raw); } catch (e) {}
    const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return typeof c === 'string' ? c.trim() : '';
  }

  let text = '';
  try {
    text = await once(model);
  } catch (e) {
    // 模型名失效（DeepSeek 于 2026-07-24 停用 deepseek-chat/reasoner）时自动降级重试
    const modelErr = e && e.status === 400 && /model/i.test(e.body || '');
    if (!isDS || !modelErr || model === DEFAULT_MODEL) {
      // 503/529 = 服务端过载（Service is too busy），2 秒后自动重试一次
      if (e && (e.status === 503 || e.status === 529)) {
        await new Promise((r2) => setTimeout(r2, 2000));
        text = await once(model);
      } else {
        throw e;
      }
    } else {
      text = await once(DEFAULT_MODEL);
    }
  }
  if (!text) throw new Error('响应里没有内容（可能是模型名不存在或余额不足）');
  return text;
}

/* 校验 Key：GET /models。返回可用模型名，供设置界面选择 */
async function testLLM(baseRaw, key) {
  const base = String(baseRaw || 'https://api.deepseek.com').replace(/\/+$/, '');
  let r;
  try {
    r = await fetch(base + '/models', { headers: { 'Authorization': 'Bearer ' + key } });
  } catch (e) {
    throw new Error('网络不可达（若是其他厂商的接口，需在 manifest 的 host_permissions 里放行该域名）');
  }
  const raw = await r.text().catch(() => '');
  if (!r.ok) {
    const hint = r.status === 401 ? 'Key 无效或已被删除' :
      r.status === 403 ? 'Key 没有权限' :
      r.status === 404 ? '接口地址不对（一般填 https://api.deepseek.com）' : '校验失败';
    throw new Error('HTTP ' + r.status + ' · ' + hint + (raw ? ' · ' + raw.slice(0, 120) : ''));
  }
  let j = null;
  try { j = JSON.parse(raw); } catch (e) {}
  const list = ((j && j.data) || []).map((m) => m && m.id).filter((id) => typeof id === 'string');
  return { ok: true, models: list };
}
