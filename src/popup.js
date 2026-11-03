/* 互关标记快捷弹窗：设置读写复用 settings.js，统计读 xam_data_v1 */
(function () {
  'use strict';

  const DATA_KEY = 'xam_data_v1';
  const REL_DEFS = [
    { k: 'mutual', label: '互关' },
    { k: 'nofb', label: '未回关' },
    { k: 'followme', label: '关注我' },
    { k: 'none', label: '无关注' }
  ];

  const $ = (sel) => document.querySelector(sel);
  const rowsEl = document.getElementById('rows');

  function flashSaved() {
    const s = $('#stats');
    if (s.dataset.saved) return;
    s.dataset.saved = '1';
    setTimeout(() => { delete s.dataset.saved; }, 1200);
  }

  /* ---------- 渲染设置 ---------- */

  function renderPos(v) {
    document.querySelectorAll('#posSeg button').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === v);
    });
  }

  function renderRows(s) {
    for (let i = 0; i < REL_DEFS.length; i++) {
      const d = REL_DEFS[i];
      const row = rowsEl.querySelector('.row[data-k="' + d.k + '"]');
      const it = (s.relItems && s.relItems[d.k]) || { on: true, color: '#888888' };
      row.querySelector('.color').value = it.color;
      row.querySelector('.tag').style.background = it.color;
      row.querySelector('input[type="checkbox"]').checked = it.on;
      row.style.opacity = it.on ? '' : '.45';
    }
  }

  /* ---------- 事件 ---------- */

  document.querySelectorAll('#posSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      renderPos(b.dataset.v);
      XAM.settings.saveSettings({ relPos: b.dataset.v }, flashSaved);
    });
  });

  REL_DEFS.forEach((d) => {
    const row = rowsEl.querySelector('.row[data-k="' + d.k + '"]');
    row.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
      renderRowsPatch(d.k, { on: e.target.checked });
      XAM.settings.saveSettings({ relItems: { [d.k]: { on: e.target.checked } } }, flashSaved);
    });
    row.querySelector('.color').addEventListener('change', (e) => {
      renderRowsPatch(d.k, { color: e.target.value });
      XAM.settings.saveSettings({ relItems: { [d.k]: { color: e.target.value } } }, flashSaved);
    });
  });

  function renderRowsPatch(k, patch) {
    const row = rowsEl.querySelector('.row[data-k="' + k + '"]');
    if (patch.on !== undefined) row.style.opacity = patch.on ? '' : '.45';
    if (patch.color) row.querySelector('.tag').style.background = patch.color;
  }

  $('#openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    try { chrome.runtime.openOptionsPage(); } catch (err) { window.close(); }
  });

  /* ---------- 已识别计数（meta.rel 权威源，authors 兜底） ---------- */

  function renderStats() {
    try {
      chrome.storage.local.get(['xam_meta_v1', DATA_KEY], (res) => {
        const d = res && res[DATA_KEY];
        const relMap = Object.assign(
          {},
          (d && d.authors) ? authorsRel(d.authors) : {},
          (res && res.xam_meta_v1 && res.xam_meta_v1.rel) || {}
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
        const el = $('#stats');
        if (!known) {
          el.innerHTML = '<span class="empty">已识别：暂无数据 · 刷几屏时间线后自动积累</span>';
          return;
        }
        el.innerHTML = '已识别：<b>互关 ' + c.mutual + '</b> · 未回关 <b>' + c.nofb +
          '</b> · 关注我 <b>' + c.followme + '</b>' + (c.none ? ' · 无关注 <b>' + c.none + '</b>' : '');
      });
    } catch (e) {
      $('#stats').textContent = '已识别：读取失败';
    }
  }

  function authorsRel(authors) {
    const out = {};
    for (const h in authors) {
      if (authors[h] && authors[h].rel) out[h] = authors[h].rel;
    }
    return out;
  }

  /* ---------- 启动 ---------- */

  XAM.settings.getSettings((s) => {
    renderPos(s.relPos || 'name');
    renderRows(s);
  });
  renderStats();
})();
