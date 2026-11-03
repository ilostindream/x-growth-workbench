/* X 发展工作台 · 设置页逻辑
 * 读写 settings、AI 配置、账号备注、媒体收集与本地数据
 */
(function () {
  const SET = window.XAM.settings;
  const $ = (id) => document.getElementById(id);
  const DATA_KEY = 'xam_data_v1';
  const META_KEY = 'xam_meta_v1';
  const AI_KEY = 'xam_ai_cfg_v1';

  /* ---------- 即时保存反馈 ---------- */
  let hintTimer = null;
  function savedFlash() {
    const el = $('saveHint');
    el.classList.add('on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => el.classList.remove('on'), 1200);
  }

  /* ---------- 通用绑定 ---------- */
  function bindToggle(id, key) {
    $(id).addEventListener('change', (e) => {
      SET.saveSettings({ [key]: e.target.checked }, savedFlash);
    });
  }
  function bindRange(id, key, outId, fmt) {
    const el = $(id), out = $(outId);
    const show = (v) => { out.textContent = fmt ? fmt(v) : v; };
    el.addEventListener('input', () => show(el.value));
    el.addEventListener('change', () => {
      SET.saveSettings({ [key]: Number(el.value) }, savedFlash);
    });
    return show;
  }
  function bindSelect(id, key) {
    $(id).addEventListener('change', (e) => {
      SET.saveSettings({ [key]: e.target.value }, savedFlash);
    });
  }
  function bindNum(id, key) {
    $(id).addEventListener('change', (e) => {
      SET.saveSettings({ [key]: Number(e.target.value) }, savedFlash);
    });
  }
  function bindText(id, key) {
    $(id).addEventListener('change', (e) => {
      SET.saveSettings({ [key]: e.target.value }, savedFlash);
    });
  }

  /* ---------- 徽章预览 ---------- */
  function renderBadgePreview(s) {
    const parts = ['发3'];
    if (s.badgeShowReply) parts.push('评1');
    if (s.badgeShowRt) parts.push('转2');
    if (s.badgeShowFans) parts.push('粉12,345');
    $('badgePreview').innerHTML = s.showBadge
      ? '张三 <span class="demo-badge">' + parts.join(' ') + '</span> ← 时间线实际效果'
      : '徽章已关闭，时间线不会插入任何元素';
  }

  /* ---------- 吞吐估算 ---------- */
  function renderThru(s) {
    const perMin = s.autoSync
      ? Math.round((60 / Math.max(s.autoGap, 2)) * s.autoParallel)
      : 0;
    $('thruV').textContent = perMin ? '≈ ' + perMin : '0（已关闭）';
  }

  /* ---------- 填充 ---------- */
  function fill(s) {
    $('showBadge').checked = s.showBadge;
    $('badgeShowReply').checked = s.badgeShowReply;
    $('badgeShowRt').checked = s.badgeShowRt;
    $('badgeShowFans').checked = s.badgeShowFans;
    $('panelEnabled').checked = s.panelEnabled;
    $('panelEnabledQuick').checked = s.panelEnabled;
    $('panelPos').value = s.panelPos;
    $('panelTheme').value = s.panelTheme;
    $('panelWidth').value = s.panelWidth; $('panelWidthV').textContent = s.panelWidth + 'px';
    $('listLimit').value = s.listLimit; $('listLimitV').textContent = s.listLimit;
    $('sortBy').value = s.sortBy;
    $('selfHandle').value = s.selfHandle;
    $('autoSync').checked = s.autoSync;
    $('autoGap').value = Math.round(s.autoGap / 1000); $('autoGapV').textContent = Math.round(s.autoGap / 1000);
    $('autoParallel').value = s.autoParallel; $('autoParallelV').textContent = s.autoParallel;
    $('autoTTL').value = s.autoTTL; $('autoTTLV').textContent = s.autoTTL;
    $('autoMax').value = s.autoMax; $('autoMaxV').textContent = s.autoMax;
    $('showHeat').checked = s.showHeat;
    $('hideAds').checked = s.hideAds;
    $('showNotes').checked = s.showNotes;
    $('showNameHistory').checked = s.showNameHistory;
    $('collectMedia').checked = s.collectMedia;
    $('bkBtn').checked = s.bkBtn;
    $('bkFab').checked = s.bkFab;
    $('bkNsfw').checked = s.bkNsfw;
    $('bkFolder').value = s.bkFolder;
    $('bkByUser').checked = s.bkByUser;
    $('bkPattern').value = s.bkPattern;
    $('bkZip').checked = s.bkZip;
    $('bkThumb').checked = s.bkThumb;
    $('bkSkipDl').checked = s.bkSkipDl;
    $('bkCsv').checked = s.bkCsv;
    $('bkConcurrent').value = s.bkConcurrent;
    $('bkDelay').value = s.bkDelay;
    $('bkScrollMin').value = s.bkScrollMin;
    $('bkScrollMax').value = s.bkScrollMax;
    $('debug').checked = s.debug;
    renderBadgePreview(s);
    renderThru(s);
    fillRel(s);
    renderRelStats();
  }

  SET.getSettings(fill);
  // 别处（面板开关等）改了设置时同步过来
  SET.onSettings(fill);

  bindToggle('showBadge', 'showBadge');
  bindToggle('badgeShowReply', 'badgeShowReply');
  bindToggle('badgeShowRt', 'badgeShowRt');
  bindToggle('badgeShowFans', 'badgeShowFans');
  bindToggle('panelEnabled', 'panelEnabled');
  bindToggle('panelEnabledQuick', 'panelEnabled');   // 页头快捷开关，与卡片内开关同源
  bindToggle('autoSync', 'autoSync');
  bindToggle('showHeat', 'showHeat');
  bindToggle('hideAds', 'hideAds');
  bindToggle('showNotes', 'showNotes');
  bindToggle('showNameHistory', 'showNameHistory');
  bindToggle('collectMedia', 'collectMedia');
  // 媒体备份
  bindToggle('bkBtn', 'bkBtn');
  bindToggle('bkFab', 'bkFab');
  bindToggle('bkNsfw', 'bkNsfw');
  bindToggle('bkByUser', 'bkByUser');
  bindToggle('bkZip', 'bkZip');
  bindToggle('bkThumb', 'bkThumb');
  bindToggle('bkSkipDl', 'bkSkipDl');
  bindToggle('bkCsv', 'bkCsv');
  bindNum('bkConcurrent', 'bkConcurrent');
  bindNum('bkDelay', 'bkDelay');
  bindNum('bkScrollMin', 'bkScrollMin');
  bindNum('bkScrollMax', 'bkScrollMax');
  bindText('bkFolder', 'bkFolder');
  bindText('bkPattern', 'bkPattern');
  bindToggle('debug', 'debug');
  bindSelect('panelPos', 'panelPos');
  bindSelect('panelTheme', 'panelTheme');
  bindSelect('sortBy', 'sortBy');
  bindRange('panelWidth', 'panelWidth', 'panelWidthV', (v) => v + 'px');
  bindRange('listLimit', 'listLimit', 'listLimitV');
  bindRange('autoGap', 'autoGap', 'autoGapV');
  bindRange('autoParallel', 'autoParallel', 'autoParallelV');
  bindRange('autoTTL', 'autoTTL', 'autoTTLV');
  bindRange('autoMax', 'autoMax', 'autoMaxV');

  // chips 变化时刷新预览
  ['badgeShowReply', 'badgeShowRt', 'badgeShowFans', 'showBadge'].forEach((id) => {
    $(id).addEventListener('change', () => SET.getSettings(renderBadgePreview));
  });
  ['autoGap', 'autoParallel', 'autoSync'].forEach((id) => {
    $(id).addEventListener('change', () => SET.getSettings(renderThru));
  });

  // 本人账号：失焦或回车保存
  const selfInput = $('selfHandle');
  const saveSelf = () => {
    const v = selfInput.value.trim().replace(/^@+/, '');
    SET.saveSettings({ selfHandle: v }, () => {
      selfInput.value = v;
      savedFlash();
    });
  };
  selfInput.addEventListener('blur', saveSelf);
  selfInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); selfInput.blur(); } });

  /* ---------- AI 配置 ---------- */
  function loadAi() {
    chrome.storage.local.get([AI_KEY], (res) => {
      const c = (res && res[AI_KEY]) || {};
      $('aiBase').value = c.base || 'https://api.deepseek.com';
      $('aiKey').value = c.key || '';
      $('aiModel').value = c.model || 'deepseek-flash';
      $('aiNotes').value = c.notes || '';
    });
  }
  loadAi();

  $('aiSave').addEventListener('click', () => {
    const cfg = {
      base: $('aiBase').value.trim().replace(/\/+$/, ''),
      key: $('aiKey').value.trim(),
      model: $('aiModel').value.trim() || 'deepseek-flash',
      notes: $('aiNotes').value.trim()
    };
    chrome.storage.local.set({ [AI_KEY]: cfg }, () => {
      savedFlash();
      $('aiTestOut').textContent = '已保存 ✓' + (cfg.key ? '' : '（尚未填 Key，AI 草稿不可用）');
    });
  });

  $('aiTest').addEventListener('click', () => {
    const base = $('aiBase').value.trim().replace(/\/+$/, '');
    const key = $('aiKey').value.trim();
    const out = $('aiTestOut');
    if (!key) { out.textContent = '请先填 API Key'; return; }
    out.textContent = '测试中…';
    try {
      chrome.runtime.sendMessage({ type: 'xam_ai_test', base: base, key: key }, (res) => {
        if (chrome.runtime.lastError || !res) {
          out.textContent = '无法连接后台服务，请重载扩展后重试';
          return;
        }
        if (!res.ok) { out.textContent = '✗ ' + (res.error || '校验失败'); return; }
        const list = Array.isArray(res.models) ? res.models : [];
        out.textContent = '✓ Key 有效 · 可用模型：' + (list.slice(0, 8).join('、') || '（接口未返回列表，按你填的模型名使用）');
      });
    } catch (e) {
      out.textContent = '无法连接后台服务';
    }
  });

  /* ---------- 互关标记 ---------- */
  const REL_KEYS = ['mutual', 'nofb', 'followme', 'none', 'self'];
  function fillRel(s) {
    $('relEnabled').checked = s.relEnabled;
    Array.prototype.forEach.call(document.querySelectorAll('#relPos button'), (b) => {
      b.classList.toggle('on', b.dataset.v === s.relPos);
    });
    REL_KEYS.forEach((k) => {
      const it = s.relItems[k] || { on: true, color: '#888888' };
      document.querySelector('.rel-color[data-c="' + k + '"]').value = it.color;
      document.querySelector('.rel-on[data-c="' + k + '"]').checked = it.on;
      document.querySelector('.rel-dot[data-c="' + k + '"]').style.background = it.color;
    });
  }
  $('relEnabled').addEventListener('change', (e) => SET.saveSettings({ relEnabled: e.target.checked }, savedFlash));
  Array.prototype.forEach.call(document.querySelectorAll('#relPos button'), (b) => {
    b.addEventListener('click', () => SET.saveSettings({ relPos: b.dataset.v }, savedFlash));
  });
  REL_KEYS.forEach((k) => {
    document.querySelector('.rel-color[data-c="' + k + '"]').addEventListener('change', (e) => {
      SET.saveSettings({ relItems: { [k]: { color: e.target.value } } }, savedFlash);
      document.querySelector('.rel-dot[data-c="' + k + '"]').style.background = e.target.value;
    });
    document.querySelector('.rel-on[data-c="' + k + '"]').addEventListener('change', (e) => {
      SET.saveSettings({ relItems: { [k]: { on: e.target.checked } } }, savedFlash);
    });
  });

  // 已识别计数：meta.rel 为权威源（跨天累计），authors[].rel 兜底
  function renderRelStats() {
    chrome.storage.local.get([META_KEY, DATA_KEY], (res) => {
      const d = res && res[DATA_KEY];
      const relMap = Object.assign(
        {},
        (d && d.authors) ? authorsRel(d.authors) : {},
        (res && res[META_KEY] && res[META_KEY].rel) || {}
      );
      const c = { mutual: 0, nofb: 0, followme: 0, none: 0 };
      let known = 0;
      for (const h in relMap) {
        const r = relMap[h];
        if (!r || (typeof r.f !== 'boolean' && typeof r.fb !== 'boolean')) continue;
        known++;
        if (r.f === true && r.fb === true) c.mutual++;
        else if (r.f === true && r.fb === false) c.nofb++;
        else if (r.f === false && r.fb === true) c.followme++;
        else if (r.f === false && r.fb === false) c.none++;
      }
      if (!known) { $('relStats').textContent = '已识别：暂无数据 · 刷几屏时间线后自动积累'; return; }
      $('relStats').innerHTML = '已识别：互关 <b>' + c.mutual + '</b> · 未回关 <b>' + c.nofb +
        '</b> · 关注我 <b>' + c.followme + '</b> · 无关注 <b>' + c.none + '</b>';
    });
  }

  function authorsRel(authors) {
    const out = {};
    for (const h in authors) {
      if (authors[h] && authors[h].rel) out[h] = authors[h].rel;
    }
    return out;
  }

  /* ---------- 账号备注（独立存储 META_KEY.notes，与内容脚本读-合并-写共存） ---------- */
  let metaNotes = {};
  let metaMedia = {};

  function updateMeta(patch, cb) {
    chrome.storage.local.get([META_KEY], (res) => {
      const cur = res && res[META_KEY] || {};
      const next = Object.assign({}, cur, patch || {});
      chrome.storage.local.set({ [META_KEY]: next }, () => { if (cb) cb(next); });
    });
  }

  function renderNotes() {
    const box = $('noteList');
    const handles = Object.keys(metaNotes).sort();
    if (!handles.length) {
      box.innerHTML = '<div class="empty-list">还没有备注。添加后，时间线上该账号名字旁会显示彩色备注标签。</div>';
      return;
    }
    box.innerHTML = '';
    handles.forEach((h) => {
      const n = metaNotes[h] || {};
      const item = document.createElement('div');
      item.className = 'note-item';
      const dot = document.createElement('i');
      dot.className = 'dot';
      dot.style.background = n.c || '#1d9bf0';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = '@' + h;
      const nt = document.createElement('span');
      nt.className = 'nt';
      nt.textContent = n.t || '';
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = '删除';
      del.addEventListener('click', () => {
        const next = Object.assign({}, metaNotes);
        delete next[h];
        updateMeta({ notes: next }, () => {
          metaNotes = next;
          renderNotes();
          savedFlash();
        });
      });
      item.appendChild(dot); item.appendChild(nm); item.appendChild(nt); item.appendChild(del);
      box.appendChild(item);
    });
  }

  function loadMetaUi() {
    chrome.storage.local.get([META_KEY], (res) => {
      const m = res && res[META_KEY] || {};
      metaNotes = m.notes || {};
      metaMedia = m.media || {};
      renderNotes();
      renderMedia();
    });
  }

  $('noteAdd').addEventListener('click', () => {
    const h = $('noteHandle').value.trim().replace(/^@+/, '').toLowerCase();
    const t = $('noteText').value.trim();
    const c = $('noteColor').value;
    if (!h || !t) { $('noteHandle').placeholder = '请先填账号和备注内容'; return; }
    const next = Object.assign({}, metaNotes);
    next[h] = { t: t, c: c };
    updateMeta({ notes: next }, () => {
      metaNotes = next;
      renderNotes();
      savedFlash();
      $('noteHandle').value = '';
      $('noteText').value = '';
    });
  });

  /* ---------- 媒体收集与下载 ---------- */
  const mediaChecked = new Set();

  function fileExt(u, t) {
    if (t === 'photo') return /\.png($|\?)/.test(u) ? 'png' : 'jpg';
    const m = /\.(mp4|m3u8|webm)/.exec(u);
    return m ? m[1] : 'mp4';
  }

  function renderMedia() {
    const box = $('mediaList');
    const urls = Object.keys(metaMedia);
    $('mediaStats').textContent = urls.length
      ? '已收集 ' + urls.length + ' 个媒体文件（图片为原图，视频为最高码率 mp4）。勾选后点击「下载勾选项」。'
      : '还没有收集到媒体。在 x.com 刷包含图片/视频的时间线，地址会自动出现在这里。';
    if (!urls.length) {
      box.innerHTML = '<div class="empty-list">空 — 去 x.com 刷一刷带图/带视频的时间线</div>';
      return;
    }
    // 新的在前
    urls.sort((a, b) => ((metaMedia[b] && metaMedia[b].ts) || 0) - ((metaMedia[a] && metaMedia[a].ts) || 0));
    box.innerHTML = '';
    urls.forEach((u) => {
      const md = metaMedia[u] || {};
      const item = document.createElement('div');
      item.className = 'media-item';
      if (md.t === 'photo') {
        const img = document.createElement('img');
        img.className = 'thumb';
        img.loading = 'lazy';
        img.src = u.replace('?format=jpg&name=orig', '?format=jpg&name=small');
        item.appendChild(img);
      } else {
        const v = document.createElement('div');
        v.className = 'vid';
        v.textContent = md.t === 'gif' ? '🎞' : '🎬';
        item.appendChild(v);
      }
      const chk = document.createElement('label');
      chk.className = 'chk';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = mediaChecked.has(u);
      cb.addEventListener('change', () => {
        if (cb.checked) mediaChecked.add(u); else mediaChecked.delete(u);
      });
      chk.appendChild(cb);
      item.appendChild(chk);
      const del = document.createElement('span');
      del.className = 'delx';
      del.textContent = '✕';
      del.title = '从列表移除';
      del.addEventListener('click', () => {
        const next = Object.assign({}, metaMedia);
        delete next[u];
        mediaChecked.delete(u);
        updateMeta({ media: next }, () => {
          metaMedia = next;
          renderMedia();
        });
      });
      item.appendChild(del);
      const cap = document.createElement('div');
      cap.className = 'cap2';
      cap.textContent = '@' + (md.h || '?') + ' · ' + (md.t || '');
      item.appendChild(cap);
      box.appendChild(item);
    });
  }

  $('mediaAll').addEventListener('click', () => {
    Object.keys(metaMedia).forEach((u) => mediaChecked.add(u));
    renderMedia();
  });
  $('mediaNone').addEventListener('click', () => {
    mediaChecked.clear();
    renderMedia();
  });

  let dlBusy = false;
  $('mediaDl').addEventListener('click', async () => {
    if (dlBusy) return;
    const urls = Object.keys(metaMedia).filter((u) => mediaChecked.has(u));
    if (!urls.length) { $('mediaStats').textContent = '先勾选要下载的文件'; return; }
    dlBusy = true;
    let done = 0, fail = 0;
    $('mediaStats').textContent = '下载中 0/' + urls.length + ' …';
    for (const u of urls) {
      const md = metaMedia[u] || {};
      try {
        const resp = await fetch(u);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'xam_' + (md.h || 'user') + '_' + (md.id || Date.now()) + '.' + fileExt(u, md.t);
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 8000);
        done++;
      } catch (e) {
        fail++;
      }
      $('mediaStats').textContent = '下载中 ' + done + '/' + urls.length + (fail ? ' · 失败 ' + fail : '') + ' …';
      await new Promise((r) => setTimeout(r, 350));   // 温和节流
    }
    $('mediaStats').textContent = '完成：成功 ' + done + (fail ? ' · 失败 ' + fail : '') + '。若浏览器拦截了多文件下载，请在地址栏右侧选择「允许」。';
    dlBusy = false;
  });

  // 内容脚本那边收集到了新媒体 → 刷新
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch[META_KEY]) return;
      const nv = ch[META_KEY].newValue || {};
      metaNotes = nv.notes || {};
      metaMedia = nv.media || {};
      renderNotes();
      renderMedia();
    });
  } catch (e) {}

  /* ---------- 数据管理 ---------- */
  function renderDataStats() {
    chrome.storage.local.get([DATA_KEY], (res) => {
      const d = res && res[DATA_KEY];
      if (!d || !d.authors) {
        $('dataStats').textContent = '今日暂无统计数据';
        return;
      }
      let n = 0;
      for (const h in d.authors) {
        const a = d.authors[h];
        n += (a.post ? a.post.length : 0) + (a.reply ? a.reply.length : 0) + (a.rt ? a.rt.length : 0);
      }
      $('dataStats').textContent =
        '统计日期 ' + (d.date || '–') + ' · ' + Object.keys(d.authors).length + ' 位用户 · ' + n + ' 条记录';
    });
  }
  renderDataStats();
  loadMetaUi();

  $('expBtn').addEventListener('click', () => {
    chrome.storage.local.get([DATA_KEY, SET.SET_KEY, AI_KEY, META_KEY], (res) => {
      const meta = res[META_KEY] || {};
      const payload = {
        _export: 'xam',
        _at: new Date().toISOString(),
        data: res[DATA_KEY] || null,
        settings: res[SET.SET_KEY] || null,
        notes: meta.notes || {},
        ai: { base: (res[AI_KEY] || {}).base || '', model: (res[AI_KEY] || {}).model || '', notes: (res[AI_KEY] || {}).notes || '' }
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'xam-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    });
  });

  $('impBtn').addEventListener('click', () => $('impFile').click());
  $('impFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const j = JSON.parse(String(rd.result));
        if (!j || j._export !== 'xam') throw new Error('不是本扩展导出的文件');
        const patch = {};
        if (j.data && typeof j.data === 'object') patch[DATA_KEY] = j.data;
        if (j.settings && typeof j.settings === 'object') patch[SET.SET_KEY] = SET.normSettings(j.settings);
        if (j.notes && typeof j.notes === 'object') {
          chrome.storage.local.get([META_KEY], (cur) => {
            const m = Object.assign({}, cur[META_KEY] || {});
            m.notes = Object.assign({}, m.notes || {}, j.notes);
            chrome.storage.local.set({ [META_KEY]: m });
          });
        }
        if (j.ai && typeof j.ai === 'object') {
          // 导入的 AI 配置不覆盖已有 Key，除非文件里带了
          chrome.storage.local.get([AI_KEY], (cur) => {
            const c = Object.assign({}, cur[AI_KEY] || {});
            if (j.ai.base) c.base = j.ai.base;
            if (j.ai.model) c.model = j.ai.model;
            if (j.ai.notes) c.notes = j.ai.notes;
            if (j.ai.key) c.key = j.ai.key;
            patch[AI_KEY] = c;
            chrome.storage.local.set(patch, () => {
              renderDataStats(); loadAi(); loadMetaUi(); SET.getSettings(fill);
              $('dataStats').textContent += ' · 导入完成，刷新 x.com 生效';
            });
          });
          return;
        }
        chrome.storage.local.set(patch, () => {
          renderDataStats(); loadMetaUi(); SET.getSettings(fill);
          $('dataStats').textContent += ' · 导入完成，刷新 x.com 生效';
        });
      } catch (err) {
        $('dataStats').textContent = '导入失败：' + (err && err.message ? err.message : '文件解析失败');
      }
    };
    rd.readAsText(f);
    e.target.value = '';
  });

  $('clrBtn').addEventListener('click', () => {
    if (!confirm('确定清空今日统计数据？此操作不可恢复。（备注与媒体收集不受影响）')) return;
    chrome.storage.local.remove([DATA_KEY], () => {
      renderDataStats();
      $('dataStats').textContent = '已清空。回到 x.com 刷新页面重新统计。';
    });
  });

  /* ---------- 媒体备份：下载历史 ---------- */

  const BK_HISTORY_KEY = 'xam_bk_history_v1';
  let bkHist = {};                       // url → rec
  let bkHistDirty = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function fmtTs(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function loadBkHist() {
    chrome.storage.local.get([BK_HISTORY_KEY], (res) => {
      bkHist = (res && res[BK_HISTORY_KEY]) || {};
      renderBkHist();
      if (!bkHistDirty) chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch[BK_HISTORY_KEY] && !bkHistDirty) {
          bkHist = ch[BK_HISTORY_KEY].newValue || {};
          renderBkHist();
        }
      });
    });
  }

  function renderBkHist() {
    const q = ($('bkHistQ').value || '').toLowerCase().trim();
    const type = $('bkHistType').value;
    const recs = Object.keys(bkHist).map((u) => bkHist[u]).filter((r) => r && r.u);
    let shown = recs;
    if (q) shown = shown.filter((r) => ((r.h || '') + (r.f || '') + (r.id || '')).toLowerCase().indexOf(q) !== -1);
    if (type) shown = shown.filter((r) => r.t === type);
    shown.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    $('bkHistStats').textContent = '共 ' + recs.length + ' 条记录' + (shown.length !== recs.length ? '，筛选后 ' + shown.length + ' 条' : '') + '（上限 5000，超出自动淘汰最旧）';
    const MAXSHOW = 200;
    $('bkHistList').innerHTML = shown.slice(0, MAXSHOW).map((r) => {
      const isImg = r.t !== 'video' && r.t !== 'gif';
      const thumb = isImg ? r.u : (r.u && r.u.indexOf('video.twimg') === 0 ? '' : r.u);
      return '<div class="media-item" style="display:flex;gap:8px;align-items:center;padding:6px 4px;border-bottom:1px solid rgba(127,127,127,.15);">' +
        (thumb ? '<img src="' + esc(thumb) + '" referrerpolicy="no-referrer" style="width:44px;height:44px;object-fit:cover;border-radius:6px;flex:none;">' : '<span style="width:44px;height:44px;flex:none;display:flex;align-items:center;justify-content:center;background:rgba(127,127,127,.12);border-radius:6px;">🎬</span>') +
        '<div style="min-width:0;flex:1;line-height:1.5;">' +
        '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;">@' + esc(r.h || '?') + ' · ' + esc(r.t || 'photo') + '</div>' +
        '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.65;font-size:11px;">' + esc(r.f || r.u) + '</div>' +
        '<div style="opacity:.5;font-size:11px;">推文 ' + esc(r.id || '?') + ' · 下载于 ' + fmtTs(r.ts) + '</div>' +
        '</div>' +
        '<a class="btn" href="' + esc(r.u) + '" target="_blank" referrerpolicy="no-referrer" style="flex:none;font-size:11px;padding:4px 8px;">打开</a>' +
        '</div>';
    }).join('') + (shown.length > MAXSHOW ? '<p class="note">仅显示最新 ' + MAXSHOW + ' 条，可先用筛选缩小范围。</p>' : '');
  }

  $('bkHistQ').addEventListener('input', renderBkHist);
  $('bkHistType').addEventListener('change', renderBkHist);
  $('bkHistCsv').addEventListener('click', () => {
    const recs = Object.keys(bkHist).map((u) => bkHist[u]).filter((r) => r && r.u)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (!recs.length) { $('bkHistStats').textContent = '没有可导出的记录'; return; }
    const csvCell = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
    const rows = [['用户', '推文ID', '类型', '保存路径', '媒体地址', '下载时间']];
    recs.forEach((r) => rows.push([r.h, r.id, r.t, r.f, r.u, fmtTs(r.ts)]));
    const csv = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'xam-backup-history-' + Date.now() + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  $('bkHistClear').addEventListener('click', () => {
    if (!Object.keys(bkHist).length) return;
    if (!confirm('确定清空全部 ' + Object.keys(bkHist).length + ' 条下载历史？此操作不可恢复。')) return;
    bkHistDirty = true;
    chrome.storage.local.remove(BK_HISTORY_KEY, () => {
      bkHist = {};
      bkHistDirty = false;
      renderBkHist();
      savedFlash();
    });
  });
  loadBkHist();

  /* ---------- 侧栏导航 + 卡片手风琴（一次只展开一个，BlueV 同款） ---------- */
  const links = Array.prototype.slice.call(document.querySelectorAll('#nav a'));
  const secs = links.map((a) => document.querySelector(a.getAttribute('href')));
  const GROUP_NAMES = ['时间线统计', '时间线增强', '媒体备份', '统计与同步', 'AI 助手', '数据', '关于'];

  function activate(i) {
    links.forEach((a, k) => a.classList.toggle('on', k === i));
    secs.forEach((s, k) => { if (s) s.hidden = k !== i; });
    $('crumbGroup').textContent = GROUP_NAMES[i] || '';
  }
  links.forEach((a, i) => a.addEventListener('click', (e) => {
    e.preventDefault();
    activate(i);
    history.replaceState(null, '', a.getAttribute('href'));
  }));
  activate(0);

  // 卡片手风琴：点击标题展开，同组内一次只展开一个
  document.querySelectorAll('.group').forEach((grp) => {
    const cards = Array.prototype.slice.call(grp.querySelectorAll('.card'));
    cards.forEach((card) => {
      card.querySelector('.card-hd').addEventListener('click', () => {
        const isOpen = card.classList.contains('open');
        cards.forEach((c) => c.classList.remove('open'));
        if (!isOpen) card.classList.add('open');
      });
    });
  });
})();
