/* X 发展工作台 —— 配置模块（内容脚本与设置页共用）
 * 统一默认值、范围约束与读写入口，避免两处默认值漂移。
 */
(function () {
  const KEY = 'xam_settings_v1';

  const DEFAULTS = {
    // 徽章（时间线内联）
    showBadge: true,
    badgeShowReply: true,     // 徽章显示「评」
    badgeShowRt: false,       // 徽章显示「转」
    badgeShowFans: false,     // 徽章显示「粉」
    // 面板
    panelEnabled: true,
    panelPos: 'tr',           // tr | tl | br | bl（默认右上：右下与「返回顶部」类扩展冲突，左下遮挡阅读）
    posV: 3,                  // 布局版本：v3 起默认右上；用户手动选择后不再迁移
    panelWidth: 306,
    panelTheme: 'auto',       // auto | light | dark
    listLimit: 60,
    sortBy: 'activity',       // activity | post | reply | fans
    // 自动补全
    autoSync: true,
    autoGap: 5000,            // ms，两次启动的间隔
    autoParallel: 3,          // 并行后台页签数
    autoTTL: 15,              // 分钟，同一用户冷却
    autoMax: 60,              // 单会话上限
    // 统计
    selfHandle: '',           // 手动指定本人账号（留空=自动识别）
    // 互关标记
    relEnabled: true,
    relPos: 'name',           // avatar=头像上方 | name=名字后面
    relItems: {               // 每种关系：是否显示 + 颜色
      mutual:   { on: true, color: '#00ba7c' },   // 互关
      nofb:     { on: true, color: '#f4212e' },   // 未回关
      followme: { on: true, color: '#f7931a' },   // 关注我
      none:     { on: true, color: '#8899a6' },   // 无关注
      self:     { on: true, color: '#f7b500' }    // 本尊（自己）
    },
    // 时间线增强（借鉴 BlueV 的广受欢迎功能）
    showHeat: true,           // 流速勋章：推文右上角显示平均每小时浏览量
    hideAds: false,           // 隐藏带广告标记的推文（BlueV 同款默认关）
    showNotes: true,          // 时间线上显示账号备注色标
    collectMedia: true,       // 收集时间线里的图片/视频原始地址，供批量下载
    // 媒体备份（借鉴 MediaHarvest / X Content Backup Tool 的全功能集）
    bkFab: true,              // 时间线右侧悬浮批量下载按钮
    bkBtn: true,              // 推文工具栏「备份」按钮（下载该推文全部媒体）
    bkFolder: 'XAM-Media',    // 子文件夹（空 = 直接进浏览器下载目录）
    bkByUser: true,           // 再按作者 handle 分一层子文件夹
    bkPattern: '{account}_{tweetid}_{serial}',   // 文件名模板
    bkZip: false,             // 打包为 zip（大任务自动分卷）
    bkThumb: false,           // 视频同时下载缩略图
    bkSkipDl: true,           // 跳过下载历史里已有的文件
    bkConcurrent: 2,          // 并发下载数
    bkDelay: 600,             // 两次下载间隔 ms（防 429）
    bkCsv: true,              // 批量完成后导出推文数据表格 CSV
    bkNsfw: false,            // 自动显示敏感内容（移除模糊遮罩）
    bkScrollMin: 900,         // 自动滚动间隔下限 ms
    bkScrollMax: 1800,        // 自动滚动间隔上限 ms
    // 调试
    debug: false
  };

  function clampInt(v, min, max, def) {
    const n = typeof v === 'number' ? v : parseInt(v, 10);
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  // 子文件夹名清洗：按 / 分层，每层去掉 Windows 非法字符
  function sanitizeFolder(v) {
    const raw = String(v == null ? '' : v).trim();
    if (!raw) return '';
    const parts = [];
    raw.split('/').forEach((p) => {
      const c = p.replace(/[<>:"\\|?*\u0000-\u001f]/g, '').replace(/^\.+|\.+$/g, '').trim();
      if (c) parts.push(c);
    });
    return parts.slice(0, 4).join('/');
  }

  // 规范化：补齐缺省字段 + 纠正越界值 + 清洗类型
  function normSettings(raw) {
    const s = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
    s.showBadge = s.showBadge !== false;
    s.badgeShowReply = s.badgeShowReply !== false;
    s.badgeShowRt = !!s.badgeShowRt;
    s.badgeShowFans = !!s.badgeShowFans;
    s.panelEnabled = s.panelEnabled !== false;
    s.panelPos = ['br', 'bl', 'tr', 'tl'].indexOf(s.panelPos) >= 0 ? s.panelPos : 'tr';
    // 一次性迁移：早期默认位置是右下（v1）→ 左下（v2）→ 右上（v3，与返回顶部扩展错开）。
    // 迁移后写入 posV=3，用户之后在设置页显式选择的位置会被尊重
    if (!(raw && raw.posV >= 3) && (s.panelPos === 'br' || s.panelPos === 'bl')) s.panelPos = 'tr';
    s.posV = 3;
    s.panelWidth = clampInt(s.panelWidth, 260, 460, 306);
    s.panelTheme = ['auto', 'light', 'dark'].indexOf(s.panelTheme) >= 0 ? s.panelTheme : 'auto';
    s.listLimit = clampInt(s.listLimit, 10, 200, 60);
    s.sortBy = ['activity', 'post', 'reply', 'fans'].indexOf(s.sortBy) >= 0 ? s.sortBy : 'activity';
    s.autoSync = s.autoSync !== false;
    s.autoGap = clampInt(s.autoGap, 2000, 60000, 5000);
    s.autoParallel = clampInt(s.autoParallel, 1, 5, 3);
    s.autoTTL = clampInt(s.autoTTL, 2, 720, 15);
    s.autoMax = clampInt(s.autoMax, 0, 500, 60);
    s.selfHandle = String(s.selfHandle || '').replace(/^@+/, '').trim().toLowerCase();
    s.relEnabled = s.relEnabled !== false;
    s.relPos = ['avatar', 'name'].indexOf(s.relPos) >= 0 ? s.relPos : 'name';
    const hex = (v, def) => (/^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v) : def);
    const baseItems = (raw && raw.relItems && typeof raw.relItems === 'object') ? raw.relItems : {};
    const items = {};
    ['mutual', 'nofb', 'followme', 'none', 'self'].forEach((k) => {
      const it = baseItems[k] || {};
      items[k] = {
        on: it.on !== false,
        color: hex(it.color, DEFAULTS.relItems[k].color)
      };
    });
    s.relItems = items;
    s.showHeat = s.showHeat !== false;
    s.hideAds = !!s.hideAds;
    s.showNotes = s.showNotes !== false;
    s.collectMedia = s.collectMedia !== false;
    // 媒体备份
    s.bkFab = s.bkFab !== false;
    s.bkBtn = s.bkBtn !== false;
    s.bkFolder = sanitizeFolder(s.bkFolder);
    s.bkByUser = s.bkByUser !== false;
    s.bkPattern = String(s.bkPattern || '{account}_{tweetid}_{serial}').slice(0, 120);
    s.bkZip = !!s.bkZip;
    s.bkThumb = !!s.bkThumb;
    s.bkSkipDl = s.bkSkipDl !== false;
    s.bkConcurrent = clampInt(s.bkConcurrent, 1, 5, 2);
    s.bkDelay = clampInt(s.bkDelay, 100, 10000, 600);
    s.bkCsv = s.bkCsv !== false;
    s.bkNsfw = !!s.bkNsfw;
    s.bkScrollMin = clampInt(s.bkScrollMin, 300, 10000, 900);
    s.bkScrollMax = clampInt(s.bkScrollMax, 400, 20000, 1800);
    if (s.bkScrollMax < s.bkScrollMin) s.bkScrollMax = s.bkScrollMin;
    s.debug = !!s.debug;
    return s;
  }

  const api = {
    SET_KEY: KEY,
    DEFAULTS: DEFAULTS,
    normSettings: normSettings,

    getSettings: function (cb) {
      try {
        chrome.storage.local.get([KEY], function (res) {
          cb(normSettings(res && res[KEY]));
        });
      } catch (e) {
        cb(normSettings(null));
      }
    },

    saveSettings: function (patch, cb) {
      try {
        chrome.storage.local.get([KEY], function (res) {
          let p = patch || {};
          const cur = normSettings(res && res[KEY]);
          // relItems 深合并：设置页传部分字段（如 {mutual:{color}}）时不能覆盖整组
          if (p.relItems && typeof p.relItems === 'object') {
            const merged = Object.assign({}, cur.relItems);
            for (const k in p.relItems) {
              merged[k] = Object.assign({}, cur.relItems[k] || { on: true }, p.relItems[k]);
            }
            p = Object.assign({}, p, { relItems: merged });
          }
          const next = normSettings(Object.assign({}, cur, p));
          chrome.storage.local.set({ [KEY]: next }, function () {
            if (cb) cb(next);
          });
        });
      } catch (e) {
        if (cb) cb(normSettings(patch));
      }
    },

    onSettings: function (fn) {
      try {
        chrome.storage.onChanged.addListener(function (changes, area) {
          if (area === 'local' && changes[KEY]) fn(normSettings(changes[KEY].newValue));
        });
      } catch (e) {}
    }
  };

  window.XAM = window.XAM || {};
  window.XAM.settings = api;
})();
