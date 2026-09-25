/* 123云盘移动端 SPA 逻辑
 * 通过 NativeBridge 调用原生网络层（复刻 123pan-open API）
 * 底部导航：文件 / 传输 / 我的
 */
(function () {
  'use strict';

  // ===== 兼容性补丁（兼容 Android 8 等旧 WebView，避免冷启动白屏）=====
  // 老旧系统 WebView 可能缺失下述 ES6+/DOM 方法，这里用 ES5 安全补齐。
  // 缺失任一都会导致 app.js 初始化中途抛错，页面不渲染而成白屏。
  (function () {
    // 1) NodeList.forEach：代码在多处依赖（如 querySelectorAll(...).forEach）
    try {
      if (window.NodeList && !NodeList.prototype.forEach) {
        NodeList.prototype.forEach = Array.prototype.forEach;
      }
    } catch (e) {}
    // 2) Array.prototype.includes
    try {
      if (!Array.prototype.includes) {
        Array.prototype.includes = function (v) {
          for (var i = 0; i < this.length; i++) { if (this[i] === v) return true; }
          return false;
        };
      }
    } catch (e) {}
    // 3) String.prototype.includes / startsWith / endsWith / trim
    try {
      if (!String.prototype.includes) {
        String.prototype.includes = function (s, pos) {
          return this.indexOf(s, pos || 0) !== -1;
        };
      }
      if (!String.prototype.startsWith) {
        String.prototype.startsWith = function (s, pos) {
          return this.slice(pos || 0, (pos || 0) + s.length) === s;
        };
      }
      if (!String.prototype.endsWith) {
        String.prototype.endsWith = function (s) {
          return this.indexOf(s, this.length - s.length) !== -1;
        };
      }
      if (!String.prototype.trim) {
        String.prototype.trim = function () { return this.replace(/^\s+|\s+$/g, ''); };
      }
    } catch (e) {}
    // 4) Element.prototype.closest
    try {
      if (window.Element && !Element.prototype.closest) {
        Element.prototype.closest = function (sel) {
          var el = this;
          while (el && el !== document) {
            if (el.matches && el.matches(sel)) return el;
            el = el.parentElement;
          }
          return null;
        };
      }
    } catch (e) {}
    // 5) Object.entries / Object.values
    try {
      if (!Object.entries) {
        Object.entries = function (o) {
          var out = [], k;
          for (k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) out.push([k, o[k]]); }
          return out;
        };
      }
      if (!Object.values) {
        Object.values = function (o) {
          var out = [], k;
          for (k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) out.push(o[k]); }
          return out;
        };
      }
    } catch (e) {}
    // 6) Array.prototype.find（若用到）
    try {
      if (!Array.prototype.find) {
        Array.prototype.find = function (fn) {
          for (var i = 0; i < this.length; i++) { if (fn(this[i], i, this)) return this[i]; }
          return undefined;
        };
      }
    } catch (e) {}
  })();

  var bridge = window.NativeBridge;
  var _currentList = [];   // 当前文件列表项（多选 toggle 时按 FileId 精准刷新用）
  // 排序偏好（localStorage 持久化；默认按 file_id 倒序，与旧行为一致）
  var _sortPref = null;
  try { _sortPref = JSON.parse(localStorage.getItem('pan_sort') || 'null'); } catch (e) { _sortPref = null; }
  var state = {
    token: '',
    user: '',
    view: 'files',
    currentDir: 0,          // 当前文件夹 parentFileId（0 = 根目录）
    breadcrumb: [],          // [{id, name}]
    currentItem: null,        // 操作浮层对应的文件对象
    shareItem: null,          // 正在配置分享的文件对象
    confirmOk: null,          // 自定义确认弹窗的确定回调
    qrTimer: null,            // 二维码轮询定时器
    qrUniID: '',              // 当前二维码的 uniID
    qrTimeout: null,          // 二维码过期定时器
    qrPaused: false,          // App 在后台时 true，暂停轮询
    qrExpired: false,          // 二维码是否已过期
    transfers: loadTransfers(), // 下载任务列表 [{name,size,status,time}]
    upQueue: loadUpQueue(),       // 上传任务队列（串行调度 [{name,path,status,done,total}]）
    transferTab: (function () { try { return localStorage.getItem('pan_ttab') === 'upload' ? 'upload' : 'download'; } catch (e) { return 'download'; } })(), // 传输页子页签：download/upload
    autoUpdate: (function () { try { return localStorage.getItem('pan_autoupdate') !== '0'; } catch (e) { return true; } })(), //自动更新开关（默认开启）
    themeMode: (function () { try { return localStorage.getItem('pan_theme') || 'auto'; } catch (e) { return 'auto'; } })(), // 主题：auto/light/dark
    keepScreenOn: (function () { try { return localStorage.getItem('pan_keep_screen') === '1'; } catch (e) { return false; } })(), //屏幕常亮开关（默认关闭）
    transferKeepWake: false, // 传输进行中强制保持屏幕常亮
    updateInfo: null, //待下载的新版本信息 {version, url}
    progTimer: null,          // 下载进度轮询定时器
    searching: false,         // 是否处于全局搜索态
    searchKeyword: '',        // 当前搜索关键词
    searchTotal: 0,           // 搜索命中总数
    selectMode: false,        // 是否处于多选（整理）模式
    selectedMap: {},          // 多选模式下选中的文件/文件夹 fileId -> item
    pickerState: null,        // 文件夹选择器状态 {dir, path:[{id,name}]}
    dupGroups: [],            // 查重结果：重复文件分组 [{key,label,items:[...]}]
    dupSelected: {},         // 查重结果中选中的 fileId -> item
    dupScanning: false,      // 是否正在全盘扫描
    dupScanned: 0,           // 已扫描文件数
    orderBy: (_sortPref && _sortPref.by) || 'file_id',       // 列表排序字段（file_name/file_size/updated_at/file_id）
    orderDirection: (_sortPref && _sortPref.dir) || 'desc',  // 排序方向 asc/desc
    viewMode: (function () { try { return localStorage.getItem('pan_view') || 'list'; } catch (e) { return 'list'; } })(),
  };

  var API = {
    list: 'https://api.123pan.cn/b/api/file/list/new',
    rename: 'https://api.123pan.cn/a/api/file/rename',
    trash: 'https://api.123pan.cn/a/api/file/trash',      // 移入回收站 / 从回收站恢复
    trashDeleteAll: 'https://api.123pan.cn/a/api/file/trash_delete_all', // 清空回收站
    trashDelete: 'https://api.123pan.cn/a/api/file/delete', // 从回收站彻底删除单个
    download: 'https://api.123pan.cn/a/api/file/download_info',      // 文件
    batchDownload: 'https://api.123pan.cn/a/api/file/batch_download_info', // 文件夹
    mkdir: 'https://api.123pan.cn/b/api/file/upload_request',        // 新建文件夹（123pan 用 upload_request 创建文件夹；注意必须是 /b/ 前缀，/a/ 下无此路由会 404）
    userInfo: 'https://api.123pan.cn/b/api/user/info',
    shareCreate: 'https://api.123pan.cn/a/api/share/create',          // 创建分享（123pan 原生分享）
    move: 'https://api.123pan.cn/b/api/file/mod_pid',                // 移动文件/文件夹到指定目录
    signIn: 'https://login.123pan.com/b/api/user/sign_in',
    qrGenerate: 'https://login.123pan.com/api/user/qr-code/generate',
    qrResult: 'https://login.123pan.com/api/user/qr-code/result',
    // 验证码（短信）登录接口（走 user.123pan.cn 域）
    getVcode: 'https://user.123pan.cn/api/user/get_vcode',      // 获取短信验证码
    vcodeSignIn: 'https://user.123pan.cn/api/user/sign_in'      // 验证码登录（type:3）
  };
  // 回收站操作 event 值（统一走 POST /a/api/file/trash，通过 event 区分）
  var RECYCLE_EVENT = {
    restore: 'recycleRestore', // 从回收站恢复
    clear: 'recycleClear',     // 清空回收站
    deleteP: 'recycleDelete'   // 从回收站彻底删除
  };

  // ---------- 工具 ----------
  function $(id) { return document.getElementById(id); }
  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '"');
  }
  function fmtSize(b) {
    if (b == null) return '';
    b = Number(b);
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  // 从对象中按候选字段名顺序取第一个有效数值（转为非负整数，取不到返回 0）
  function numOf(obj) {
    for (var i = 1; i < arguments.length; i++) {
      var v = obj && obj[arguments[i]];
      if (v != null) {
        var n = Number(v);
        if (!isNaN(n) && n > 0) return n;
      }
    }
    return 0;
  }
  function iconFor(item) {
    if (item && (item.Type === 1 || item.Type === '1')) return 'folder';
    return iconForName(item && (item.FileName || item.fileName));
  }
  // 根据文件名扩展名判断文件类型图标（传输列表也复用此逻辑）
  function iconForName(fname) {
    var ext = (fname || '').split('.').pop().toLowerCase();
    var img = { jpg:1, jpeg:1, png:1, gif:1, webp:1, bmp:1, heic:1 };
    var vid = { mp4:1, mkv:1, avi:1, mov:1, rmvb:1, flv:1, wmv:1, webm:1, ts:1 };
    var aud = { mp3:1, wav:1, flac:1, aac:1, ogg:1, m4a:1, ape:1 };
    var arc = { zip:1, rar:1, '7z':1, tar:1, gz:1, bz2:1, xz:1, iso:1, apk:0 };
    var tab = { xls:1, xlsx:1, ppt:1, pptx:1, doc:1, docx:1, pdf:1 };
    if (img[ext]) return 'image';
    if (vid[ext]) return 'video';
    if (aud[ext]) return 'audio';
    if (ext === 'apk') return 'apk';
    if (arc[ext]) return 'archive';
    if (tab[ext]) return 'table';
    if (ext === 'txt') return 'text';
    if (ext === 'js' || ext === 'json' || ext === 'html' || ext === 'css' || ext === 'java' || ext === 'py' || ext === 'xml' || ext === 'sh') return 'code';
    return 'doc';
  }

  // 图标内联 SVG 内容映射（不依赖 <use> 引用外部 symbol，规避部分 WebView 无法渲染 use 图标的问题）
  var ICON_SVG = {
    upload: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M12 3v12M7 8l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'folder-plus': '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2zM12 11v6M9 14h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    'arrow-down': '<path d="M12 3v12M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    user: '<path d="M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    download: '<path d="M12 3v12M6 11l6 6 6-6M4 21h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    transfer: '<path d="M8.5 6v8.8M5.5 14.8L8.5 17.8l3-3M15.5 18v-8.8M12.5 9.2L15.5 6.2l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    rename: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6zM10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    hdd: '<path d="M3 13v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3M3 13l2.5-7A2 2 0 0 1 7.4 5h9.2a2 2 0 0 1 1.9 1.4L21 13M3 13h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 17h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
    info: '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 2v6h6M8 13h8M8 17h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="M21 15l-5-5L5 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    video: '<rect x="2" y="6" width="14" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 10l6-4v12l-6-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    audio: '<path d="M9 18V5l12-2v13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="16" r="3" fill="none" stroke="currentColor" stroke-width="2"/>',
    archive: '<path d="M21 8l-9-5-9 5 9 5 9-5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3 8v8l9 5 9-5V8M12 13v8" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    table: '<rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 9h18M3 15h18M9 3v18" fill="none" stroke="currentColor" stroke-width="2"/>',
    text: '<path d="M4 6V4h16v2M12 4v16M9 20h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    code: '<path d="M8 6l-6 6 6 6M16 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    apk: '<circle cx="5.5" cy="10.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.5" cy="10.5" r="1.5" fill="currentColor" stroke="none"/><path d="M6.5 7h11a4 4 0 0 1 4 4v4.5a3 3 0 0 1-3 3H5.5a3 3 0 0 1-3-3V11a4 4 0 0 1 4-4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M7.7 6V3.8M16.3 6V3.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    search: '<circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.3-4.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    'x-circle': '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 9l-6 6M9 9l6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    'folder-move': '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 13h6M11 10l-3 3 3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'chevron-up': '<path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'chevron-right': '<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    check: '<path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    sort: '<path d="M3 6h12M3 12h9M3 18h6M17 4v12M14 13l3 3 3-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'find-dup': '<rect x="3" y="3" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="9" y="9" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 3v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    broom: '<path d="M13.5 10.5L22 2m-7.266 11.841a2 2 0 0 0-.314-2.42L12.58 9.58a2 2 0 0 0-2.421-.314l-7.657 4.461A1 1 0 0 0 2.3 15.3l6.403 6.403a1 1 0 0 0 1.571-.204zM5 18l2-2m.699-5.3l5.602 5.601" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    sun: '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
  };
  function applySvg(el, name) {
    var inner = ICON_SVG[name];
    if (!inner) { el.innerHTML = ''; return; }
    el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + inner + '</svg>';
  }
  // 图标注入：直接写入内联 SVG（不依赖外部 symbol 引用），确保各类 WebView 都能渲染
  function injectIcons(root) {
    var scope = root || document;
    scope.querySelectorAll('[data-icon]').forEach(function (el) {
      var name = el.getAttribute('data-icon');
      applySvg(el, name);
    });
  }
  // 生成一个 icon 元素（用于动态创建的 DOM）
  function makeIcon(name, cls) {
    var s = document.createElement('span');
    if (cls) s.className = cls;
    s.setAttribute('data-icon', name);
    applySvg(s, name);
    return s;
  }

  // ---------- 原生桥调用 ----------
  function toast(msg) {
    if (bridge && bridge.toast) bridge.toast(String(msg));
  }
  function api(method, url, body, withAuth, cb) {
    var cbName = '_cb' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    window[cbName] = function (json) {
      var data;
      try { data = (typeof json === 'string') ? JSON.parse(json) : json; } catch (e) { data = { ok: false, error: '解析失败: ' + (e && e.message ? e.message : '') }; }
      delete window[cbName];
      cb(data);
    };
    bridge.apiRequest(cbName, method, url, body || '', !!withAuth);
  }
  function loadToken() { return bridge && bridge.loadToken ? bridge.loadToken() : ''; }

  // ---------- 页面切换 ----------
  function switchView(v) {
    // 离开文件页前保存滚动位置，回来后恢复
    if (state.view === 'files' && v !== 'files') {
      var sc = $('content');
      state.filesScrollTop = sc ? sc.scrollTop : 0;
    }
    state.view = v;
    ['files', 'transfers', 'recycle', 'mine'].forEach(function (k) {
      var sec = $('view-' + k);
      var tab = null;
      document.querySelectorAll('#tabbar .tab').forEach(function (t) {
        if (t.getAttribute('data-view') === k) tab = t;
      });
      if (sec) sec.classList.toggle('hidden', k !== v);
      if (tab) tab.classList.toggle('active', k === v);
    });
    // 离开文件视图时退出多选（整理）模式，避免状态残留
    if (v !== 'files' && state.selectMode) {
      state.selectMode = false;
      state.selectedMap = {};
      hide($('select-toolbar'));
      var ft = $('file-toolbar');
      if (ft && ft.classList.contains('hidden')) show(ft);
    }
    if (v === 'mine') loadMine();
    if (v === 'recycle') loadRecycle();
    if (v === 'transfers') { renderTransfers(); startProgressPolling(); }
    else { stopProgressPolling(); }
    if (v === 'files' && !$('file-list').dataset.loaded) loadList();
    // 恢复文件列表滚动位置
    var sc2 = $('content');
    if (sc2 && state.filesScrollTop) {
      var target = state.filesScrollTop;
      requestAnimationFrame(function () { sc2.scrollTop = target; });
    }
  }

  // ---------- 下载任务（传输列表） ----------
  function loadTransfers() {
    try {
      var raw = localStorage.getItem('pan_transfers');
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveTransfers() {
    try { localStorage.setItem('pan_transfers', JSON.stringify(state.transfers)); } catch (e) {}
  }
  // ---------- 上传队列（串行调度 / 取消 / 重试） ----------
  function loadUpQueue() {
    try {
      var raw = localStorage.getItem('pan_upqueue');
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      // 应用重启后原生上传任务已不存在：未完成的挂起任务标记为失败，避免永远“等待上传”
      for (var i = 0; i < arr.length; i++) {
        var t = arr[i];
        if (t && (t.status === 'waiting' || t.status === 'uploading')) {
          t.status = 'failed';
          t.failMsg = '任务已失效（应用重启）';
        }
      }
      return arr;
    } catch (e) { return []; }
  }
  function saveUpQueue() {
    try { localStorage.setItem('pan_upqueue', JSON.stringify(state.upQueue)); } catch (e) {}
  }
  // 上传入队（原生文件选择回调 / 后续文件夹批量上传都经此入口）
  function enqueueUpload(path) {
    if (!state.upQueue) state.upQueue = [];
    var name = String(path).split('/').pop() || ('file_' + Date.now());
    state.upQueue.push({ id: -1, name: name, path: path, parentId: state.currentDir, size: 0, done: 0, total: 0, status: 'waiting', failMsg: '', time: Date.now() });
    saveUpQueue();
    toast('已加入上传队列：' + name);
    scheduleNextUpload();
  }
  // 串行调度：同一时刻仅执行一个上传任务
  function scheduleNextUpload() {
    var q = state.upQueue || [];
    var i;
    for (i = 0; i < q.length; i++) { if (q[i].status === 'uploading') return; }
    for (i = 0; i < q.length; i++) {
      if (q[i].status === 'waiting') { startUploadItem(q[i]); return; }
    }
    hideUploadProgress();
    if (state.view === 'transfers') renderTransfers();
  }
  function startUploadItem(t) {
    if (!(bridge && bridge.uploadFileTask)) {
      t.status = 'failed';
      t.failMsg = '上传通道未就绪';
      saveUpQueue();
      if (state.view === 'transfers') renderTransfers();
      return;
    }
    t.status = 'uploading';
    t.done = 0;
    t.failMsg = '';
    t._resumeToasted = false;
    t._lastPct = -1;
    saveUpQueue();
    if (state.view === 'transfers') renderTransfers();
    showUploadProgress(t.name, 0, 0);
    var nid = -1;
    try { nid = Number(bridge.uploadFileTask(t.path, Number(t.parentId) || 0)); } catch (e) {}
    if (nid >= 0) { t.id = nid; saveUpQueue(); }
    else {
      t.status = 'failed';
      t.failMsg = '上传启动失败';
      saveUpQueue();
      if (state.view === 'transfers') renderTransfers();
      scheduleNextUpload();
    }
  }
  function cancelUploadItem(t) {
    if (!t) return;
    var wasUploading = (t.status === 'uploading');
    if (wasUploading && Number(t.id) >= 0 && bridge && bridge.cancelUploadTask) {
      try { bridge.cancelUploadTask(Number(t.id)); } catch (e) {}
    }
    t.status = 'cancelled';
    t.failMsg = '';
    saveUpQueue();
    if (state.view === 'transfers') renderTransfers();
    toast('已取消上传：' + (t.name || ''));
    // 等待中的任务没有原生线程，取消后立即调度下一个；上传中则等原生回调后再调度
    if (!wasUploading) scheduleNextUpload();
  }
  function retryUploadItem(t) {
    if (!t) return;
    t.status = 'waiting';
    t.done = 0;
    t.failMsg = '';
    t._resumeToasted = false;
    t._lastPct = -1;
    saveUpQueue();
    if (state.view === 'transfers') renderTransfers();
    scheduleNextUpload();
  }
  function statusUpLabel(t) {
    var tot = Number(t.total) || 0;
    var p = tot > 0 ? Math.floor((Number(t.done) || 0) * 100 / tot) : -1;
    return p >= 0 ? '上传中 ' + p + '%' : '上传中';
  }
  function addTransfer(t) {
    if (!state.transfers) state.transfers = [];
    state.transfers.unshift({ id: t.id || -1, name: t.name || '', size: t.size, status: t.status || 'downloading', done: 0, total: t.total || 0, stream: !!t.stream, link: t.link || '', stale: false, failMsg: '', time: Date.now() });
    saveTransfers();
  }
  // st: 1=下载中 2=暂停 8=成功 16=失败
  function statusLabel(st, done, total) {
    st = Number(st);
    if (st === 8) return '已完成';
    if (st === 16) return '失败';
    // 已完成 / 失败之外：按状态显示进度百分比（2=暂停，1=下载中）
    var tot = Number(total);
    var p = tot > 0 ? Math.floor((Number(done) || 0) / tot * 100) : -1;
    if (p > 100) p = 100;
    if (st === 2) return (p >= 0 ? '已暂停 ' + p + '%' : '已暂停');
    return (p >= 0 ? '下载中 ' + p + '%' : '下载中');
  }
  function startProgressPolling() {
    if (state.progTimer) return;
    pollDownloadProgress();
    state.progTimer = setInterval(pollDownloadProgress, 2000);
  }
  function stopProgressPolling() {
    if (state.progTimer) { clearInterval(state.progTimer); state.progTimer = null; }
  }
  // 轮询下载进度：同时支持 DownloadManager 任务与自研流式任务（stream）。
  // 关键修复：不再无条件把 status===8 当作"完成"——对 DownloadManager 任务，
  // 若状态为成功但实际字节数 < total，视为"下载中/异常"而非完成，避免"未下完就显示完成"。
  function pollDownloadProgress() {
    if (!(bridge && bridge.queryDownloads)) return;
    try {
      var list = JSON.parse(bridge.queryDownloads() || '[]');
      // 自研流式任务列表（id >= 900000000）
      var slist = [];
      if (bridge.streamingTasks) {
        try { slist = JSON.parse(bridge.streamingTasks() || '[]'); } catch (e) {}
      }
      var slistOk = Array.isArray(slist);
      var hasPending = false;
      (state.transfers || []).forEach(function (t) {
        if (t.stream && Number(t.id) >= 900000000 && (t.status === 'downloading' || t.status === 'paused')) hasPending = true;
      });
      if ((!Array.isArray(list) || !list.length) && (!slistOk || !slist.length) && !hasPending) return;
      if (!state.transfers) return;
      var nameToStatus = {};
      (list).forEach(function (dl) { nameToStatus[dl.name] = dl; });
      var changed = false;
      state.transfers.forEach(function (t) {
        var hit = null;
        // 自研流式任务优先按 id 匹配 streaming 列表
        if (t.stream && slistOk && slist.length) {
          slist.forEach(function (x) { if (Number(x.id) === Number(t.id)) hit = x; });
        }
        if (!hit && t.id >= 0 && list.length) {
          list.forEach(function (x) { if (Number(x.id) === Number(t.id)) hit = x; });
        }
        if (!hit && t.name) hit = nameToStatus[t.name] || null;
        if (!hit) {
          // 流式任务在原生侧已不存在（应用重启 / 任务被清理）：标记失效，避免永远停留在“下载中”
          if (t.stream && Number(t.id) >= 900000000 && slistOk && (t.status === 'downloading' || t.status === 'paused')) {
            t.status = 'failed';
            t.stale = true;
            t.failMsg = '任务已失效';
            changed = true;
          }
          return;
        }
        if (hit) {
          if (t.status === 'completed') return;
          var st = Number(hit.status);
          var done = Number(hit.done) || 0;
          var total = Number(hit.total) || 0;
          // 用请求时记录的期望大小兜底（stream 任务的 total 以后端为准，避免被 0 覆盖）
          var expect = Number(t.total) || Number(t.size) || 0;
          t.done = done;
          t.total = total;
          if (st === 8) {
            if (t.stream) {
              // 流式任务：必须实际大小>0 且 done>=期望大小才标记完成，杜绝"未下完显完成"
              // 期望大小取后端返回的 total；若后端未知则用前端 fsize 兜底；再未知则保守不完成
              var ref = (total > 0 ? total : expect);
              if (ref > 0 && done >= ref) { t.status = 'completed'; }
              else { t.status = 'downloading'; } // 字节不足或大小未知 -> 仍视为下载中
            } else {
              // DownloadManager 任务：严格用实际 done>=total 才完成，未知大小不判完成
              if (total > 0 && done >= total) { t.status = 'completed'; }
              else { t.status = 'downloading'; }
            }
          }
          else if (st === 16) { t.status = 'failed'; }
          else if (st === 2 && t.stream) { t.status = 'paused'; }
          else { t.status = 'downloading'; }
          if (t.stale) { t.stale = false; t.failMsg = ''; }
          changed = true;
        }
      });
      if (changed) {
        saveTransfers();
        if (state.view === 'transfers') renderTransfers();
      }
    } catch (e) { /* 忽略轮询解析错误 */ }
  }

  // 离线下载：先解析资源，再提交
  function doOfflineDownload() {
    var url = ($('offline-url').value || '').trim();
    if (!url) { toast('请输入链接'); return; }
    var out = $('offline-result');
    out.textContent = '正在解析...';
    api('POST', 'https://api.123278.com/b/api/v2/offline_download/task/resolve',
      JSON.stringify({ urls: url }), true, function (d) {
        if (!d || (d.code !== 0 && d.Code !== 0)) {
          out.textContent = '解析失败：' + JSON.stringify(d).slice(0, 300);
          return;
        }
        var data = d.data || d.Data || {};
        // 返回结构可能是 data.list[0]，里面含 resource_id / url / name
        var list = data.list || data.List || [];
        var first = list[0] || {};
        // err_code: 0=成功, 非0=解析失败
        if (first.err_code && first.err_code !== 0) {
          out.textContent = '磁力链接解析失败（err_code=' + first.err_code + '），请确认磁力链接有效且 tracker 可达。\n原始返回：' + JSON.stringify(data).slice(0, 200);
          return;
        }
        var rid = first.id || first.ID || first.resource_id || 0;
        if (!rid) {
          out.textContent = '解析返回：' + JSON.stringify(data).slice(0, 300);
          return;
        }
        out.textContent = '已解析：' + (list[0] && list[0].name) + '（' + (list[0] && list[0].size) + ' 字节），正在提交...';
        var selFiles = (list[0] && list[0].files && list[0].files.map(function (f) { return f.id || f.ID; })) || [];
        api('POST', 'https://api.123278.com/b/api/v2/offline_download/task/submit',
          JSON.stringify({ resource_list: [{ resource_id: rid, select_file_id: selFiles }] }), true, function (d2) {
            if (d2 && (d2.code === 0 || d2.Code === 0)) {
              out.textContent = '✅ 离线下载已提交，文件稍后出现在网盘根目录（如未出现请到官方App查看离线任务列表）';
              $('offline-url').value = '';
            } else {
              out.textContent = '提交失败：' + ((d2 && d2.message) || JSON.stringify(d2).slice(0, 300));
            }
          });
      });
  }

  function renderTransfers() {
    var box = $('transfer-list');
    var empty = $('transfer-empty');
    if (!box) return;
    // 离线下载页：显示表单
    if (state.transferTab === 'offline') {
      if (tbD) tbD.classList.remove('active');
      if (tbU) tbU.classList.remove('active');
      var tbo = $('ttab-offline');
      if (tbo) tbo.classList.add('active');
      if (empty) hide(empty);
      box.innerHTML = '<div style="padding:16px;">'
        + '<div style="font-size:13px;color:var(--fg3,#999);margin-bottom:8px;">输入磁力链接或 HTTP(S) 直链，提交后云端离线下载到你的网盘</div>'
        + '<textarea id="offline-url" placeholder="magnet:?xt=... 或 https://..." style="width:100%;height:90px;border:1px solid var(--divider,#ddd);border-radius:8px;padding:10px;box-sizing:border-box;font-size:14px;background:var(--card,#fff);color:var(--fg,#333);resize:vertical;"></textarea>'
        + '<button id="offline-go" style="margin-top:12px;width:100%;padding:12px;border:none;border-radius:8px;background:var(--accent,#2563eb);color:#fff;font-size:15px;">提交离线下载</button>'
        + '<div id="offline-result" style="margin-top:12px;font-size:13px;color:var(--fg2,#666);line-height:1.6;"></div>'
        + '</div>';
      $('offline-go').addEventListener('click', doOfflineDownload);
      return;
    }
    var arr = state.transfers || loadTransfers();
    state.transfers = arr;
    var ups = state.upQueue || loadUpQueue();
    state.upQueue = ups;
    var tab = state.transferTab === 'upload' ? 'upload' : 'download';
    var list = (tab === 'upload') ? ups : arr;
    // 同步子页签高亮
    var tbD = $('ttab-download'), tbU = $('ttab-upload');
    if (tbD) tbD.classList.toggle('active', tab !== 'upload');
    if (tbU) tbU.classList.toggle('active', tab === 'upload');
    // 空态文案随子页签变化
    var et = $('transfer-empty-title');
    if (et) et.textContent = tab === 'upload' ? '暂无上传任务' : '暂无下载任务';
    var es = $('transfer-empty-sub');
    if (es) es.textContent = tab === 'upload' ? '上传任务将在此实时显示' : '下载文件保存在系统下载目录';
    if (!list.length) {
      if (empty) show(empty);
      box.innerHTML = '';
      return;
    }
    if (empty) hide(empty);
    var html = '';
    // 上传任务（队列）
    for (var u = 0; tab === 'upload' && u < ups.length; u++) {
      var ut = ups[u];
      var unm = ut.name || '';
      var uicName = iconForName(unm);
      var usz = fmtSize(ut.total || ut.size);
      var ubtn = '';
      var ulabel;
      if (ut.status === 'waiting') ulabel = '等待上传';
      else if (ut.status === 'uploading') ulabel = statusUpLabel(ut);
      else if (ut.status === 'done') ulabel = '已完成';
      else if (ut.status === 'cancelled') ulabel = '已取消';
      else ulabel = ut.failMsg || '上传失败';
      if (ut.status === 'waiting' || ut.status === 'uploading') {
        ubtn = '<button class="transfer-act t-upcancel" data-u="' + u + '">取消</button>';
      } else if (ut.status === 'failed' || ut.status === 'cancelled') {
        ubtn = '<button class="transfer-act t-upretry" data-u="' + u + '">重试</button>';
      }
      html += '<div class="transfer-item">'
        + '<div class="transfer-ic ic-' + uicName + '" data-icon="' + uicName + '"></div>'
        + '<div class="transfer-info"><div class="transfer-name">' + esc(unm) + '</div>'
        + '<div class="transfer-sub">' + esc(usz) + ' · ' + esc(ulabel) + '</div></div>'
        + ubtn + '<button class="up-del" data-u="' + u + '" title="移除记录">×</button>'
        + '</div>';
    }
    for (var i = 0; tab !== 'upload' && i < arr.length; i++) {
      var t = arr[i];
      var nm = t.name || '';
      var sz = fmtSize(t.size);
      var label = t.status === 'downloading'
        ? statusLabel(1, t.done, t.total)
        : (t.status === 'completed' ? '已完成'
        : (t.status === 'failed' ? (t.failMsg || '失败')
        : (t.status === 'paused' ? statusLabel(2, t.done, t.total) : mapStatusText(t.status))));
      var doneOk = (t.status === 'completed');
      // 所有任务统一按文件类型显示徽章图标（下载中/已完成均显示）
      var icName = iconForName(nm);
      var icHtml = '<div class="transfer-ic ic-' + icName + '" data-icon="' + icName + '"></div>';
      // 主操作按钮：下载中→暂停 / 已暂停→继续 / 失败→重试 / 已完成→打开
      var mainBtn;
      if (doneOk) mainBtn = '<button class="transfer-open" data-i="' + i + '">打开</button>';
      else if (t.status === 'downloading') mainBtn = t.stream
        ? '<button class="transfer-act t-pause" data-i="' + i + '">暂停</button>'
        : '<button class="transfer-open disabled" data-i="' + i + '">打开</button>';
      else if (t.status === 'paused') mainBtn = '<button class="transfer-act t-resume" data-i="' + i + '">继续</button>';
      else if (t.status === 'failed') mainBtn = '<button class="transfer-act t-retry" data-i="' + i + '">重试</button>';
      else mainBtn = '<button class="transfer-open disabled" data-i="' + i + '">打开</button>';
      html += '<div class="transfer-item">'
        + icHtml
        + '<div class="transfer-info"><div class="transfer-name">' + esc(nm) + '</div>'
        + '<div class="transfer-sub">' + esc(sz) + ' · ' + esc(label) + '</div></div>'
        + mainBtn + '<button class="transfer-del" data-i="' + i + '" title="删除记录">×</button>'
        + '</div>';
    }
    box.innerHTML = html;
    // 注入动态生成的类型徽章图标（修复传输列表图标不显示）
    injectIcons(box);
    // 打开按钮：apk 走安装程序，其他走系统推荐打开方式
    box.querySelectorAll('.transfer-open').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = Number(btn.getAttribute('data-i'));
        var t = state.transfers[idx];
        if (!t) return;
        if (t.status !== 'completed') { toast('文件未下载完成，暂不能打开'); return; }
        if (bridge && bridge.openFile) { bridge.openFile(t.name); }
        else {
          var p = '/sdcard/Download/' + t.name;
          if (/\.apk$/i.test(t.name)) { bridge.openApk && bridge.openApk(p); }
        }
      });
    });
    // 暂停：原生任务在下一个数据块边界退出并保留断点（继续时可断点续传）
    box.querySelectorAll('.t-pause').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = Number(btn.getAttribute('data-i'));
        var t = state.transfers && state.transfers[idx];
        if (!t) return;
        if (bridge && bridge.pauseDownload && Number(t.id) >= 0) { try { bridge.pauseDownload(Number(t.id)); } catch (e) {} }
        t.status = 'paused';
        saveTransfers();
        renderTransfers();
        startProgressPolling();
        toast('已暂停下载（可继续断点续传）');
      });
    });
    // 继续：从断点处续传
    box.querySelectorAll('.t-resume').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = Number(btn.getAttribute('data-i'));
        var t = state.transfers && state.transfers[idx];
        if (!t) return;
        if (bridge && bridge.resumeDownload && Number(t.id) >= 0) { try { bridge.resumeDownload(Number(t.id)); } catch (e) {} }
        t.status = 'downloading';
        saveTransfers();
        renderTransfers();
        startProgressPolling();
        toast('继续下载中...');
      });
    });
    // 重试：原生任务仍在则从断点重试；任务已失效（应用重启等）时用记录的链接重新发起
    box.querySelectorAll('.t-retry').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = Number(btn.getAttribute('data-i'));
        var t = state.transfers && state.transfers[idx];
        if (!t) return;
        if (t.stale) {
          if (t.link && bridge && bridge.downloadStream) {
            var nid = -1;
            try { nid = Number(bridge.downloadStream(t.link, t.name, Number(t.size) || 0)); } catch (e) {}
            if (nid >= 0) {
              t.id = nid; t.stale = false; t.failMsg = ''; t.done = 0;
              t.total = Number(t.size) || 0; t.status = 'downloading';
              saveTransfers();
              renderTransfers();
              startProgressPolling();
              toast('已重新发起下载');
              return;
            }
          }
          toast('任务已失效，请重新下载该文件');
          return;
        }
        //系统下载任务（下载更新等）：原生不支持重试，直接按记录链接重新发起
        if (!t.stream && t.link && bridge && bridge.download) {
          var nid2 = -1;
          try { nid2 = Number(bridge.download(t.link, t.name)); } catch (e2) {}
          if (nid2 > 0) {
            t.id = nid2; t.done = 0; t.status = 'downloading'; t.failMsg = '';
            saveTransfers();
            renderTransfers();
            startProgressPolling();
            toast('已重新发起下载');
            return;
          }
        }
        if (bridge && bridge.retryDownload && Number(t.id) >= 0) { try { bridge.retryDownload(Number(t.id)); } catch (e) {} }
        t.status = 'downloading';
        saveTransfers();
        renderTransfers();
        startProgressPolling();
        toast('正在重试...');
      });
    });
    // 删除按钮：结束原生任务并从传输列表移除该条记录
    box.querySelectorAll('.transfer-del').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var idx = Number(btn.getAttribute('data-i'));
        var t = state.transfers && state.transfers[idx];
        if (!t) return;
        var isDone = (t.status === 'completed' || t.status === 'done' || Number(t.status) === 8 || Number(t.status) === 16);
        var delFile = function () {
          // 删除原生任务（会清理半成品）
          if (t.stream && Number(t.id) >= 900000000 && bridge && bridge.deleteDownloadTask) {
            try { bridge.deleteDownloadTask(Number(t.id)); } catch (e2) {}
          }
          state.transfers.splice(idx, 1);
          saveTransfers();
          renderTransfers();
          toast('已删除传输记录「' + (t.name || '') + '」');
        };
        // 已完成下载：询问是否同时删除磁盘文件
        if (isDone && t.name && bridge && bridge.deleteDownloadedFile) {
          var items = [
            { label: '仅删记录', cls: '', fn: function () { closeSheet(); delFile(); } },
            { label: '删记录和文件', cls: 'warn', fn: function () {
                closeSheet();
                try { bridge.deleteDownloadedFile(t.name); } catch (e3) {}
                delFile();
              } }
          ];
          $('sheet-title').textContent = t.name || '未命名';
          var grid = $('sheet-grid');
          grid.innerHTML = '';
          items.forEach(function (it) {
            var el = document.createElement('div');
            el.className = 'sheet-grid-item ' + it.cls;
            var ic = document.createElement('div'); ic.className = 'sgi-icon';
            ic.textContent = it.label;
            el.appendChild(ic);
            el.title = it.label;
            el.addEventListener('click', it.fn);
            grid.appendChild(el);
          });
          grid.style.gridTemplateColumns = 'repeat(2,1fr)';
          show($('action-sheet'));
          return;
        }
        delFile();
      });
    });
    // 上传任务：取消 / 重试 / 移除记录
    box.querySelectorAll('.t-upcancel').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = Number(btn.getAttribute('data-u'));
        var t = state.upQueue && state.upQueue[idx];
        if (!t) return;
        cancelUploadItem(t);
      });
    });
    box.querySelectorAll('.t-upretry').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = Number(btn.getAttribute('data-u'));
        var t = state.upQueue && state.upQueue[idx];
        if (!t) return;
        retryUploadItem(t);
      });
    });
    box.querySelectorAll('.up-del').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var idx = Number(btn.getAttribute('data-u'));
        var t = state.upQueue && state.upQueue[idx];
        if (!t) return;
        if (t.status === 'uploading') { toast('上传中，请先取消再移除'); return; }
        state.upQueue.splice(idx, 1);
        saveUpQueue();
        renderTransfers();
      });
    });
  }
  function mapStatusText(s) {
    return (s === 'completed') ? '已完成' : (s === 'failed' ? '失败' : String(s || '下载中'));
  }

  // ---------- 登录（统一采用官方 123 云盘登录页） ----------
  // App 未登录时，原生主 WebView 直接加载官方登录页（支持账号密码 / 手机验证码，含阿里云安全滑块），
  // 登录成功由原生捕获 sso-token 存会话，并自动切回本地 SPA 主界面（注入 __restoreSession 恢复态）。
  // 打开官方登录页（登录页兜底按钮）
  function openOfficialLogin() {
    var msg = $('official-login-msg');
    if (bridge && bridge.openOfficialLogin) {
      if (msg) msg.textContent = '正在打开官方登录页...';
      bridge.openOfficialLogin();
    } else if (msg) {
      msg.textContent = '当前环境不支持官方登录';
    }
  }
  // 原生在官方登录成功后回调（token 已由原生写入会话；本地 SPA 加载时 __restoreSession 自动恢复）
  window.__onOfficialLogin = function (token, username) {
    if (token && !state.token) {
      state.token = token;
      state.user = username || '';
      toast('登录成功');
      enterMain();
    }
  };

  function enterMain() {
    hide($('page-login'));
    show($('page-main'));
    switchView('files');
  }

  // App 切后台钩子（由原生 onPause 调用；已移除扫码登录，无需额外处理）
  window.__onAppPause = function () {};
  // App 回前台钩子（由原生 onResume 调用）
  window.__onAppResume = function () {};


  // ---------- 会话恢复 ----------
  // 登录成功后原生切回本地 SPA 并注入本函数恢复会话（此时记录账号到多账号列表）
  window.__restoreSession = function (token, user) {
    if (token) {
      state.token = token;
      state.user = user || '';
      // 记录到多账号列表（去重），便于后续切换/展示
      try { addAccount(state.user, state.token, ''); } catch (e) {}
      enterMain();
    }
  };

  // ---------- 文件列表 ----------
  function renderBreadcrumb() {
    var box = $('crumb-path');
    if (!box) box = $('breadcrumb');
    box.innerHTML = '';
    // 根目录隐藏去重按钮和分隔符，进入文件夹才显示
    var dupBtn = $('tool-dup');
    var dupSep = $('dup-sep');
    var showDup = (state.currentDir !== 0);
    if (dupBtn) dupBtn.style.display = showDup ? '' : 'none';
    if (dupSep) dupSep.style.display = showDup ? '' : 'none';
    var root = document.createElement('span');
    root.className = 'crumb' + (state.currentDir === 0 ? ' active' : '');
    root.textContent = '全部文件';
    root.addEventListener('click', function () {
      if (state.currentDir !== 0) { state.currentDir = 0; state.breadcrumb = []; loadList(); }
    });
    box.appendChild(root);
    state.breadcrumb.forEach(function (c, i) {
      var sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '›';
      var crumb = document.createElement('span');
      crumb.className = 'crumb' + (i === state.breadcrumb.length - 1 ? ' active' : '');
      crumb.textContent = c.name;
      crumb.addEventListener('click', function () {
        if (i < state.breadcrumb.length - 1) {
          state.breadcrumb = state.breadcrumb.slice(0, i + 1);
          state.currentDir = c.id;
          loadList();
        }
      });
      box.appendChild(sep);
      box.appendChild(crumb);
    });
  }

  // ---------- 排序 ----------
  function saveSortPref() {
    try { localStorage.setItem('pan_sort', JSON.stringify({ by: state.orderBy, dir: state.orderDirection })); } catch (e) {}
  }
  function refreshSortSheet() {
    document.querySelectorAll('#sort-fields .sort-row').forEach(function (row) {
      var by = row.getAttribute('data-by');
      row.classList.toggle('active', by === state.orderBy);
      row.querySelectorAll('.sort-btn').forEach(function (btn) {
        btn.classList.toggle('active', by === state.orderBy && btn.getAttribute('data-dir') === state.orderDirection);
      });
    });
    document.querySelectorAll('#view-mode .sd-btn').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-view') === (state.viewMode || 'list'));
    });
    var topSort = $('top-sort');
    if (topSort) {
      var labels = { created_at: '按创建时间', updated_at: '按修改时间', file_name: '按名称', file_size: '按大小' };
      topSort.title = (labels[state.orderBy] || '排序') + (state.orderDirection === 'asc' ? ' ↑' : ' ↓');
    }
  }
  function openSortSheet() {
    refreshSortSheet();
    show($('sort-sheet'));
  }
  function applySort() {
    saveSortPref();
    refreshSortSheet();
    hide($('sort-sheet'));
    if (state.searching && state.searchKeyword) { doSearch(state.searchKeyword); } else { loadList(); }
  }
  var _listNext = 0;
  var _listLoading = false;
  // 格式化时间为 YYYY-MM-DD HH:mm:ss
  function fmtTime(s) {
    if (!s) return '';
    if (typeof s === 'number') {
      var d = new Date(s * (s < 1e12 ? 1000 : 1));
      var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    // 已经是字符串，把 T 换成空格，去掉时区部分（+08:00/Z 等）
    return String(s).replace(/[T]/g, ' ').replace(/[+\-]\d{2}:\d{2}$/, '').replace(/Z$/, '');
  }
  // 从文件对象中提取时间字段（兼容不同字段名，按当前排序选择创建/修改时间）
  function pickTime(item) {
    if (!item) return '';
    var keys;
    if (state.orderBy === 'created_at') {
      keys = ['CreateAt', 'createAt', 'CreateTime', 'CreatedTime', 'createTime'];
    } else {
      keys = ['UpdateAt', 'updateAt', 'UpdateTime', 'UpdatedTime', 'updateTime', 'ModifyTime', 'ModifiedTime', 'ModTime', 'Time'];
    }
    for (var i = 0; i < keys.length; i++) {
      if (item[keys[i]]) return item[keys[i]];
    }
    return '';
  }
  function loadList() {
    renderBreadcrumb();
    var box = $('file-list');
    box.dataset.loaded = '1';
    box.innerHTML = '<div class="loading-dot">加载中...</div>';
    _listNext = 0;
    _currentList = [];
    loadListPage();
  }
  function loadListPage() {
    if (_listLoading) return;
    _listLoading = true;
    var box = $('file-list');
    var params = 'driveId=0&limit=200&next=' + _listNext + '&orderBy=' + state.orderBy + '&orderDirection=' + state.orderDirection
      + '&parentFileId=' + state.currentDir + '&trashed=false&Page=1&OnlyLookAbnormalFile=0';
    api('GET', API.list + '?' + params, '', true, function (d) {
      _listLoading = false;
      if (d && d.data && d.data.InfoList) {
        var list = d.data.InfoList;
        var next = d.data.Next || 0;
        _listNext = next;
        if (_currentList.length === 0) {
          box.innerHTML = '';
        }
        renderListAppend(list);
        if (next > 0 && list.length > 0) {
          var more = document.createElement('div');
          more.className = 'load-more';
          more.textContent = '上滑加载更多（剩余约 ' + (d.data.Total ? (d.data.Total - _currentList.length) : '?') + ' 项）';
          more.id = 'load-more-hint';
          box.appendChild(more);
        }
      } else if (_currentList.length === 0) {
        box.innerHTML = '<div class="panel-empty"><div class="panel-icon" data-icon="folder"></div><p>加载失败或需重新登录</p></div>';
        injectIcons(box);
      }
    });
  }
  // 滚动到底自动加载下一页
  function setupListScroll() {
    var box = $('file-list');
    if (!box || box._scrollBound) return;
    box._scrollBound = true;
    window.addEventListener('scroll', function () {
      if (state.view !== 'files') return;
      if (_listLoading || _listNext <= 0) return;
      if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 100) {
        var hint = $('load-more-hint');
        if (hint) hint.remove();
        loadListPage();
      }
    }, { passive: true });
  }

  function sortCurrentList() {
    var list = (_currentList || []).slice();
    list.sort(function (a, b) {
      var ad = (a.Type === 1) ? 0 : 1;
      var bd = (b.Type === 1) ? 0 : 1;
      if (ad !== bd) return ad - bd;
      var dir = (state.orderDirection === 'asc') ? 1 : -1;
      var va, vb;
      if (state.orderBy === 'file_size') {
        va = Number(a.Size || a.FileSize || a.size || 0);
        vb = Number(b.Size || b.FileSize || b.size || 0);
      } else if (state.orderBy === 'updated_at' || state.orderBy === 'created_at') {
        var f = state.orderBy === 'created_at' ? 'CreateAt' : 'UpdateAt';
        va = new Date(a[f] || a.CreateAt || a.UpdateAt || a.CreatedAt || '').getTime() || 0;
        vb = new Date(b[f] || b.CreateAt || b.UpdateAt || b.CreatedAt || '').getTime() || 0;
      } else {
        va = String(a.FileName || '').toLowerCase();
        vb = String(b.FileName || '').toLowerCase();
        return dir * va.localeCompare(vb, 'zh');
      }
      return dir * (va - vb);
    });
    _currentList = list;
  }
  function renderListAppend(list) {
    var box = $('file-list');
    if (!list || !list.length) return;
    var isSelect = state.selectMode;
    var ckIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    list.forEach(function (item) {
      _currentList.push(item);
    });
    // 排序后整体重渲染
    sortCurrentList();
    box.innerHTML = '';
    _currentList.forEach(function (item) {
      var isSel = !!state.selectedMap[item.FileId];
      var card = document.createElement('div');
      card.className = 'file-card' + (isSel ? ' selected' : '');
      card.setAttribute('data-fid', item.FileId);
      if (isSelect) {
        var ck = document.createElement('div');
        ck.className = 'file-check' + (isSel ? ' checked' : '');
        if (isSel) ck.innerHTML = ckIcon;
        card.appendChild(ck);
      }
      var iconWrap = document.createElement('div');
      iconWrap.className = 'file-icon-wrap fi-' + iconFor(item);
      iconWrap.appendChild(makeIcon(iconFor(item), 'file-icon'));
      var body = document.createElement('div'); body.className = 'file-body';
      var name = document.createElement('div'); name.className = 'file-name'; name.textContent = item.FileName || '未命名';
      var meta = document.createElement('div'); meta.className = 'file-meta';
      meta.textContent = item.Type === 1
        ? fmtTime(pickTime(item))
        : (fmtTime(pickTime(item)) + ' · ' + fmtSize(item.Size));
      body.appendChild(name); body.appendChild(meta);
      card.appendChild(iconWrap); card.appendChild(body);
      card.addEventListener('click', function (e) {
        if (state.selectMode) { toggleSelect(item); }
        else if (item.Type === 1) { openDir(item); }
        else { openActionSheet(item); }
      });
      card.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        if (!state.selectMode) openActionSheet(item);
      });
      box.appendChild(card);
    });
    if (isSelect) refreshSelectBar();
  }

  function renderList(list, total) {
    var box = $('file-list');
    // 文件夹始终排在文件前面，然后按用户选择的排序字段二次排序
    list = (list || []).slice().sort(function (a, b) {
      var ad = (a.Type === 1) ? 0 : 1;
      var bd = (b.Type === 1) ? 0 : 1;
      if (ad !== bd) return ad - bd;
      var dir = (state.orderDirection === 'asc') ? 1 : -1;
      var va, vb;
      if (state.orderBy === 'file_size') {
        va = Number(a.Size || a.FileSize || a.size || 0);
        vb = Number(b.Size || b.FileSize || b.size || 0);
      } else if (state.orderBy === 'updated_at' || state.orderBy === 'created_at') {
        var f2 = state.orderBy === 'created_at' ? 'CreateAt' : 'UpdateAt';
        va = new Date(a[f2] || a.CreateAt || a.UpdateAt || '').getTime() || 0;
        vb = new Date(b[f2] || b.CreateAt || b.UpdateAt || '').getTime() || 0;
      } else {
        va = String(a.FileName || '').toLowerCase();
        vb = String(b.FileName || '').toLowerCase();
        return dir * va.localeCompare(vb, 'zh');
      }
      return dir * (va - vb);
    });
    _currentList = list;
    box.innerHTML = '';
    if (!list || !list.length) {
      box.innerHTML = '<div class="panel-empty"><div class="panel-icon" data-icon="folder"></div><p>此目录为空</p></div>';
      injectIcons(box);
      return;
    }
    var isSelect = state.selectMode;
    var ckIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    list.forEach(function (item) {
      var isSel = !!state.selectedMap[item.FileId];
      var card = document.createElement('div');
      card.className = 'file-card' + (isSel ? ' selected' : '');
      card.setAttribute('data-fid', item.FileId);
      // 多选模式：卡片左侧显示复选框
      if (isSelect) {
        var ck = document.createElement('div');
        ck.className = 'file-check' + (isSel ? ' checked' : '');
        if (isSel) ck.innerHTML = ckIcon;
        card.appendChild(ck);
      }
      // 图标区（40px 圆角色块，按类型着色更形象）
      var iconWrap = document.createElement('div');
      iconWrap.className = 'file-icon-wrap fi-' + iconFor(item);
      iconWrap.appendChild(makeIcon(iconFor(item), 'file-icon'));
      // 正文区
      var body = document.createElement('div'); body.className = 'file-body';
      var name = document.createElement('div'); name.className = 'file-name'; name.textContent = item.FileName || '未命名';
      var meta = document.createElement('div'); meta.className = 'file-meta';
      meta.textContent = item.Type === 1
        ? fmtTime(pickTime(item))
        : (fmtTime(pickTime(item)) + ' · ' + fmtSize(item.Size));
      body.appendChild(name); body.appendChild(meta);
      // 快捷方式按钮已移除：文件/文件夹的下载、删除等操作统一点击卡片后经操作浮层执行
      card.appendChild(iconWrap); card.appendChild(body);
      // 事件：多选模式下点击切换选中态；文件夹单击进入、长按弹操作浮层；文件单击/长按弹操作浮层
      card.addEventListener('click', function (e) {
        if (state.selectMode) {
          toggleSelect(item);
        } else if (item.Type === 1) {
          openDir(item);
        } else {
          openActionSheet(item);
        }
      });
      // 长按弹操作浮层（contextmenu 在 Android WebView 长按触发）
      card.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        if (!state.selectMode) openActionSheet(item);
      });
      box.appendChild(card);
    });
    // 更新多选操作栏的选中计数
    if (isSelect) refreshSelectBar();
  }

  // ---------- 多选（文件整理） ----------
  function enterSelectMode() {
    state.selectMode = true;
    state.selectedMap = {};
    show($('select-toolbar'));
    hide($('file-toolbar'));
    loadList();
  }
  function exitSelectMode() {
    state.selectMode = false;
    state.selectedMap = {};
    hide($('select-toolbar'));
    var ft = $('file-toolbar');
    if (ft) {
      ft.classList.remove('toolbar-hidden');  // 确保回归正常工具栏可见
      show(ft);
    }
    loadList();
  }
  function toggleSelect(item) {
    var id = item.FileId;
    if (state.selectedMap[id]) delete state.selectedMap[id];
    else state.selectedMap[id] = item;
    refreshSelectBar();
    // 按 data-fid 精准定位并刷新对应卡片（不重渲整表，保留选中动画）
    var box = $('file-list');
    var cards = box.querySelectorAll('.file-card');
    for (var i = 0; i < cards.length; i++) {
      if (Number(cards[i].getAttribute('data-fid')) !== Number(id)) continue;
      var sel = !!state.selectedMap[id];
      cards[i].classList.toggle('selected', sel);
      var ck = cards[i].querySelector('.file-check');
      if (ck) {
        ck.classList.toggle('checked', sel);
        ck.innerHTML = sel ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '';
      }
    }
  }
  function refreshSelectBar() {
    var n = Object.keys(state.selectedMap).length;
    var cnt = $('select-count');
    if (cnt) cnt.textContent = '已选 ' + n + ' 项';
    var mv = $('select-move');
    if (mv) mv.classList.toggle('disabled', n === 0);
    var cp = $('select-copy');
    if (cp) cp.classList.toggle('disabled', n === 0);
    var del = $('select-delete');
    if (del) del.classList.toggle('disabled', n === 0);
  }

  // ---------- 文件夹选择器（移动目标） ----------
  // 递归复制文件夹：创建同名文件夹 → 遍历内容 → 逐个复制 → 子文件夹递归
  // onDone 回调：当前文件夹（含所有子内容）复制完成后调用
  var _copyStats = { files: 0, dirs: 0 };
  function copyFolderRecursive(srcDir, targetParentId, onDone) {
    // 1. 在目标目录创建同名文件夹
    var mkdirBody = JSON.stringify({
      parentFileId: targetParentId,
      filename: srcDir.FileName || '未命名',
      dirPath: '',
      type: 1,
      etag: '',
      size: 0,
      conflictPolicy: 1
    });
    api('POST', API.mkdir, mkdirBody, true, function (d) {
      if (!d || d.code !== 0) {
        toast('创建文件夹失败：' + ((d && d.message) || ''));
        if (onDone) onDone();
        return;
      }
      var newDirId = (d.data && ((d.data.Info && (d.data.Info.FileId || d.data.Info.fileId)) || d.data.FileId || d.data.fileId)) || 0;
      if (!newDirId) { toast('创建文件夹失败：未返回ID'); if (onDone) onDone(); return; }
      _copyStats.dirs++;
      // 2. 列出源文件夹内容（分页拉取全部）
      listAllFiles(srcDir.FileId, function (list) {
        if (!list || !list.length) {
          if (onDone) onDone();
          return;
        }
        var idx = 0;
        function nextItem() {
          if (idx >= list.length) { if (onDone) onDone(); return; }
          var item = list[idx++];
          if (item.Type === 1) {
            // 子文件夹：递归，完成后再下一个
            copyFolderRecursive(item, newDirId, function () {
              setTimeout(nextItem, 300);
            });
          } else {
            // 文件：复制到新文件夹
            var body = { targetFileId: newDirId, fileList: [{ fileId: Number(item.FileId), fileName: item.FileName || '' }] };
            shareApi('POST', '/b/api/restful/goapi/v1/file/copy/async', JSON.stringify(body), false, function (cd) {
              _copyStats.files++;
              if (cd && cd.code === 0) {
                if (_copyStats.files % 10 === 0) toast('已复制 ' + _copyStats.files + ' 个文件，' + _copyStats.dirs + ' 个文件夹');
              } else {
                toast('复制文件「' + (item.FileName||'') + '」失败');
              }
              setTimeout(nextItem, 300);
            });
          }
        }
        nextItem();
      });
    });
  }
  // 分页拉取文件夹下所有文件（超过200条自动翻页）
  function listAllFiles(parentFileId, cb, nextPage) {
    nextPage = nextPage || 0;
    api('GET', API.list + '?driveId=0&limit=200&next=' + nextPage + '&orderBy=file_id&orderDirection=desc&parentFileId=' + parentFileId + '&trashed=false&Page=1&OnlyLookAbnormalFile=0', '', true, function (ld) {
      var list = (ld && ld.data && (ld.data.InfoList || ld.data.infoList)) || [];
      var next = (ld && ld.data && (ld.data.Next || ld.data.next)) || 0;
      if (next > 0) {
        listAllFiles(parentFileId, function (more) { cb(list.concat(more)); }, next);
      } else {
        cb(list);
      }
    });
  }

  // 轮询复制任务状态
  function pollCopyTask(taskId) {
    var attempts = 0;
    var maxAttempts = 60; // 最多轮询5分钟（5秒一次）
    function check() {
      if (attempts++ >= maxAttempts) { toast('复制任务已提交，请稍后在目标目录查看'); return; }
      shareApi('GET', '/b/api/restful/goapi/v1/file/copy/task?taskId=' + taskId, '', false, function (d) {
        if (d && d.code === 0) {
          var status = d.data && d.data.status;
          // status: 0=进行中, 1=成功, 2=失败
          if (status === 1) {
            toast('复制完成');
            if (state.view === 'files') loadList();
          } else if (status === 2) {
            toast('复制失败: ' + ((d.data && d.data.reason) || '未知错误'));
          } else {
            setTimeout(check, 5000);
          }
        } else {
          setTimeout(check, 5000);
        }
      });
    }
    setTimeout(check, 3000);
  }

  // 单个文件移动/复制：把当前 item 放入 selectedMap，然后打开目录选择器
  function pickTargetAndMove(item, action) {
    state.selectedMap = {};
    state.selectedMap[item.FileId] = item;
    state.pickerAction = action;
    setPickerTitle(action);
    state.pickerState = { dir: 0, path: [] };
    show($('move-picker'));
    loadPickerDir(0, []);
  }
  // 打开移动选择面板：从根目录开始浏览目录以选择目标文件夹
  function openMovePicker() {
    if (Object.keys(state.selectedMap).length === 0) { toast('请先选择要移动的文件'); return; }
    state.pickerAction = 'move';
    setPickerTitle('move');
    var selItems = [];
    for (var k in state.selectedMap) selItems.push(state.selectedMap[k]);
    state.pickerState = { dir: 0, path: [] };
    show($('move-picker'));
    loadPickerDir(0, []);
  }
  function setPickerTitle(action) {
    var t = $('picker-title');
    var tip = $('picker-tip');
    var btn = $('picker-confirm');
    if (action === 'copy') {
      if (t) t.textContent = '复制文件';
      if (tip) tip.textContent = '选择目标文件夹后点击"确定复制"复制到当前目录';
      if (btn) btn.textContent = '确定复制';
    } else {
      if (t) t.textContent = '移动文件';
      if (tip) tip.textContent = '选择目标文件夹后点击"确定移动"移入当前目录';
      if (btn) btn.textContent = '确定移动';
    }
  }
  function closeMovePicker() {
    hide($('move-picker'));
    state.pickerState = null;
  }
  // 加载选择器指定目录下的子文件夹（供选择移动目标）
  function loadPickerDir(pid, path) {
    state.pickerState = state.pickerState || { dir: 0, path: [] };
    state.pickerState.dir = pid;
    state.pickerState.path = path || [];
    // 渲染面包屑
    var bc = $('picker-crumb');
    bc.innerHTML = '';
    var root = document.createElement('span');
    root.className = 'pcrumb' + (pid === 0 ? ' active' : '');
    root.textContent = '全部文件';
    root.addEventListener('click', function () {
      if (state.pickerState.dir !== 0) loadPickerDir(0, []);
    });
    bc.appendChild(root);
    (path || []).forEach(function (c, i) {
      var sep = document.createElement('span'); sep.className = 'psep'; sep.textContent = '›';
      var cr = document.createElement('span');
      cr.className = 'pcrumb' + (i === path.length - 1 ? ' active' : '');
      cr.textContent = c.name;
      cr.addEventListener('click', function () {
        if (i < (path || []).length - 1) loadPickerDir(c.id, (path || []).slice(0, i + 1));
      });
      bc.appendChild(sep); bc.appendChild(cr);
    });
    var listEl = $('picker-list');
    listEl.innerHTML = '<div class="loading-dot">加载中...</div>';
    // 复用列表接口：仅取文件夹（Type===1）作为移动目标候选
    var params = 'driveId=0&limit=200&next=0&orderBy=file_id&orderDirection=desc'
      + '&parentFileId=' + pid + '&trashed=false&Page=1&OnlyLookAbnormalFile=0';
    api('GET', API.list + '?' + params, '', true, function (d) {
      var list = (d && d.data && d.data.InfoList) ? d.data.InfoList : [];
      var dirs = list.filter(function (x) { return x.Type === 1; });
      listEl.innerHTML = '';
      if (!dirs.length) {
        listEl.innerHTML = '<div class="p-empty">此目录下没有可选择的子文件夹</div>';
        return;
      }
      dirs.forEach(function (dir) {
        var row = document.createElement('div');
        row.className = 'pdir-row';
        // 图标
        var ic = document.createElement('div');
        ic.className = 'pdir-icon';
        ic.appendChild(makeIcon('folder', ''));
        row.appendChild(ic);
        var nm = document.createElement('div');
        nm.className = 'pdir-name'; nm.textContent = dir.FileName || '未命名';
        row.appendChild(nm);
        var badge = document.createElement('div');
        badge.className = 'pdir-badge';
        badge.textContent = '进入';
        row.appendChild(badge);
        row.addEventListener('click', function () {
          loadPickerDir(dir.FileId, (state.pickerState.path || []).concat([{ id: pid, name: dir.FileName }]));
        });
        listEl.appendChild(row);
      });
    });
  }
  // 确认：把选中的文件移动到当前选择器停留的目录
  function confirmMove() {
    var p = state.pickerState;
    if (!p) return;
    var targetId = Number(p.dir) || 0;
    var action = state.pickerAction || 'move';
    // 拦截：目标不能是任一选中文件夹自身或其子目录（仅移动时拦截，复制不拦截）
    if (action === 'move') {
      var paths = p.path || [];
      for (var k in state.selectedMap) {
        var it = state.selectedMap[k];
        var itId = Number(it.FileId);
        if (it.Type === 1 && itId === targetId) {
          toast('不能移动到自身所在文件夹'); return;
        }
        var inSel = paths.some(function (c) { return Number(c.id) === itId; });
        if (it.Type === 1 && inSel) {
          toast('不能移动到所选文件夹的子目录'); return;
        }
      }
    }
    // 移动或复制请求
    var ids = [];
    for (var kk in state.selectedMap) ids.push(Number(state.selectedMap[kk].FileId) || 0);
    if (action === 'copy') {
      // 复制：调 copy/async（走分享域名容灾）
      var copyItems = [];
      var hasFolder = false;
      var sourceFolder = null;
      for (var kk2 in state.selectedMap) {
        var it2 = state.selectedMap[kk2];
        if (it2.Type === 1) { hasFolder = true; sourceFolder = it2; }
        copyItems.push({
          fileId: Number(it2.FileId),
          fileName: it2.FileName || ''
        });
      }
      if (hasFolder) {
        // 有文件夹：逐个递归复制，全部完成后再复制文件
        var folders = [];
        var files = [];
        for (var kk3 in state.selectedMap) {
          var it3 = state.selectedMap[kk3];
          if (it3.Type === 1) folders.push(it3);
          else files.push({ fileId: Number(it3.FileId), fileName: it3.FileName || '' });
        }
        closeMovePicker();
        exitSelectMode();
        _copyStats = { files: 0, dirs: 0 };
        toast('开始复制 ' + folders.length + ' 个文件夹，' + files.length + ' 个文件...');
        var fi = 0;
        function nextFolder() {
          if (fi >= folders.length) {
            // 所有文件夹复制完，复制文件
            if (files.length) {
              var body2 = { targetFileId: targetId, fileList: files };
              shareApi('POST', '/b/api/restful/goapi/v1/file/copy/async', JSON.stringify(body2), false, function (d2) {
                if (d2 && d2.code === 0) toast('已复制 ' + files.length + ' 个文件');
                else toast('部分文件复制失败');
                toast('复制完成：共 ' + _copyStats.files + ' 个文件，' + _copyStats.dirs + ' 个文件夹');
                loadList();
              });
            } else {
              toast('复制完成：共 ' + _copyStats.files + ' 个文件，' + _copyStats.dirs + ' 个文件夹');
              loadList();
            }
            return;
          }
          var cur = folders[fi++];
          copyFolderRecursive(cur, targetId, function () {
            setTimeout(nextFolder, 500);
          });
        }
        nextFolder();
        return;
      }
      var copyBody = { targetFileId: targetId, fileList: copyItems };
      shareApi('POST', '/b/api/restful/goapi/v1/file/copy/async', JSON.stringify(copyBody), false, function (d) {
        if (d && d.code === 0) {
          closeMovePicker();
          exitSelectMode();
          toast('已复制到目标目录');
          loadList();
        } else {
          toast((d && d.message) || '复制失败');
        }
      });
      return;
    }
    // 移动请求体：123pan 原生协议 mod_pid -> {parentFileId 目标, fileIdList:[{FileId: id}]}
    var fileIdList = ids.map(function (fid) { return { FileId: fid }; });
    var body = { parentFileId: targetId, fileIdList: fileIdList };
    api('POST', API.move, JSON.stringify(body), true, function (d) {
      if (d && d.code === 0) {
        closeMovePicker();
        exitSelectMode();
        toast('已移动 ' + ids.length + ' 项');
        loadList();
      } else {
        toast((d && d.message) || '移动失败');
      }
    });
  }

  // 批量删除：将选中的文件/文件夹移入回收站（整理栏删除按钮）
  function deleteSelected() {
    var n = Object.keys(state.selectedMap).length;
    if (!n) { toast('请先选择要删除的文件'); return; }
    showConfirm('确认删除选中的 ' + n + ' 项？删除后将移入回收站', doDeleteSelected);
  }
  function doDeleteSelected() {
    // 收集选中项的 FileId 列表（支持批量）
    var fileIdList = [];
    for (var k in state.selectedMap) {
      fileIdList.push({ FileId: Number(state.selectedMap[k].FileId) || 0 });
    }
    if (!fileIdList.length) return;
    var count = fileIdList.length;
    // 批量移入回收站：复用删除接口，fileTrashInfoList 传入多个 FileId 实现批量删除
    api('POST', API.trash,
      JSON.stringify({
        RequestSource: null,
        driveId: 0,
        event: 'intoRecycle',
        fileTrashInfoList: fileIdList,
        operatePlace: 1,
        operation: true
      }),
      true,
      function (d) {
        if (d && d.code === 0) {
          exitSelectMode();
          toast('已将 ' + count + ' 项移入回收站');
          loadList();
        } else {
          toast((d && d.message) || '删除失败');
        }
      });
  }

  // ==================== 一键查重（全盘重复文件） ====================
  // 去扩展名：只有「以字母开头」的后缀才算扩展名。
  // 绝不能把数字段当扩展名删掉，否则 “10.0.1” 会被剪成 “10.0”，版本号就丢了。
  function dupStripExt(name) {
    return String(name || '').replace(/\.[A-Za-z][A-Za-z0-9]{0,7}$/, '');
  }
  // 版本/序号指纹：两个文件若指纹不同，就不可能是同一个文件的副本。
  //   'androidfs 10.0.0'         -> '10.0.0'
  //   'AIDE(模块专用) 3.2.1910'   -> '3.2.1910'
  //   'DSMCP_2.1.0.apk'          -> '2.1.0'
  //   '小AdGuard4.7.30(10214591)'-> '4.7.30|10214591'
  //   'report_2023'              -> '2023'
  //   'photo'                    -> ''
  function dupVersionKey(name) {
    var s = dupStripExt(name);
    var parts = [];
    var m = s.match(/\d+(?:[._]\d+){1,}/);   // 形如 10.0.0 / 3.2.1910 的点分版本号
    var rest = s;
    if (m) {
      parts.push(m[0].replace(/_/g, '.'));
      rest = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
    }
    var nums = rest.match(/\d+/g) || [];     // 其余长度 >= 2 的数字（构建号/日期/序号）
    for (var i = 0; i < nums.length; i++) {
      if (nums[i].length >= 2) parts.push(nums[i]);
    }
    return parts.join('|');
  }
  // 名称归一化：只清除「副本」类噪声，保留数字（版本号必须参与比较）
  function dupNormalize(name) {
    var s = dupStripExt(name);
    s = s.replace(/[\s\.\-_]*[\(\[【（]\s*(?:副本|copy|拷贝|c)?\s*\d+\s*[\)\]】）]\s*$/gi, ''); // 去 (1)/（2）/[1]/【1】
    s = s.replace(/[\s\-_\.]*(?:副本|拷贝|复制|copy|备份|backup|新建|最终版|final|修改版)\s*$/gi, ''); // 去常见尾缀
    s = s.replace(/[\s\u3000]+/g, '')                                // 去空白
         .replace(/[\.\-_·]+/g, '');                                 // 去分隔符
    return s.toLowerCase();
  }
  // 编辑距离相似度（0~1），用于“名称大致匹配”的兜底判定
  function dupSimilarity(a, b) {
    a = a || ''; b = b || '';
    if (a === b) return 1;
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 12) return 0;   // 长度差过大直接判不相似（提升性能）
    if (!la || !lb) return 0;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      for (j = 1; j <= lb; j++) {
        var cost = (a.charAt(i - 1) === b.charAt(j - 1)) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur.slice();
    }
    var dist = prev[lb];
    return 1 - dist / Math.max(la, lb);
  }
  // 判断两个文件名是否为“同一文件的重复副本”。
  // 关键修正：先比版本指纹，再做分级严格度判定，避免“名称毫无共同点也判重”。
  function dupIsSimilar(a, b) {
    var na = dupNormalize(a), nb = dupNormalize(b);
    if (!na || !nb) return false;

    // ── 规则1：版本号/序号必须完全一致（10.0.0 与 10.0.1 是不同版本，不是重复）
    if (dupVersionKey(a) !== dupVersionKey(b)) return false;

    if (na === nb) return true;

    // ── 规则2：包含关系必须有严格约束（原来无条件 return true 是误报主因）
    //     仅当多出来的尾巴很短、且不含数字时才算重复：
    //     '报告' ⊂ '报告copy' → 是；'报告' ⊂ '报告终稿' → 否
    var shorter = na.length <= nb.length ? na : nb;
    var longer = na.length <= nb.length ? nb : na;
    if (shorter.length >= 4 && longer.indexOf(shorter) >= 0) {
      var tail = longer.replace(shorter, '');
      if (tail.length <= Math.max(2, Math.floor(longer.length * 0.25)) && !/\d/.test(tail)) {
        return true;
      }
      return false;
    }

    // ── 规则3：相似度阈值随名称长度收紧（短名必须几乎完全一样）
    var sim = dupSimilarity(na, nb);
    var m = Math.min(na.length, nb.length);
    var thr;
    if (m < 6) thr = 1.0;          // 极短名：必须完全一致
    else if (m < 12) thr = 0.95;   // 短名：最多差 1 个字符
    else if (m < 24) thr = 0.90;
    else thr = 0.85;
    return sim >= thr;
  }
  // 更新扫描进度文案
  function dupUpdateProgress() {
    var su = $('dup-summary');
    if (su) su.textContent = '正在扫描全盘文件… 已发现 ' + state.dupScanned + ' 个文件';
    var bodyEl = $('dup-body');
    if (bodyEl && !bodyEl.querySelector('.dup-loading')) {
      bodyEl.innerHTML = '<div class="dup-loading"><div class="loading-dot">扫描中…</div><p>正在递归遍历所有文件夹，请稍候</p></div>';
    }
  }
  // 递归拉取全盘文件（从根目录 parentFileId=0 开始）
  // 关键：
  //  1) 只有当所有在途请求都返回（pending===0）后才结束；空闲超时 idleTimer 每次响应都重新武装，
  //     防止个别回调丢失导致永久卡死。
  //  2) 【分页】旧实现只取 Page=1，一旦某个目录条目数超过服务端单页上限，超出的文件会被静默丢弃。
  //     现改为按页循环拉取，直到某页返回数 < limit，确保目录内容完整。
  //  3) 【重试】单次请求失败（网络抖动/超时，原生侧返回 {ok:false}）时自动重试若干次；
  //     重试仍失败则计入 failCount 并通过扫描汇总提示“有目录未取到”，
  //     绝不把失败静默当成“空目录”，避免两次扫描文件数不一致（时有时无）。
  function dupFetchAll(cb, startDirId) {
    var files = [];
    var visited = {};
    // 【重复文件修复】采集阶段的文件级去重。
    //   旧实现只按目录 pid 去重，没有文件级去重：一旦某目录的某页被服务端重复返回
    //   （分页抖动、Total 语义偏差导致多翻一页、或异步递归重复进入），
    //   同一个文件（同 FileId/同路径）会被 push 两次，最终在查重结果里表现为
    //   “两个文件名、路径完全一样的条目”，被误当成重复文件。
    //   这里按 FileId 全局去重（FileId 为空时退回 FileName+Size 组合键）。
    var seenFiles = {};
    // 【限流修复】查重扫描的全局并发闸门：
    //   旧实现递归展开子目录时“同时”发出所有目录请求（实测冷启动 6 秒内发出 165 个请求），
    //   远超服务端全局频控阈值，导致大量响应被限流（code=100011），
    //   结果 = 大量目录取不到 -> 查重结果不完整/看起来失效。
    //   这里把在途请求数限制在 DUP_CONCURRENCY 以内，并对限流做长退避重试。
    var DUP_CONCURRENCY = 2;      // 同时在途的查重请求上限（降低并发以规避服务端频控）
    var _inflight = 0;
    var _waiters = [];            // 等待闸门的任务队列
    function _acquire(fn) {
      if (_inflight < DUP_CONCURRENCY) { _inflight++; fn(); }
      else _waiters.push(fn);
    }
    function _release() {
      _inflight--;
      if (_inflight < 0) _inflight = 0;
      var nx = _waiters.shift();
      if (nx) { _inflight++; nx(); }
    }
    // 【限流修复】请求节流：任意两次查重请求发起之间至少间隔 DUP_GAP_MS，
    //   把整体请求速率压到服务端频控阈值以下（并发+间隔双重限制）。
    var DUP_GAP_MS = 350;      // 两次请求之间的最小间隔(ms)
    var _lastFireAt = 0;
    function _throttle(fn) {
      var now = Date.now();
      var wait = DUP_GAP_MS - (now - _lastFireAt);
      if (wait <= 0) { _lastFireAt = now; fn(); }
      else { setTimeout(function () { _lastFireAt = Date.now(); fn(); }, wait); }
    }
    var pending = 0;
    // 【扫描不全根因修复】isIdle(): 真正静止 = 无在途请求、无占用名额、无排队任务。
    //   旧实现只用 pending<=0 判定，而 pending 从未被增减(恒为0)，
    //   导致每返回一个响应就误判“已静止”并收尾，造成大量目录根本未被扫描。
    var _retryPending = 0;   // 已排定但尚未执行的重试数(退避期间)
    function isIdle() {
      return pending <= 0 && _inflight <= 0 && _waiters.length === 0 && _retryPending <= 0;
    }
    var finished = false;
    var idleTimer = null;
    var IDLE_MS = 8000;      // 连续 8s 无任何响应才认为结束（防个别回调丢失卡死）
    var SHORT_MS = 400;      // 已无在途请求时的快速收尾静默窗口
    var MAX_MS = 180000;     // 全局硬超时 3 分钟
    var PAGE_LIMIT = 200;    // 每页请求条数
    var MAX_RETRY = 3;       // 单页请求失败后的最大重试次数
    var failCount = 0;       // 重试后仍失败的“页”数（用于提示用户结果可能不完整）
    var hardTimer = null;
    function done() {
      if (finished) return;
      finished = true;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
      cb(files, failCount);
    }
    function armIdle(ms) {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(function () {
        // 只有确实没有任何在途请求时才收尾
        if (isIdle()) done();
        else armIdle();
      }, ms || IDLE_MS);
    }
    // 带重试地请求某目录的某一页；onOk(pageList) 成功后回调，全部重试失败则 onFail()
    function requestPage(pid, page, onOk, onFail) {
      var attempt = 0;
      var MAX_ATTEMPT = 6;       // 含首次最多尝试 6 次（应对限流）
      function fire() {
        attempt++;
        // 先申请并发闸门（限并发）+ 节流（限速率），两者都通过才真正发请求
        _acquire(function () {
         _throttle(function () {
          pending++;   // 【扫描不全根因修复】计入在途请求
          var params = 'driveId=0&limit=' + PAGE_LIMIT + '&next=0&orderBy=file_id&orderDirection=desc'
            + '&parentFileId=' + pid + '&trashed=false&Page=' + page + '&OnlyLookAbnormalFile=0';
          api('GET', API.list + '?' + params, '', true, function (d) {
            pending--;   // 【扫描不全根因修复】请求返回，移出在途
            _release();
            var okResp = !!(d && d.ok !== false && d.data && d.data.InfoList);
            if (!okResp) {
              // 识别限流：服务端返回 code=100011（请勿频繁操作）
              var code = (d && d.data && typeof d.data.code === 'number') ? d.data.code
                       : ((d && typeof d.code === 'number') ? d.code : 0);
              var throttled = (code === 100011);
              if (attempt < MAX_ATTEMPT && !finished) {
                // 限流：长退避（指数翻倍，封顶12s）；其它失败：短退避
                var delay = throttled ? Math.min(2000 * Math.pow(2, attempt - 1), 12000) : (250 * attempt);
                _retryPending++;   // 【扫描不全根因修复】标记“有排定重试”，防止被误判静止
                setTimeout(function () { _retryPending--; if (!finished) fire(); }, delay);
                return;
              }
              failCount++;
              if (onFail) onFail();
              return;
            }
            var total = (d.data && typeof d.data.Total === 'number') ? d.data.Total : -1;
            onOk(d.data.InfoList, total);
          });
         });
        });
      }
      fire();
    }
    // 请求某目录的全部分页，收集完成后回调 afterDir()
    // 翻页判据【关键修复】：不能依赖 list.length >= PAGE_LIMIT 猜测
    //   —— 若服务端单页实际返回数小于请求的 limit（如实际上限 100，而我们请求 200），
    //      该条件恒为 false，会直接停止翻页，导致“目录扫描不完整”。
    //   改为依据响应中的 Total（该目录总条数）：只要已收集条数 < Total 就继续翻页。
    //   若服务端未返回 Total（-1），退回“本页满页则继续”的保守判据，避免漏页。
    function fetchDir(pid, afterDir, dirName) {
      var key = String(pid);
      if (visited[key]) { if (afterDir) afterDir(); return; }
      visited[key] = 1;
      var page = 1;
      var collected = 0;      // 本目录已收到的条目数（含文件与子目录）
      function nextPage() {
        requestPage(pid, page, function (list, total) {
          collected += list.length;
          var addedThisPage = 0;   // 本页"新增"（去重后）的文件数，用于识别重复翻页
          list.forEach(function (it) {
            if (it.Type === 1) {
              it._absDir = (dirName ? dirName : "");
              fetchDir(it.FileId, null, (dirName ? (dirName + "/" + (it.FileName || "")) : (it.FileName || "")));   // 文件夹：继续递归（传递子目录完整路径）
            } else {
              // 【重复文件修复】按 FileId 全局去重，避免同一文件被采集多次
              var fid = (it.FileId !== undefined && it.FileId !== null) ? String(it.FileId) : '';
              var k = fid || (String(it.FileName) + '|' + String(it.Size));
              if (seenFiles[k]) return;          // 已采集过：跳过，不重复计数
              seenFiles[k] = 1;
              it._absDir = (dirName ? dirName : "");   // 记录文件所在目录（相对根目录的路径）
              files.push(it);                     // 文件：收集
              state.dupScanned++;
              addedThisPage++;
            }
          });
          if (state.dupScanned % 20 === 0 && !finished) dupUpdateProgress();
          if (finished) return;
          // 判定是否还有下一页：
          //  1) 服务端给了 Total：collected < total 说明还有
          //  2) 未给 Total：本页满页（>= PAGE_LIMIT）才认为可能还有
          //  3) 【防重复/防死循环】若本页返回了内容但去重后"新增 0 条"，
          //     说明服务端在重复返回同一批数据（分页不稳/Total 语义偏差），
          //     此时必须停止翻页，否则会无限翻页并造成同一文件被反复采集。
          var more;
          if (list.length === 0) more = false;
          else if (total >= 0) more = (collected < total && addedThisPage > 0);
          else more = (list.length >= PAGE_LIMIT && addedThisPage > 0);
          if (more) { page++; nextPage(); return; }
          if (afterDir) afterDir();
        }, function () {
          // 该页重试仍失败：不再翻页，直接结束本目录（已计入 failCount）
          if (afterDir) afterDir();
        });
      }
      nextPage();
    }
    // 全局硬超时兜底，避免异常情况下永久卡死
    hardTimer = setTimeout(function () { done(); }, MAX_MS);
    // 若根目录请求也始终不返回（登录失效等），空闲超时兜底
    armIdle();
    fetchDir(startDirId || 0, function () {   /* 从指定目录开始扫描 */
      // 根目录（及其全部子目录链）处理到“本轮已无新在途请求”后收尾。
      // 注意：这里不能用 pending<=0 机械判定，因为子目录是在各页回调里递归发起的；
      // pending<=0 时代表所有已发起的请求都返回了。给出极短静默窗口确认后收尾。
      if (isIdle()) armIdle(SHORT_MS);
      else armIdle();
    });
    // 兜底：任意一次响应结束后检查是否已静止（覆盖递归子目录全部返回后的收尾）
    var _checkIdle = setInterval(function () {
      if (finished) { clearInterval(_checkIdle); return; }
      if (isIdle()) { clearInterval(_checkIdle); armIdle(SHORT_MS); }
    }, 250);
  }
  // 分组：把“大致相同”的文件归入同一组。
  // 【误报修复】旧实现是“新文件与组内任意成员相似即并入”，会因相似关系的传递性
  //   把本不相似的文件串成一组（A≈B、B≈C 但 A≉C 时，A 与 C 被并到同一组，
  //   渲染出来就像“不是重复却显示重复”）。
  //   现改为【以每组代表元代表元 rep 为唯一基准】：
  //   新文件只有与 rep 相似才能进该组，从而保证组内每个成员都与代表元相似，
  //   杜绝链式传染导致的误报。rep 取组内第一个成员，保持分组稳定。
  // 判断两个文件是否属于“同一目录”。
  //   dir 为空字符串代表根目录；两者都有值时需完全相等。
  function sameDupDir(a, b) {
    a = (a === undefined || a === null) ? '' : String(a);
    b = (b === undefined || b === null) ? '' : String(b);
    return a === b;
  }
  function dupGroup(files) {
    var groups = [];
    for (var i = 0; i < files.length; i++) {
      var it = files[i];
      var placed = false;
      for (var g = 0; g < groups.length; g++) {
        // 只与代表元比较，不再遍历组内所有成员
        // 【误报修复】除了名称相似，还必须属于同一目录才算“重复”，
        //   否则不同目录下的同名文件会被误判为重复。
        if (dupIsSimilar(groups[g].rep, it.FileName) &&
            sameDupDir(groups[g].dir, it._absDir)) {
          groups[g].items.push(it);
          placed = true;
          break;
        }
      }
      if (!placed) {
        groups.push({
          key: dupNormalize(it.FileName) || ('g' + i),
          label: it.FileName || '未命名',
          rep: it.FileName || '',        // 代表元：用于后续成员相似性判定
          dir: it._absDir || '',         // 代表元所在目录（判重必须同目录）
          items: [it]
        });
      }
    }
    return groups.filter(function (g) { return g.items.length >= 2; })
                 .sort(function (a, b) { return b.items.length - a.items.length; });
  }
  // 打开查重页并开始全盘扫描
  function openDupFinder(startDirId) {
    if (state.searching) exitSearch();
    if (state.selectMode) exitSelectMode();
    // 未指定目录时询问：全盘还是当前目录
    if (startDirId === undefined || startDirId === null) {
      showConfirm('扫描全盘文件查重，还是只扫描当前目录？\n\n确定 = 全盘查重\n取消 = 仅当前目录', function () {
        _doDupScan(0);
      });
      // 取消时扫当前目录
      setTimeout(function () {
        var cur = $('dup-page');
        // 如果弹窗还在，用户点取消后走当前目录
      }, 100);
      return;
    }
    _doDupScan(startDirId);
  }
  function _doDupScan(startDirId) {
    startDirId = startDirId || 0;
    state.dupGroups = [];
    state.dupSelected = {};
    state.dupScanning = true;
    state.dupScanned = 0;
    show($('dup-page'));
    hide($('dup-bar'));
    var su = $('dup-summary');
    var isFullScan = (startDirId === 0);
    if (su) su.innerHTML = isFullScan
      ? '<span style="color:var(--fg3);font-size:12px;display:block;padding:8px 12px;background:var(--hover);border-radius:8px;margin-bottom:8px;">⚠ 全盘扫描会遍历所有文件，耗时较长请耐心等待，按返回键取消扫描</span>'
      : '';
    var bodyEl = $('dup-body');
    if (bodyEl) bodyEl.innerHTML = '<div class="dup-loading"><div class="loading-dot">扫描中…</div><p>' + (isFullScan ? '正在递归遍历所有文件夹，请稍候' : '正在递归扫描当前文件夹，请稍候') + '</p></div>';
    dupFetchAll(function (files, failCount) {
      state.dupScanning = false;
      var groups = dupGroup(files);
      state.dupGroups = groups;
      renderDupResult(groups, files.length, failCount);
    }, startDirId);
  }
  // 渲染查重结果
  function renderDupResult(groups, totalFiles, failCount) {
    var su = $('dup-summary');
    var dupCount = 0;
    groups.forEach(function (g) { dupCount += g.items.length; });
    var warn = (failCount && failCount > 0)
      ? ('<br><span style="color:#e6a23c">⚠ 有 ' + failCount + ' 个目录未能取到，结果可能不完整，请重试</span>')
      : '';
    if (su) {
      su.innerHTML = (groups.length
        ? ('共扫描 <b>' + totalFiles + '</b> 个文件，发现 <b>' + groups.length + '</b> 组重复（' + dupCount + ' 个文件）')
        : ('共扫描 <b>' + totalFiles + '</b> 个文件，未发现重复文件 👍')) + warn;
    }
    renderDupRows(groups);
    refreshDupBar();
  }
  // 渲染分组行
  function renderDupRows(groups) {
    var body = $('dup-body');
    if (!body) return;
    body.innerHTML = '';
    if (!groups.length) {
      body.innerHTML = '<div class="panel-empty"><div class="panel-icon" data-icon="find-dup"></div><p>太棒了，没有发现名称重复的文件</p></div>';
      injectIcons(body);
      return;
    }
    groups.forEach(function (g, gi) {
      var wrap = document.createElement('div');
      wrap.className = 'dup-group';
      var head = document.createElement('div');
      head.className = 'dup-group-head';
      head.textContent = (g.label || '未命名') + ' · ' + g.items.length + ' 个相似文件';
      wrap.appendChild(head);
      g.items.forEach(function (it, ii) {
        var row = document.createElement('div');
        row.className = 'dup-row';
        row.setAttribute('data-id', String(it.FileId));
        var preSel = !!state.dupSelected[it.FileId];
        // 默认勾选：每组第 0 个作为“保留”，其余自动选中
        if (ii > 0 && !preSel) { state.dupSelected[it.FileId] = it; preSel = true; }
        var ck = document.createElement('span');
        ck.className = 'dup-check' + (preSel ? ' on' : '');
        ck.textContent = preSel ? '✓' : '';
        row.appendChild(ck);
        var iw = document.createElement('div');
        iw.className = 'dup-icon fi-' + iconFor(it);
        iw.appendChild(makeIcon(iconFor(it), 'file-icon'));
        row.appendChild(iw);
        var bd = document.createElement('div');
        bd.className = 'dup-info';
        var nm = document.createElement('div');
        nm.className = 'dup-name'; nm.textContent = it.FileName || '未命名';
        var mt = document.createElement('div');
        mt.className = 'dup-meta';
        var loc = it._absDir || it.NewParentName || it.ParentName || '';
        mt.textContent = fmtSize(it.Size) + (loc ? ' · ' + loc : '');
        bd.appendChild(nm); bd.appendChild(mt);
        row.appendChild(bd);
        var badge = document.createElement('span');
        if (ii === 0) {
          badge.className = 'dup-keep-badge'; badge.textContent = '保留';
        } else {
          badge.className = 'dup-sel-badge';
          badge.textContent = '重复';
        }
        row.appendChild(badge);
        row.addEventListener('click', function () { toggleDupSelect(it, row, ck); });
        wrap.appendChild(row);
      });
      body.appendChild(wrap);
    });
  }
  // 切换某文件选中状态
  function toggleDupSelect(item, row, ck) {
    var id = String(item.FileId);
    if (state.dupSelected[id]) { delete state.dupSelected[id]; }
    else { state.dupSelected[id] = item; }
    var on = !!state.dupSelected[id];
    ck.classList.toggle('on', on);
    ck.textContent = on ? '✓' : '';
    row.classList.toggle('sel', on);
    refreshDupBar();
  }
  // 刷新底部操作栏
  function refreshDupBar() {
    var n = Object.keys(state.dupSelected).length;
    var bar = $('dup-bar');
    if (!bar) return;
    if (n > 0) { show(bar); } else { hide(bar); }
    var si = $('dup-selinfo');
    if (si) si.textContent = '已选 ' + n + ' 项';
  }
  // 关闭查重页
  function closeDupFinder() {
    hide($('dup-page'));
    state.dupGroups = [];
    state.dupSelected = {};
    state.dupScanning = false;
  }
  // 整理：把选中的重复项移动到指定文件夹（复用移动选择器）
  function dupOrganize() {
    var n = Object.keys(state.dupSelected).length;
    if (!n) { toast('请先选择要整理的重复文件'); return; }
    var picker = $('move-picker');
    if (!picker) { toast('移动功能不可用'); return; }
    // 把查重选中项写入多选状态，复用 openMovePicker / confirmMove 流程
    state.selectedMap = {};
    for (var k in state.dupSelected) state.selectedMap[k] = state.dupSelected[k];
    openMovePicker();
  }
  // 删除重复项：把选中的重复文件移入回收站
  function dupDeleteSelected() {
    var ids = Object.keys(state.dupSelected);
    if (!ids.length) { toast('请先选择要删除的重复文件'); return; }
    showConfirm('确认删除选中的 ' + ids.length + ' 个重复文件？删除后将移入回收站', function () {
      var fileIdList = ids.map(function (k) { return { FileId: Number(k) || 0 }; });
      api('POST', API.trash,
        JSON.stringify({
          RequestSource: null,
          driveId: 0,
          event: 'intoRecycle',
          fileTrashInfoList: fileIdList,
          operatePlace: 1,
          operation: true
        }),
        true,
        function (d) {
          if (d && d.code === 0) {
            var removed = {};
            ids.forEach(function (k) { delete state.dupSelected[k]; removed[String(k)] = 1; });
            var ng = [];
            state.dupGroups.forEach(function (g) {
              g.items = g.items.filter(function (it) { return !removed[String(it.FileId)]; });
              if (g.items.length >= 2) ng.push(g);
            });
            state.dupGroups = ng;
            toast('已将 ' + ids.length + ' 项移入回收站');
            renderDupResult(ng, state.dupScanned);
            if (!ng.length && $('dup-summary')) {
              $('dup-summary').innerHTML = '重复文件已全部处理完毕 ✅';
            }
          } else {
            toast((d && d.message) || '删除失败');
          }
        });
    });
  }

  // ---------- 全局搜索（全盘文件） ----------
  function doSearch(keyword) {
    keyword = (keyword || '').trim();
    if (!keyword) { exitSearch(); return; }
    state.searching = true;
    state.searchKeyword = keyword;
    var box = $('file-list');
    box.innerHTML = '<div class="loading-dot">加载中...</div>';
    hide($('breadcrumb'));
    // 全盘搜索：parentFileId=0，用 SearchData 传关键词（123pan 全局搜索协议）
    var params = 'driveId=0&limit=200&next=0&orderBy=' + state.orderBy + '&orderDirection=' + state.orderDirection
      + '&parentFileId=0&trashed=false&Page=1&OnlyLookAbnormalFile=0'
      + '&SearchData=' + encodeURIComponent(keyword);
    api('GET', API.list + '?' + params, '', true, function (d) {
      if (d && d.data) {
        state.searchTotal = d.data.Total || 0;
        renderSearchResult(d.data.InfoList || [], state.searchTotal, keyword);
      } else {
        box.innerHTML = '<div class="panel-empty"><div class="panel-icon" data-icon="search"></div><p>搜索失败或需重新登录</p></div>';
        injectIcons(box);
      }
    });
  }
  function renderSearchResult(list, total, kw) {
    var box = $('file-list');
    box.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'search-summary';
    head.textContent = (list.length ? ('搜索「' + kw + '」共 ' + total + ' 项') : ('未找到「' + kw + '」相关文件'));
    box.appendChild(head);
    if (!list || !list.length) {
      var empty = document.createElement('div');
      empty.className = 'panel-empty';
      var ic = document.createElement('div'); ic.className = 'panel-icon'; ic.setAttribute('data-icon', 'search'); applySvg(ic, 'search');
      empty.appendChild(ic);
      var p = document.createElement('p'); p.textContent = '没有匹配的文件';
      empty.appendChild(p);
      box.appendChild(empty);
      return;
    }
    list.forEach(function (item) {
      var card = document.createElement('div');
      card.className = 'file-card';
      var iconWrap = document.createElement('div');
      iconWrap.className = 'file-icon-wrap fi-' + iconFor(item);
      iconWrap.appendChild(makeIcon(iconFor(item), 'file-icon'));
      var body = document.createElement('div'); body.className = 'file-body';
      var name = document.createElement('div'); name.className = 'file-name'; name.textContent = item.FileName || '未命名';
      var meta = document.createElement('div'); meta.className = 'file-meta';
      // 搜索结果：额外显示文件所在位置（NewParentName / ParentName）
      var loc = item._absDir || item.NewParentName || item.ParentName || '';
      meta.textContent = (item.Type === 1 ? '文件夹' : fmtSize(item.Size)) + (loc ? ' · ' + loc : '');
      body.appendChild(name); body.appendChild(meta);
      card.appendChild(iconWrap); card.appendChild(body);
      card.addEventListener('click', function () {
        openActionSheet(item);   // 文件/文件夹均弹出操作浮层（文件夹含"打开"入口）
      });
      box.appendChild(card);
    });
  }
  function exitSearch() {
    state.searching = false;
    state.searchKeyword = '';
    var input = $('search-input');
    if (input) input.value = '';
    var sc = $('search-clear');
    if (sc) hide(sc);
    show($('breadcrumb'));
    loadList();
  }

  // ---------- 操作浮层（九宫格） ----------
  // 打开文件夹：进入目录
  function openDir(item) {
    closeSheet();
    // 若从搜索结果进入文件夹，先退出搜索态，恢复面包屑（保留进入的目录）
    if (state.searching) {
      state.searching = false;
      state.searchKeyword = '';
      show($('breadcrumb'));
    }
    state.breadcrumb.push({ id: item.FileId, name: item.FileName });
    state.currentDir = item.FileId;
    loadList();
  }
  function openActionSheet(item) {
    state.currentItem = item;
    $('sheet-title').textContent = item.FileName || '未命名';
    var grid = $('sheet-grid');
    grid.innerHTML = '';
    var items;
    if (item.Type === 1) {
      items = [
        { icon: 'open', label: '打开', cls: 'primary', fn: function () { closeSheet(); openDir(item); } },
        { icon: 'find-dup', label: '去重此目录', cls: '', fn: function () { closeSheet(); _doDupScan(item.FileId); } },
        { icon: 'download', label: '下载', cls: '', fn: function () { closeSheet(); doDownload(item); } },
        { icon: 'share', label: '分享', cls: '', fn: function () { closeSheet(); doShare(item); } },
        { icon: 'detail', label: '详细信息', cls: '', fn: function () { closeSheet(); showFileDetail(item); } },
        { icon: 'folder-move', label: '移动', cls: '', fn: function () { closeSheet(); pickTargetAndMove(item, 'move'); } },
        { icon: 'copy', label: '复制', cls: '', fn: function () { closeSheet(); pickTargetAndMove(item, 'copy'); } },
        { icon: 'rename', label: '重命名', cls: '', fn: function () { closeSheet(); onAction('rename', item); } },
        { icon: 'trash', label: '删除', cls: 'warn', fn: function () { closeSheet(); onAction('delete', item); } }
      ];
    } else {
      var ext = (item.FileName || '').split('.').pop().toLowerCase();
      var isMedia = ['mp4','mkv','avi','mov','rmvb','flv','wmv','webm','ts','mp3','wav','flac','aac','ogg','m4a','ape'].indexOf(ext) >= 0;
      var previewLabel = isMedia ? '播放' : '预览';
      items = [
        { icon: 'open', label: previewLabel, cls: 'primary', fn: function () { closeSheet(); openPreview(item); } },
        { icon: 'download', label: '下载', cls: '', fn: function () { closeSheet(); doDownload(item); } },
        { icon: 'share', label: '分享', cls: '', fn: function () { closeSheet(); doShare(item); } },
        { icon: 'detail', label: '详细信息', cls: '', fn: function () { closeSheet(); showFileDetail(item); } },
        { icon: 'folder-move', label: '移动', cls: '', fn: function () { closeSheet(); pickTargetAndMove(item, 'move'); } },
        { icon: 'copy', label: '复制', cls: '', fn: function () { closeSheet(); pickTargetAndMove(item, 'copy'); } },
        { icon: 'rename', label: '重命名', cls: '', fn: function () { closeSheet(); onAction('rename', item); } },
        { icon: 'trash', label: '删除', cls: 'warn', fn: function () { closeSheet(); onAction('delete', item); } }
      ];
    }
    items.forEach(function (it) {
      var el = document.createElement('div');
      el.className = 'sheet-grid-item ' + it.cls;
      // 文字图标：功能名称直接置于方块内，不再使用 SVG 图标、不在方块下方单独显示名称
      var ic = document.createElement('div'); ic.className = 'sgi-icon';
      ic.textContent = it.label;
      el.appendChild(ic);
      el.title = it.label;
      el.addEventListener('click', it.fn);
      grid.appendChild(el);
    });
    // 文件菜单 5 项时一行五列显示（其它菜单保持原有四列布局）
    grid.style.gridTemplateColumns = (items.length === 5) ? 'repeat(5,1fr)' : '';
    show($('action-sheet'));
  }
  function closeSheet() { hide($('action-sheet')); }

  // ---------- 自定义确认弹窗（替代原生 confirm） ----------
  function showConfirm(message, onOk) {
    $('cf-message').textContent = message || '';
    state.confirmOk = onOk || null;
    show($('confirm-modal'));
  }
  function onCfOk() {
    hide($('confirm-modal'));
    var cb = state.confirmOk;
    state.confirmOk = null;
    if (cb) cb();
  }

  // ---------- 操作处理 ----------
  function onAction(act, item) {
    state.currentItem = item;
    if (act === 'rename') {
      closeSheet();
      $('rename-input').value = item.FileName || '';
      show($('rename-modal'));
    } else if (act === 'download') {
      doDownload(item);
    } else if (act === 'delete') {
      closeSheet();
      showConfirm('确认删除「' + (item.FileName || '') + '」？', function () { doDelete(item); });
    }
  }

  function doRename() {
    var item = state.currentItem;
    if (!item) return;
    var newName = $('rename-input').value.trim();
    if (!newName) { toast('名称不能为空'); return; }
    // 123pan 重命名：POST /a/api/file/rename，请求体 {driveId, fileId, fileName(新名), duplicate}
    api('POST', API.rename,
      JSON.stringify({ driveId: 0, fileId: item.FileId, fileName: newName, duplicate: 1 }),
      true,
      function (d) {
        if (d && d.code === 0) { hide($('rename-modal')); toast('重命名成功'); loadList(); }
        else toast((d && d.message) || '重命名失败');
      });
  }

  // 详细信息弹窗
  function showFileDetail(item) {
    var size = item.Size || item.size || 0;
    var t = fmtTime(pickTime(item));
    var html = '<div style="padding:8px 0;line-height:2;">'
      + '<div><b>名称：</b>' + esc(item.FileName || item.name || '') + '</div>'
      + '<div><b>类型：</b>' + (item.Type === 1 ? '文件夹' : '文件') + '</div>'
      + '<div><b>大小：</b>' + fmtSize(size) + '</div>'
      + '<div><b>修改时间：</b>' + (t || '—') + '</div>'
      + '<div><b>文件ID：</b>' + (item.FileId || '—') + '</div>'
      + '<div><b>收藏：</b>' + (item.Favorited === 1 ? '已收藏' : '未收藏') + '</div>'
      + '</div>';
    $('cf-title').textContent = '详细信息';
    $('cf-message').innerHTML = html;
    var btns = document.querySelector('#confirm-modal .modal-btns');
    if (btns) btns.style.display = '';
    show($('confirm-modal'));
    state.confirmOk = null;
  }

  function doDelete(item) {
    // 123pan 删除：POST /a/api/file/trash，请求体 {RequestSource, driveId, event:"intoRecycle", fileTrashInfoList:[{FileId}], operatePlace, operation}
    api('POST', API.trash,
      JSON.stringify({
        RequestSource: null,
        driveId: 0,
        event: 'intoRecycle',
        fileTrashInfoList: [{ FileId: item.FileId }],
        operatePlace: 1,
        operation: true
      }),
      true,
      function (d) {
        if (d && d.code === 0) { toast('已移入回收站'); loadList(); }
        else toast((d && d.message) || '删除失败');
      });
  }

  // ---------- 回收站 ----------
  // 回收站列表：复用文件列表接口，trashed=true 表示回收站文件（parentFileId=0 全量扁平）
  function loadRecycle() {
    var box = $('recycle-list');
    var empty = $('recycle-empty');
    if (!box) return;
    box.dataset.loaded = '1';
    box.innerHTML = '<div class="loading-dot">加载中...</div>';
    var params = 'driveId=0&limit=500&next=0&orderBy=file_id&orderDirection=desc'
      + '&parentFileId=0&trashed=true&Page=1&OnlyLookAbnormalFile=0';
    api('GET', API.list + '?' + params, '', true, function (d) {
      var list = d && d.data && (d.data.InfoList || d.data.Info);
      if (list && list.length) {
        if (empty) hide(empty);
        renderRecycle(list);
      } else {
        if (empty) show(empty);
        box.innerHTML = '';
      }
    });
  }
  function renderRecycle(list) {
    var box = $('recycle-list');
    box.innerHTML = '';
    if (!list || !list.length) { box.innerHTML = '<div class="panel-empty"><div class="panel-icon" data-icon="trash"></div><p>回收站为空</p></div>'; injectIcons(box); updateRecycleBar(list); return; }
    var sel = state.recycleSelected || {};
    var isSelMode = Object.keys(sel).length > 0 || state.recycleSelectMode;
    list.forEach(function (item) {
      var isSel = !!sel[item.FileId];
      var card = document.createElement('div');
      card.className = 'file-card' + (isSel ? ' selected' : '');
      var iconWrap = document.createElement('div');
      iconWrap.className = 'file-icon-wrap fi-' + iconFor(item);
      iconWrap.appendChild(makeIcon(iconFor(item), 'file-icon'));
      var body = document.createElement('div'); body.className = 'file-body';
      var name = document.createElement('div'); name.className = 'file-name'; name.textContent = item.FileName || '未命名';
      var meta = document.createElement('div'); meta.className = 'file-meta';
      meta.textContent = item.Type === 1 ? '文件夹' : (fmtSize(item.Size) + ' · ' + (item.TrashTime || item.ModifyTime || ''));
      body.appendChild(name); body.appendChild(meta);
      card.appendChild(iconWrap); card.appendChild(body);
      if (isSelMode) {
        var ck = document.createElement('div');
        ck.className = 'file-check' + (isSel ? ' checked' : '');
        if (isSel) ck.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
        card.insertBefore(ck, card.firstChild);
      }
      card.addEventListener('click', function () {
        if (isSelMode) {
          if (isSel) delete sel[item.FileId]; else sel[item.FileId] = item;
          state.recycleSelected = sel;
          renderRecycle(list);
          updateRecycleBar(list);
        } else {
          openRecycleSheet(item);
        }
      });
      card.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        state.recycleSelectMode = true;
        sel[item.FileId] = item;
        state.recycleSelected = sel;
        renderRecycle(list);
        updateRecycleBar(list);
      });
      box.appendChild(card);
    });
    injectIcons(box);
    updateRecycleBar(list);
  }
  function updateRecycleBar(list) {
    var bar = $('recycle-bar');
    var n = Object.keys(state.recycleSelected || {}).length;
    if (!bar) return;
    if (n > 0) {
      bar.style.display = 'flex';
      var txt = bar.querySelector('.rb-text');
      if (txt) txt.textContent = '已选 ' + n + ' 项';
    } else {
      bar.style.display = 'none';
      state.recycleSelectMode = false;
    }
  }
  // 回收站文件操作浮层：恢复 / 彻底删除
  function openRecycleSheet(item) {
    state.currentItem = item;
    $('sheet-title').textContent = (item.FileName || '未命名') + '（回收站）';
    var grid = $('sheet-grid');
    grid.innerHTML = '';
    grid.style.gridTemplateColumns = '';
    var items = [
      { icon: 'restore', label: '恢复到原位置', cls: 'primary', fn: function () {
          closeSheet();
          doRecycleOp(item, RECYCLE_EVENT.restore, 0);
        } },
      { icon: 'folder', label: '恢复到指定目录', cls: 'primary', fn: function () {
          closeSheet();
          startRecycleRestorePick(item);
        } },
      { icon: 'trash', label: '彻底删除', cls: 'warn', fn: function () {
          closeSheet();
          showConfirm('确认彻底删除"' + (item.FileName || '') + '"？\n清理后将无法恢复！', function () {
            doRecycleOp(item, RECYCLE_EVENT.deleteP);
          });
        } }
    ];
    items.forEach(function (it) {
      var el = document.createElement('div');
      el.className = 'sheet-grid-item ' + it.cls;
      var ic = document.createElement('div'); ic.className = 'sgi-icon';
      ic.textContent = it.label;
      el.appendChild(ic);
      el.title = it.label;
      el.addEventListener('click', it.fn);
      grid.appendChild(el);
    });
    show($('action-sheet'));
  }
  // 选择恢复到指定目录：切到文件页，用户进入目标文件夹后点确认
  var _restorePickItem = null;
  function startRecycleRestorePick(item) {
    _restorePickItem = item;
    switchView('files');
    toast('请进入要恢复到的文件夹，然后点右下角确认');
    // 弹一个悬浮确认按钮
    var btn = document.createElement('button');
    btn.id = 'restore-pick-confirm';
    btn.textContent = '恢复到此';
    btn.style.cssText = 'position:fixed;bottom:200px;right:16px;z-index:999;background:var(--accent);color:#fff;border:none;border-radius:24px;padding:12px 20px;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    btn.addEventListener('click', function () {
      document.body.removeChild(btn);
      var targetId = state.currentDir || 0;
      doRecycleOp(_restorePickItem, RECYCLE_EVENT.restore, targetId);
      _restorePickItem = null;
    });
    document.body.appendChild(btn);
  }
  // 通用回收站操作（恢复 / 彻底删除）
  // 恢复：POST /a/api/file/trash（event=recycleRestore，operation=false）
  // 彻底删除：POST /a/api/file/delete（event=recycleDelete，fileIdList）
  function doRecycleOp(item, ev, targetParentId) {
    var isRestore = (ev === RECYCLE_EVENT.restore);
    var url = isRestore ? API.trash : API.trashDelete;
    var body = isRestore
      ? { RequestSource: null, driveId: 0, event: ev, fileTrashInfoList: [{ FileId: item.FileId }], operatePlace: 1, operation: false, safeBox: false }
      : { RequestSource: null, event: ev, fileIdList: [{ FileId: Number(item.FileId) || 0 }], operatePlace: 1 };
    // 先恢复到原位置
    api('POST', url, JSON.stringify(body), true, function (d) {
      if (d && (d.code === 0 || (d.message && /已删除|已恢复|释放空间/.test(d.message)))) {
        toast(isRestore ? '正在恢复文件...' : (d.message || '已彻底删除'));
        state.recycleSelected = {};
        state.recycleSelectMode = false;
        loadRecycle();
        // 如果指定了目标目录，恢复成功后自动移动
        if (isRestore && targetParentId) {
          setTimeout(function () {
            var moveBody = { parentFileId: targetParentId, fileIdList: [{ FileId: Number(item.FileId) || 0 }] };
            api('POST', API.move, JSON.stringify(moveBody), true, function (md) {
              if (md && (md.code === 0 || /成功|恢复|移动/.test(md.message || ''))) { toast('已恢复到指定目录'); switchView('files'); setTimeout(loadList, 300); }
              else { toast('已恢复到原位置'); switchView('files'); setTimeout(loadList, 300); }
            });
          }, 1000);
        }
      } else if (d && (d.code === 4001 || /安全验证|验证码|验证/i.test(d.message || ''))) {
        showConfirm('触发安全验证，需要在验证页面完成滑块+短信验证。\n是否立即打开验证页面？', function () {
          if (bridge && bridge.openVerifyWeb) bridge.openVerifyWeb();
          else if (bridge && bridge.openExternalWeb) bridge.openExternalWeb('https://canary-yun.123pan.cn/recycle?notoken=1');
        });
      } else toast((d && d.message) || '操作失败');
    });
  }
  // 清空回收站：走专用接口 file/trash_delete_all（event=recycleClear），清空后 code 为 7301 视为成功
  function recycleClearAll() {
    api('POST', API.trashDeleteAll,
      JSON.stringify({ RequestSource: null, event: RECYCLE_EVENT.clear }),
      true,
      function (d) {
        // 清空接口成功返回 code=7301（"已清空，系统释放空间需要一段时间"），code=0 或 7301 均算成功
        if (d && (d.code === 0 || d.code === 7301)) { toast('回收站已清空'); loadRecycle(); }
        else toast((d && d.message) || '清空失败');
      });
  }

  // 下载：文件走 download_info，文件夹走 batch_download_info
  // 修复①：download_info 请求体必须携带真实字节数，否则接口返回"请输入size"。
  //     列表项尺寸字段可能是 Size / FileSize / size，全面兜底，且 type 需为数字。
  // 修复②：body 同时携带 size 与 fileSize 两个字段，兼容 123pan 接口不同字段名。
  function buildDownloadBody(item) {
    var sz = Number(item.Size) || Number(item.FileSize) || Number(item.size) || 0;
    return {
      driveId: 0,
      etag: item.Etag || item.etag || '',
      fileId: item.FileId || item.fileId,
      size: sz,
      fileSize: sz,
      s3keyFlag: item.S3KeyFlag || item.s3keyFlag || item.s3KeyFlag || '',
      fileName: item.FileName || item.fileName || '',
      fileNameType: (item.Type !== undefined ? item.Type : 0),
      type: 'download'
    };
  }
  function pickDownloadUrl(d) {
    var dl = d && d.data;
    if (!dl) return '';
    return (dl.DownloadUrl || dl.downloadUrl || dl.url
      || (dl[0] && (dl[0].DownloadUrl || dl[0].url)) || '');
  }
  function doDownload(item) {
    var url, body;
    if (item.Type === 1) {
      url = API.batchDownload;
      body = JSON.stringify({ fileIdList: [{ fileId: item.FileId || item.fileId }] });
    } else {
      url = API.download;
      body = JSON.stringify(buildDownloadBody(item));
    }
    toast('正在获取下载链接...');
    api('POST', url, body, true, function (d) {
      if (!d || !d.data) {
        // 接口明确报缺 size 时给出可理解的提示，避免用户看到乱码般的原始错误
        var msg = (d && (d.message || d.error)) || '获取下载链接失败';
        if (/size/i.test(msg)) msg = '下载失败：该文件缺少大小信息，请刷新列表后重试';
        toast(msg);
        return;
      }
      var link = pickDownloadUrl(d);
      if (link) {
        var fname = item.FileName || item.fileName || (Date.now() + '');
        // 文件夹批量下载返回的是 zip 包，确保文件名带 .zip 后缀
        if (item.Type === 1 && !/\.zip$/i.test(fname)) fname = fname + '.zip';
        var fsize = Number(item.Size) || Number(item.size) || Number(item.FileSize) || 0;
        var started = false;
        var genId = -1;
        var isStream = false;
        // 自研流式下载（带认证头 + 多级直链解析 + 严格字节校验，杜绝"未下完就显示完成"）
        // 注意：不再回退到 DownloadManager —— 其用默认 UA 直连会被服务端拦截返回错误小文件
        //       （5344 字节 HTML），且自身也会把"部分下载"误标为成功，制造损坏 apk。宁可明确失败让用户重试。
        if (bridge && bridge.downloadStream) {
          try {
            genId = Number(bridge.downloadStream(link, fname, fsize));
            started = genId >= 0;
            isStream = started;
          } catch (e) { started = false; }
        }
        if (!started) {
          toast('下载启动失败，请重试');
          return; // 不回退，避免 DownloadManager 假完成造成损坏文件
        }
        addTransfer({ id: genId, name: fname, size: fsize, total: fsize, status: 'downloading', stream: isStream, link: link });
        startProgressPolling();
        toast('已加入下载任务');
      } else {
        toast('暂无法获取直链，请查看返回信息');
      }
    });
  }

  // ---------- 文件预览（图片 / 音视频 / 文本 / PDF / Word / Excel） ----------
  // 方案：媒体与 PDF 走本地代理（原生带认证头转发 CDN 直链，支持 Range）；文本走原生 fetchText 桥；
  // Word(docx)/Excel(xlsx/xls) 走 fetchBytes 桥 + 前端渲染库；其余类型降级提示（可复制直链 / 下载）。
  var PREVIEW_EXT = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'],
    audio: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'amr'],
    video: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp'],
    text: ['txt', 'md', 'json', 'xml', 'log', 'csv', 'ini', 'conf', 'yml', 'yaml', 'js', 'css',
      'java', 'kt', 'py', 'go', 'rs', 'c', 'cpp', 'h', 'sh', 'bat', 'sql', 'ts', 'php', 'rb', 'swift',
      'toml', 'properties', 'gradle', 'srt', 'ass'],
    html: ['html', 'htm'],
    docx: ['docx'],
    xlsx: ['xlsx', 'xls'],
    pdf: ['pdf']
  };
  function previewKindOf(name) {
    var m = /\.([a-zA-Z0-9]+)$/.exec(String(name || ''));
    var ext = m ? m[1].toLowerCase() : '';
    if (!ext) return '';
    for (var k in PREVIEW_EXT) {
      if (PREVIEW_EXT[k].indexOf(ext) >= 0) return k;
    }
    return '';
  }
  // 复用下载直链获取链路（download_info）取预览用直链
  function previewLinkFor(item, cb) {
    if (!item || item.Type === 1) { cb(''); return; }
    api('POST', API.download, JSON.stringify(buildDownloadBody(item)), true, function (d) {
      if (!d || !d.data) {
        var msg = (d && (d.message || d.error)) || '获取文件地址失败';
        if (/size/i.test(msg)) msg = '该文件缺少大小信息，请刷新列表后重试';
        toast(msg);
        cb('');
        return;
      }
      var link = pickDownloadUrl(d);
      if (!link) { toast('暂无法获取预览链接'); cb(''); return; }
      cb(link);
    });
  }
  function pvBody() { return $('pv-body'); }
  function renderPreviewLoading(msg) {
    var box = pvBody();
    if (!box) return;
    box.innerHTML = '<div class="pv-loading"><div class="pv-spin"></div><div>' + esc(msg || '加载中...') + '</div></div>';
  }
  function renderPreviewFallback(sub, title) {
    var box = pvBody();
    if (!box) return;
    box.innerHTML =
      '<div class="pv-fallback">'
      + '<div class="pv-fb-ic">!</div>'
      + '<div class="pv-fb-title">' + esc(title || '无法在线预览该文件') + '</div>'
      + '<div class="pv-fb-sub">' + esc(sub || '') + '</div>'
      + '<div class="pv-fb-btns">'
      + '<button class="pv-btn" id="pv-fb-copy">复制链接</button>'
      + '<button class="pv-btn primary" id="pv-fb-download">下载</button>'
      + '</div></div>';
    var fbCopy = $('pv-fb-copy');
    if (fbCopy) fbCopy.addEventListener('click', copyPreviewLink);
    var fbDl = $('pv-fb-download');
    if (fbDl) fbDl.addEventListener('click', function () {
      var pv = state.preview;
      if (pv && pv.item) doDownload(pv.item);
    });
  }
  function openPreview(item) {
    if (!item || item.Type === 1) return;
    var name = item.FileName || item.fileName || '未命名';
    state.preview = { item: item, name: name, kind: previewKindOf(name), link: '', pdf: null, pdfPage: 1, pdfTask: null, xlsBook: null };
    $('pv-title').textContent = name;
    renderPreviewLoading('正在获取文件地址...');
    show($('page-preview'));
    previewLinkFor(item, function (link) {
      var pv = state.preview;
      if (!pv || pv.item !== item) return; // 用户已关闭或切换
      if (!link) { renderPreviewFallback('未能获取文件直链，请稍后重试', '预览失败'); return; }
      pv.link = link;
      renderPreviewBody();
    });
  }
  function closePreview() {
    hide($('page-preview'));
    var pv = state.preview;
    if (pv) {
      if (pv.pdf && pv.pdf.destroy) { try { pv.pdf.destroy(); } catch (e) {} }
      var m = document.querySelector('#pv-body audio, #pv-body video');
      if (m && m.pause) { try { m.pause(); } catch (e) {} }
    }
    var box = pvBody();
    if (box) box.innerHTML = '';
    state.preview = null;
  }
  function copyPreviewLink() {
    var pv = state.preview;
    if (!pv || !pv.link) { toast('预览链接尚未就绪'); return; }
    copyText(pv.link, '预览链接已复制');
  }
  function renderPreviewBody() {
    var pv = state.preview;
    if (!pv) return;
    if (pv.kind === 'image' || pv.kind === 'audio' || pv.kind === 'video') {
      var purl = (bridge && bridge.getPreviewUrl) ? bridge.getPreviewUrl(pv.link) : '';
      if (!purl) { renderPreviewFallback('本地预览服务未就绪，请重启 App 后重试', '预览失败'); return; }
      renderPreviewMedia(pv, purl);
    } else if (pv.kind === 'text') {
      renderPreviewText(pv);
    } else if (pv.kind === 'html') {
      renderPreviewHtml(pv);
    } else if (pv.kind === 'pdf') {
      renderPreviewPdf(pv);
    } else if (pv.kind === 'docx') {
      renderPreviewDocx(pv);
    } else if (pv.kind === 'xlsx') {
      renderPreviewXlsx(pv);
    } else {
      renderPreviewFallback('该类型暂不支持在线预览，可复制链接或下载后使用其他应用打开', '该类型暂不支持在线预览');
    }
  }
  function renderPreviewMedia(pv, purl) {
    var box = pvBody();
    if (!box) return;
    if (pv.kind === 'image') {
      box.innerHTML = '<div class="pv-loading" id="pv-ld"><div class="pv-spin"></div><div>正在加载图片...</div></div>'
        + '<div class="pv-image hidden" id="pv-imgwrap"><img id="pv-img" alt=""></div>';
      var img = $('pv-img');
      img.onload = function () { hide($('pv-ld')); show($('pv-imgwrap')); };
      img.onerror = function () { renderPreviewFallback('图片加载失败，请稍后重试或下载查看', '预览失败'); };
      img.src = purl;
    } else if (pv.kind === 'audio') {
      box.innerHTML = '<div class="pv-media"><div class="pv-media-name">' + esc(pv.name) + '</div>'
        + '<audio id="pv-audio" controls preload="metadata"></audio>'
        + '<div class="pv-loading" id="pv-ld"><div class="pv-spin"></div><div>正在加载音频...</div></div></div>';
      var au = $('pv-audio');
      au.oncanplay = function () { var ld = $('pv-ld'); if (ld) hide(ld); };
      au.onerror = function () { renderPreviewFallback('音频加载失败或格式不受支持', '预览失败'); };
      au.src = purl;
    } else {
      box.innerHTML = '<div class="pv-media"><video id="pv-video" controls playsinline webkit-playsinline></video>'
        + '<div class="pv-loading" id="pv-ld"><div class="pv-spin"></div><div>正在加载视频...</div></div></div>';
      var vd = $('pv-video');
      vd.oncanplay = function () { var ld = $('pv-ld'); if (ld) hide(ld); };
      vd.onerror = function () { renderPreviewFallback('视频加载失败或格式不受支持', '预览失败'); };
      vd.src = purl;
    }
  }
  function renderPreviewHtml(pv) {
    var box = pvBody();
    if (!box) return;
    var purl = (bridge && bridge.getPreviewUrl) ? bridge.getPreviewUrl(pv.link) : pv.link;
    if (!purl) { renderPreviewFallback('本地预览服务未就绪', '预览失败'); return; }
    box.innerHTML = '<div class="pv-html-toolbar">'
      + '<button class="pv-html-btn" id="pv-html-view">网页视图</button>'
      + '<button class="pv-html-btn" id="pv-html-src">源码视图</button>'
      + '</div>'
      + '<div class="pv-html-wrap" id="pv-html-wrap">'
      + '<iframe id="pv-html-frame" sandbox="allow-scripts allow-same-origin allow-forms" style="width:100%;height:100%;border:none;background:#fff;"></iframe>'
      + '<pre id="pv-html-pre" style="display:none;width:100%;height:100%;overflow:auto;padding:12px;margin:0;font-size:13px;background:#1e1e1e;color:#d4d4d4;white-space:pre-wrap;"></pre>'
      + '</div>';
    $('pv-html-frame').src = purl;
    $('pv-html-view').addEventListener('click', function () {
      $('pv-html-frame').style.display = '';
      $('pv-html-pre').style.display = 'none';
    });
    $('pv-html-src').addEventListener('click', function () {
      $('pv-html-frame').style.display = 'none';
      $('pv-html-pre').style.display = '';
      if (!$('pv-html-pre').textContent && bridge && bridge.fetchText) {
        renderPreviewLoading('正在加载源码...');
        window.__onFetchText = function (url, ok, text) {
          hide($('pv-ld'));
          $('pv-html-pre').textContent = ok ? (text || '') : '加载失败';
        };
        bridge.fetchText(pv.link);
      }
    });
  }
  function renderPreviewText(pv) {
    renderPreviewLoading('正在加载文本...');
    if (!bridge || !bridge.fetchText) { renderPreviewFallback('当前版本不支持文本预览'); return; }
    window.__onFetchText = function (url, ok, text) {
      if (state.preview !== pv || url !== pv.link) return;
      if (!ok) { renderPreviewFallback('文本加载失败，请稍后重试', '预览失败'); return; }
      var box = pvBody();
      if (!box) return;
      box.innerHTML = '<div class="pv-text"><pre id="pv-text-pre"></pre></div>';
      $('pv-text-pre').textContent = text;
    };
    bridge.fetchText(pv.link);
  }
  // 按需加载本地资源库（避免启动时加载大体积脚本）
  var _pvLibs = {};
  function loadPvLib(globalName, src, cb) {
    if (window[globalName]) { cb(null); return; }
    var st = _pvLibs[src];
    if (st) { st.push(cb); return; }
    st = _pvLibs[src] = [cb];
    var s = document.createElement('script');
    s.src = src;
    function done() {
      var cbs = st.slice();
      _pvLibs[src] = [];
      for (var i = 0; i < cbs.length; i++) {
        try { cbs[i](window[globalName] ? null : new Error('load failed')); } catch (e) {}
      }
    }
    s.onload = done;
    s.onerror = done;
    document.head.appendChild(s);
  }
  function renderPreviewPdf(pv) {
    renderPreviewLoading('正在加载 PDF...');
    loadPvLib('pdfjsLib', 'lib/pdf.min.js', function (err) {
      if (state.preview !== pv) return;
      if (err || !window.pdfjsLib) { renderPreviewFallback('PDF 渲染组件加载失败', '预览失败'); return; }
      try { pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js'; } catch (e) {}
      var purl = (bridge && bridge.getPreviewUrl) ? bridge.getPreviewUrl(pv.link) : '';
      if (!purl) { renderPreviewFallback('本地预览服务未就绪，请重启 App 后重试', '预览失败'); return; }
      var task = pdfjsLib.getDocument({ url: purl });
      task.promise.then(function (doc) {
        if (state.preview !== pv) { try { doc.destroy(); } catch (e) {} return; }
        pv.pdf = doc;
        pv.pdfPage = 1;
        buildPdfChrome(pv);
        renderPdfPage(pv, 1);
      }, function () {
        // 流式（Range）加载失败时，退回经原生桥取全量字节再渲染
        previewPdfViaBridge(pv);
      });
    });
  }
  function previewPdfViaBridge(pv) {
    if (!bridge || !bridge.fetchBytes) { renderPreviewFallback('PDF 加载失败', '预览失败'); return; }
    renderPreviewLoading('正在加载 PDF（兼容模式）...');
    window.__onFetchBytes = function (url, ok, b64, msg) {
      if (state.preview !== pv || url !== pv.link) return;
      if (!ok || !b64) { renderPreviewFallback(msg || 'PDF 加载失败', '预览失败'); return; }
      try {
        var bin = atob(b64);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        pdfjsLib.getDocument({ data: arr }).promise.then(function (doc) {
          if (state.preview !== pv) { try { doc.destroy(); } catch (e) {} return; }
          pv.pdf = doc;
          pv.pdfPage = 1;
          buildPdfChrome(pv);
          renderPdfPage(pv, 1);
        }, function () { renderPreviewFallback('PDF 加载失败', '预览失败'); });
      } catch (e) { renderPreviewFallback('PDF 加载失败', '预览失败'); }
    };
    bridge.fetchBytes(pv.link);
  }
  function buildPdfChrome(pv) {
    var box = pvBody();
    if (!box) return;
    box.innerHTML = '<div class="pv-pdf">'
      + '<div class="pv-pdf-scroll" id="pv-pdf-scroll"><canvas id="pv-canvas"></canvas></div>'
      + '<div class="pv-pdf-bar">'
      + '<button class="pv-btn" id="pv-prev">上一页</button>'
      + '<span class="pv-pageinfo" id="pv-pageinfo">1 / ' + (pv.pdf ? pv.pdf.numPages : 1) + '</span>'
      + '<button class="pv-btn" id="pv-next">下一页</button>'
      + '</div></div>';
    $('pv-prev').addEventListener('click', function () { pdfGo(pv, -1); });
    $('pv-next').addEventListener('click', function () { pdfGo(pv, 1); });
  }
  function pdfGo(pv, delta) {
    if (state.preview !== pv || !pv.pdf) return;
    var n = pv.pdfPage + delta;
    if (n < 1 || n > pv.pdf.numPages) return;
    renderPdfPage(pv, n);
  }
  function renderPdfPage(pv, n) {
    if (state.preview !== pv || !pv.pdf) return;
    if (pv.pdfTask) { try { pv.pdfTask.cancel(); } catch (e) {} }
    pv.pdf.getPage(n).then(function (page) {
      if (state.preview !== pv) return;
      pv.pdfPage = n;
      var info = $('pv-pageinfo');
      if (info) info.textContent = n + ' / ' + pv.pdf.numPages;
      var wrap = $('pv-pdf-scroll');
      var wrapW = wrap ? wrap.clientWidth : 320;
      var width = Math.max(240, wrapW - 20);
      try {
        var base = page.getViewport({ scale: 1 });
        var scale = width / base.width;
        var dpr = window.devicePixelRatio || 1;
        var vp = page.getViewport({ scale: scale * dpr });
        var canvas = $('pv-canvas');
        if (!canvas) return;
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = Math.floor(vp.width / dpr) + 'px';
        canvas.style.height = Math.floor(vp.height / dpr) + 'px';
        var ctx = canvas.getContext('2d');
        pv.pdfTask = page.render({ canvasContext: ctx, viewport: vp });
        if (pv.pdfTask && pv.pdfTask.promise) {
          pv.pdfTask.promise.then(function () {}, function () {});
        }
      } catch (e) {}
    });
  }
  function renderPreviewDocx(pv) {
    renderPreviewLoading('正在加载 Word 文档...');
    loadPvLib('mammoth', 'lib/mammoth.browser.min.js', function (err) {
      if (state.preview !== pv) return;
      if (err || !window.mammoth) { renderPreviewFallback('Word 渲染组件加载失败', '预览失败'); return; }
      if (!bridge || !bridge.fetchBytes) { renderPreviewFallback('当前版本不支持 Word 预览'); return; }
      window.__onFetchBytes = function (url, ok, b64, msg) {
        if (state.preview !== pv || url !== pv.link) return;
        if (!ok || !b64) { renderPreviewFallback(msg || 'Word 文档加载失败', '预览失败'); return; }
        renderPreviewLoading('正在解析 Word 文档...');
        try {
          var bin = atob(b64);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          mammoth.convertToHtml({ arrayBuffer: arr.buffer }).then(function (result) {
            if (state.preview !== pv) return;
            var html = (result && result.value) ? result.value : '';
            if (!html) { renderPreviewFallback('未能解析出文档内容', '预览失败'); return; }
            var box = pvBody();
            if (box) box.innerHTML = '<div class="pv-docx">' + html + '</div>';
          }, function () { renderPreviewFallback('Word 文档解析失败', '预览失败'); });
        } catch (e) { renderPreviewFallback('Word 文档解析失败', '预览失败'); }
      };
      bridge.fetchBytes(pv.link);
    });
  }
  function renderPreviewXlsx(pv) {
    renderPreviewLoading('正在加载表格...');
    loadPvLib('XLSX', 'lib/xlsx.full.min.js', function (err) {
      if (state.preview !== pv) return;
      if (err || !window.XLSX) { renderPreviewFallback('表格渲染组件加载失败', '预览失败'); return; }
      if (!bridge || !bridge.fetchBytes) { renderPreviewFallback('当前版本不支持表格预览'); return; }
      window.__onFetchBytes = function (url, ok, b64, msg) {
        if (state.preview !== pv || url !== pv.link) return;
        if (!ok || !b64) { renderPreviewFallback(msg || '表格加载失败', '预览失败'); return; }
        renderPreviewLoading('正在解析表格...');
        try {
          var bin = atob(b64);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          var wb = XLSX.read(arr, { type: 'array' });
          if (!wb || !wb.SheetNames || !wb.SheetNames.length) { renderPreviewFallback('未能解析出表格内容', '预览失败'); return; }
          pv.xlsBook = wb;
          var tabs = '';
          wb.SheetNames.forEach(function (sn, i) {
            tabs += '<button class="pv-xls-tab' + (i === 0 ? ' active' : '') + '" data-i="' + i + '">' + esc(sn) + '</button>';
          });
          var box = pvBody();
          if (box) box.innerHTML = '<div class="pv-xls"><div class="pv-xls-tabs" id="pv-xls-tabs">' + tabs + '</div>'
            + '<div class="pv-xls-sheet" id="pv-xls-sheet"></div></div>';
          var tabBox = $('pv-xls-tabs');
          if (tabBox) {
            tabBox.addEventListener('click', function (e) {
              var t = e.target && e.target.closest ? e.target.closest('.pv-xls-tab') : null;
              if (!t) return;
              var idx = Number(t.getAttribute('data-i')) || 0;
              var all = tabBox.querySelectorAll('.pv-xls-tab');
              for (var j = 0; j < all.length; j++) {
                if (j === idx) all[j].classList.add('active');
                else all[j].classList.remove('active');
              }
              renderXlsSheet(pv, idx);
            });
          }
          renderXlsSheet(pv, 0);
        } catch (e) { renderPreviewFallback('表格解析失败', '预览失败'); }
      };
      bridge.fetchBytes(pv.link);
    });
  }
  function renderXlsSheet(pv, idx) {
    var sheetBox = $('pv-xls-sheet');
    if (!sheetBox || !pv.xlsBook) return;
    var ws = pv.xlsBook.Sheets[pv.xlsBook.SheetNames[idx]];
    var html = '';
    var truncated = false;
    try {
      var ref = ws && ws['!ref'];
      if (ref) {
        var rg = XLSX.utils.decode_range(ref);
        if (rg.e.r > 300 || rg.e.c > 40) {
          rg.e.r = Math.min(rg.e.r, 300);
          rg.e.c = Math.min(rg.e.c, 40);
          ws['!ref'] = XLSX.utils.encode_range(rg);
          truncated = true;
        }
      }
      html = XLSX.utils.sheet_to_html(ws, { editable: false });
    } catch (e) { html = ''; }
    if (!html) { sheetBox.innerHTML = '<div class="p-empty">该工作表为空</div>'; return; }
    var m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
    if (m) html = m[1];
    sheetBox.innerHTML = html + (truncated ? '<div class="pv-xls-note">数据较大，仅展示前 300 行 / 40 列</div>' : '');
    sheetBox.scrollTop = 0;
    sheetBox.scrollLeft = 0;
  }


  // 分享：弹出配置浮层（选有效期 + 提取码方式），确认后调用 123盘原生分享接口
  function doShare(item) {
    if (!item || !item.FileId) { toast('无法分享该对象'); return; }
    state.shareItem = item;                         // 记住当前要分享的对象
    // 每次打开配置弹窗时重置为默认（永久有效 + 随机提取码）
    var expireRadios = document.getElementsByName('sc-expire');
    for (var e = 0; e < expireRadios.length; e++) expireRadios[e].checked = (expireRadios[e].value === '4');
    var pwdRadios = document.getElementsByName('sc-pwd');
    for (var p = 0; p < pwdRadios.length; p++) pwdRadios[p].checked = (pwdRadios[p].value === '1');
    var inp = $('sc-pwd-input'); if (inp) inp.value = '';
    hide($('sc-custom'));
    show($('share-config-modal'));
  }
  // 根据有效期选项生成到期 ISO 时间字符串（东八区）
  function shareExpiration(expireValue) {
    if (expireValue == null || Number(expireValue) === 4) return '2099-12-12T08:00:00+08:00'; // 永久
    var hours = Number(expireValue) === 1 ? 24 : Number(expireValue) === 2 ? 168 : 720;   // 1天/7天/30天
    var now = Date.now();
    var d = new Date(now + hours * 3600 * 1000);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '+08:00';
  }
  // 直连分享：不调用官方分享接口，改用 download_info 获取下载直链直接分享（旧方案）
  // 说明：走 123pan 文件直链，无提取码、无需对方登录，链接通常有时效性；仅文件适用。
  function doShareDirect(item) {
    if (!item || !item.FileId) { toast('无法分享该对象'); return; }
    if (item.Type === 1) { toast('文件夹暂不支持直连分享，请改用官方方式'); return; }
    toast('正在获取直连链接...');
    api('POST', API.download, JSON.stringify(buildDownloadBody(item)), true, function (d) {
      if (!d || !d.data) {
        var msg = (d && (d.message || d.error)) || '获取直链失败';
        if (/size/i.test(msg)) msg = '获取直链失败：文件缺少大小信息，请刷新列表后重试';
        toast(msg);
        return;
      }
      var link = pickDownloadUrl(d);
      if (!link) { toast('暂无法获取直链，请刷新后重试'); return; }
      showShareModal(item.FileName || '直链', link, '');
    });
  }
  // 点击"创建分享"：读取配置并调用分享创建接口
  function doCreateShare() {
    var item = state.shareItem;
    if (!item) { hide($('share-config-modal')); return; }
    // 选择的有效期
    var expireVal = '4';
    var expireRadios = document.getElementsByName('sc-expire');
    for (var e = 0; e < expireRadios.length; e++) if (expireRadios[e].checked) { expireVal = expireRadios[e].value; break; }
    // 选择的提取码方式
    var pwdType = '1';
    var pwdRadios = document.getElementsByName('sc-pwd');
    for (var p = 0; p < pwdRadios.length; p++) if (pwdRadios[p].checked) { pwdType = pwdRadios[p].value; break; }
    // 直连分享：不调用官方分享接口，而是获取下载直链直接分享（旧方案）
    if (pwdType === '4') {
      hide($('share-config-modal'));
      doShareDirect(item);
      return;
    }
    // sharePwd：随机(1)时自动生成4位随机码；无提取码(2)时留空；自定义(3)时用用户输入
    var sharePwd = '';
    if (pwdType === '1') {
      // 随机提取码：前端自动生成4位随机码，按自定义模式提交
      var chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      for (var i = 0; i < 4; i++) sharePwd += chars.charAt(Math.floor(Math.random() * chars.length));
    } else if (pwdType === '3') {
      sharePwd = ($('sc-pwd-input') && $('sc-pwd-input').value || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(sharePwd)) { toast('请输入4位提取码（字母/数字）'); return; }
    }
    hide($('share-config-modal'));
    var shareBody = {
      driveId: 0,
      expiration: shareExpiration(expireVal),
      fileIdList: String(item.FileId),          // 123pan 分享接口要求逗号拼接的 fileId 字符串
      shareName: item.FileName || item.fileName || '分享',
      sharePwd: sharePwd,
      event: 'shareCreate',
      fileNum: 1,
      renameVisible: false,
      shareTypeValue: Number(pwdType === '1' ? 3 : pwdType),           // 随机模式改按自定义提交
      shareModality: Number(expireVal),          // 1=1天 2=7天 3=30天 4=永久
      operatePlace: 1,
      trafficSwitch: true
    };
    toast('正在创建分享...');
    api('POST', API.shareCreate, JSON.stringify(shareBody), true, function (d) {
      if (!d || d.code !== 0 || !d.data) {
        toast((d && (d.message || d.error)) || '创建分享失败');
        return;
      }
      var dt = d.data;
      // 随机/自定义提取码：sharePwd就是提取码
      var shareKey = dt.ShareKey || '';
      var key = shareKey, pwd = sharePwd || '';
      // 官方标准分享访问链接，若提供了 shareLinkList（实际可用域名）则优先
      var link = 'https://www.123pan.com/s/' + key;
      var sl = dt.shareLinkList;
      if (sl && sl.list && sl.list.length) { link = sl.list[0]; }
      else if (sl && sl.standBy) { link = sl.standBy; }
      // 无提取码(shareTypeValue=2)时不显示提取码
      var showPwd = !(pwdType === '2') && pwd;
      showShareModal(item.FileName || '分享', link, showPwd ? pwd : '');
    });
  }
  function showShareModal(title, link, pwd) {
    $('share-title').textContent = '分享 · ' + title;
    $('share-link').textContent = link;
    $('share-link').value = link;
    var pwdEl = $('share-pwd');
    var row = $('share-pwd-row');
    if (pwd) {
      pwdEl.textContent = pwd;
      if (row) row.style.display = '';
    } else {
      pwdEl.textContent = '';
      if (row) row.style.display = 'none';
    }
    show($('share-modal'));
  }
  // 复制分享链接到剪贴板
  function doCopyLink() {
    var link = $('share-link') && $('share-link').value;
    if (!link) { toast('无可复制链接'); return; }
    var pwdEl = $('share-pwd');
    var pwd = pwdEl ? String(pwdEl.textContent || '').trim() : '';
    if (pwd && link.indexOf('pwd=') < 0) {
      link += (link.indexOf('?') >= 0 ? '&' : '?') + 'pwd=' + pwd;
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = link; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast(pwd ? '链接已复制（含提取码）' : '链接已复制'); } catch (e) { toast('复制失败，请手动复制'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(function () { toast(pwd ? '链接已复制（含提取码）' : '链接已复制'); },
        function () { fallback(); });
    } else { fallback(); }
  }

  // 复制（"复制"操作）：进入抽屉展示链接并提示可复制，等价于分享的文件链接
  function doCopy(item) { doShare(item); }

  // 详情：显示文件大小/时间等元数据
  function doInfo(item) {
    var msg = (item.FileName || '') + '\n大小：' + fmtSize(item.Size) + '\n修改时间：' + (item.ModifyTime || '-');
    toast(msg);
  }

  // 新建文件夹
  function doNewFolder() {
    var name = $('newfolder-input').value.trim();
    if (!name) { toast('请输入文件夹名称'); return; }
    // 123pan 新建文件夹：POST /b/api/file/upload_request（注意必须 /b/ 前缀，/a/ 下网关无此路由会 404），type=1 表示文件夹，size=0。
    // 参数参考官方前端源码：event=newCreateFolder（C.JK.NewCreateFolder）标识"新建文件夹"操作、
    // operateType=2（C.I_.Move），缺失这两个字段会导致接口无法正确创建文件夹而失效。
    api('POST', API.mkdir,
      JSON.stringify({
        driveId: 0,
        etag: '',
        fileName: name,
        parentFileId: state.currentDir,
        size: 0,
        type: 1,
        duplicate: 1,
        NotReuse: true,
        event: 'newCreateFolder',
        operateType: '2'
      }),
      true,
      function (d) {
        if (d && d.code === 0) {
          hide($('newfolder-modal')); $('newfolder-input').value = '';
          toast('文件夹已创建'); loadList();
        } else {
          toast((d && d.message) || '创建失败');
        }
      });
  }

  // 上传入口：弹出方式选择（文件 / 文件夹，文件夹保留目录结构）
  function doUpload() {
    show($('upload-modal'));
  }
  // 选择单个/多个文件上传（原生接管文件选择并回传路径）
  function pickUploadFile() {
    hide($('upload-modal'));
    var inp = $('upload-input');
    if (!inp) return;
    toast('请选择要上传的文件');
    inp.click();
  }
  // 选择文件夹上传：由原生 SAF 目录树遍历并回传文件列表（保留目录结构）
  function pickUploadFolder() {
    hide($('upload-modal'));
    if (bridge && bridge.pickFolder) {
      toast('请选择要上传的文件夹');
      bridge.pickFolder();
    } else {
      toast('当前环境不支持文件夹上传');
    }
  }

  // 原生侧完成文件选择后回调：paths 为本地临时文件路径数组。
  // 流程：file/upload_request 获取预签名地址 -> 上传字节 -> 结束确认
  window.__onFilesPicked = function (paths) {
    if (!paths || !paths.length) return;
    var list = (typeof paths === 'string') ? JSON.parse(paths) : paths;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      doUploadOne(p);
    }
  };

  function doUploadOne(path) {
    if (!path) return;
    // 上传队列化：先入队，由调度器串行执行（统一进入传输页管理）
    enqueueUpload(path);
  }
  // ---------- 上传进度浮层 ----------
  function showUploadProgress(name, done, total) {
    var box = $('upload-progress');
    if (!box) return;
    if (Number(total) > 0) {
      // 进入实际上传（PUT）阶段：标题恢复为"上传中"，并更新进度条
      if ($('up-title')) $('up-title').textContent = '上传中';
      var pct = Math.min(100, Math.max(0, Math.round(Number(done) * 100 / Number(total))));
      if ($('up-name')) $('up-name').textContent = name;
      if ($('up-bar-fill')) $('up-bar-fill').style.width = pct + '%';
      if ($('up-pct')) $('up-pct').textContent = pct + '%';
    } else {
      // 初始阶段（读文件/获取上传任务）：显示"准备上传"，进度条 0%
      if ($('up-title')) $('up-title').textContent = '准备上传';
      if ($('up-name')) $('up-name').textContent = name;
      if ($('up-bar-fill')) $('up-bar-fill').style.width = '0%';
      if ($('up-pct')) $('up-pct').textContent = '0%';
    }
    show(box);
  }
  function hideUploadProgress() {
    var box = $('upload-progress');
    if (!box) return;
    hide(box);
    var fill = $('up-bar-fill');
    if (fill) fill.style.width = '0%';
  }
  // 断点续传回调：原生复用历史会话并从断点继续（done 为已跳过的字节数）
  window.__onUploadResume = function (taskId, done, total) {
    var t = null;
    (state.upQueue || []).forEach(function (x) { if (Number(x.id) === Number(taskId)) t = x; });
    if (!t || t.status === 'cancelled') return;
    t.done = Number(done) || 0;
    if (Number(total) > 0) t.total = Number(total);
    t._lastPct = -1;
    saveUpQueue();
    if (state.view === 'transfers') renderTransfers();
    showUploadProgress(t.name, t.done, t.total);
    if (!t._resumeToasted) {
      t._resumeToasted = true;
      var pct = t.total > 0 ? Math.floor(t.done * 100 / t.total) : 0;
      toast('已从断点继续上传：' + (t.name || '') + '（已完成 ' + pct + '%）');
    }
  };
  // 上传进度回调（原生任务 id 维度；节流：进度百分比变化才重绘）
  window.__onUploadProgress = function (taskId, done, total) {
    var t = null;
    (state.upQueue || []).forEach(function (x) { if (Number(x.id) === Number(taskId)) t = x; });
    if (!t || t.status === 'cancelled') return;
    t.done = Number(done) || 0;
    if (Number(total) > 0) t.total = Number(total);
    var pct = t.total > 0 ? Math.floor(t.done * 100 / t.total) : 0;
    if (t._lastPct === pct) return;
    t._lastPct = pct;
    saveUpQueue();
    if (state.view === 'transfers') renderTransfers();
    showUploadProgress(t.name, t.done, t.total);
  };
  // 上传结果回调（成功 / 失败 / 取消 统一收口）
  window.__onUploadResult = function (taskId, ok, msg) {
    var t = null;
    (state.upQueue || []).forEach(function (x) { if (Number(x.id) === Number(taskId)) t = x; });
    if (t) {
      if (t.status !== 'cancelled') {
        if (ok) {
          t.status = 'done';
          t.done = t.total || t.done;
          if (t.total <= 0) t.total = t.done;
          toast('上传成功：' + (t.name || ''));
          if (state.view === 'files') loadList();
        } else {
          t.status = 'failed';
          t.failMsg = msg || '上传失败';
          toast('上传失败：' + (t.name || '') + (msg ? '（' + msg + '）' : ''));
        }
      }
      saveUpQueue();
      if (state.view === 'transfers') renderTransfers();
    }
    // 队列中已无上传中任务：隐藏进度浮层
    var busy = false;
    (state.upQueue || []).forEach(function (x) { if (x.status === 'uploading') busy = true; });
    if (!busy) hideUploadProgress();
    scheduleNextUpload();
  };

  // 文件夹上传：原生遍历所选目录后回传 [{rel,name,path,size}]（rel 含所选根目录名，保持层级）
  // 流程：逐层创建云端目录（获取 fileId）→ 全部文件按目标目录入队上传
  window.__onFolderPicked = function (files) {
    var list = (typeof files === 'string') ? JSON.parse(files) : files;
    if (!list || !list.length) { toast('所选文件夹为空或读取失败'); return; }
    var dirs = {};
    list.forEach(function (f) {
      var rel = f.rel || '';
      var idx = rel.lastIndexOf('/');
      if (idx > 0) {
        var segs = rel.substring(0, idx).split('/');
        var acc = '';
        segs.forEach(function (s) {
          if (!s) return;
          acc = acc ? acc + '/' + s : s;
          dirs[acc] = true;
        });
      }
    });
    var dirArr = Object.keys(dirs);
    dirArr.sort(function (a, b) { return a.split('/').length - b.split('/').length; });
    var map = {};
    map[''] = state.currentDir;
    var di = 0;
    function nextDir() {
      if (di >= dirArr.length) { enqueueFolderFiles(list, map); return; }
      var rel = dirArr[di];
      var segs = rel.split('/');
      var dirName = segs[segs.length - 1];
      var parentRel = segs.length > 1 ? segs.slice(0, -1).join('/') : '';
      var parentId = map[parentRel];
      if (!(parentId >= 0)) { map[rel] = -1; di++; nextDir(); return; }
      ensureFolder(parentId, dirName, function (fid) {
        map[rel] = fid;
        di++;
        nextDir();
      });
    }
    nextDir();
  };
  // 文件夹内的文件全部入队（目录创建失败的降级放置到当前目录）
  function enqueueFolderFiles(list, map) {
    if (!state.upQueue) state.upQueue = [];
    var ok = 0, miss = 0;
    list.forEach(function (f) {
      var rel = f.rel || '';
      var idx = rel.lastIndexOf('/');
      var parentRel = idx > 0 ? rel.substring(0, idx) : '';
      var pid = map[parentRel];
      if (!(pid >= 0)) { pid = state.currentDir; miss++; }
      state.upQueue.push({ id: -1, name: f.name || rel.split('/').pop(), path: f.path, parentId: pid, size: f.size || 0, done: 0, total: 0, status: 'waiting', failMsg: '', time: Date.now() });
      ok++;
    });
    saveUpQueue();
    toast('文件夹已加入上传队列（' + ok + '个文件' + (miss > 0 ? '；' + miss + '个文件因目录创建失败放至当前目录' : '') + '）');
    scheduleNextUpload();
    if (state.view === 'transfers') renderTransfers();
  }
  // 在 parentId 下确保存在名为 name 的文件夹：先尝试创建；已存在则查询列表复用
  function ensureFolder(parentId, name, cb) {
    var body = JSON.stringify({
      driveId: 0, etag: '', fileName: name, parentFileId: parentId, size: 0,
      type: 1, duplicate: 1, NotReuse: true, event: 'newCreateFolder', operateType: 1
    });
    api('POST', API.mkdir, body, true, function (d) {
      var fid = -1;
      if (d && d.code === 0 && d.data) {
        var info = d.data.Info || d.data.info;
        if (info) fid = Number(info.FileId || info.fileId || -1);
        if (!(fid >= 0)) fid = Number(d.data.fileId || d.data.FileId || -1);
      }
      if (fid >= 0) { cb(fid); return; }
      // 创建失败或未返回 id（可能同名已存在）：查询父目录列表复用
      listFolder(parentId, function (items) {
        var hit = -1;
        (items || []).forEach(function (it) {
          if (it && Number(it.Type) === 1 && it.FileName === name) hit = Number(it.FileId);
        });
        cb(hit >= 0 ? hit : -1);
      });
    });
  }
  // 查询某目录下的列表（用于复用已存在文件夹）
  function listFolder(parentId, cb) {
    var params = 'driveId=0&limit=200&next=0&orderBy=file_name&orderDirection=asc'
      + '&parentFileId=' + parentId + '&trashed=false&Page=1&OnlyLookAbnormalFile=0';
    api('GET', API.list + '?' + params, '', true, function (d) {
      var items = [];
      if (d && d.data && d.data.InfoList) items = d.data.InfoList;
      cb(items);
    });
  }
  // ---------- 分享管理（我的分享 / 接收分享 / 转存） ----------
  // 分享接口域候选：优先项目主域，异常时自动切换官方域
  var SHARE_DOMAINS = ['https://api.123pan.cn', 'https://yun.123pan.com'];
  var shareState = null; // 接收分享浏览状态 {key,pwd,level,parentId,stack,list,sel}
  // ---- crc32 + 签名（123 web 端接口签名：参数名=timeSign，值=timestamp-random-dataSign）----
  var _crcTable = (function () {
    var t = [], n, c, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) { c = (c & 1) ? ((0xEDB88320 ^ (c >>> 1)) >>> 0) : (c >>> 1); }
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32Str(str) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < str.length; i++) {
      c = ((c >>> 8) ^ _crcTable[(c ^ str.charCodeAt(i)) & 0xFF]) >>> 0;
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function signPath(path) {
    var table = 'adefghlmyijnopkqrstubcvwsz';
    var random = String(Math.round(1e7 * Math.random()));
    var nowMs = Date.now();
    var timestamp = String(Math.floor(nowMs / 1000));
    var cst = new Date(nowMs + 8 * 3600 * 1000);
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    var nowStr = '' + cst.getUTCFullYear() + p2(cst.getUTCMonth() + 1) + p2(cst.getUTCDate())
      + p2(cst.getUTCHours()) + p2(cst.getUTCMinutes());
    var mapped = '';
    for (var i = 0; i < nowStr.length; i++) { mapped += table.charAt(nowStr.charCodeAt(i) - 48); }
    var timeSign = String(crc32Str(mapped));
    var data = [timestamp, random, path, 'web', '3', timeSign].join('|');
    var dataSign = String(crc32Str(data));
    return { k: timeSign, v: [timestamp, random, dataSign].join('-') };
  }
  function withSign(pathWithQuery) {
    var idx = pathWithQuery.indexOf('?');
    var path = idx >= 0 ? pathWithQuery.slice(0, idx) : pathWithQuery;
    var s = signPath(path);
    return pathWithQuery + (idx >= 0 ? '&' : '?') + s.k + '=' + s.v;
  }
  // 多域名容错请求：拿到含 code 字段的 JSON 即视为到达服务端；否则尝试下一个域名
  function shareApi(method, path, body, needSign, cb) {
    var i = 0;
    function attempt() {
      if (i >= SHARE_DOMAINS.length) { cb({ code: -1, message: '网络请求失败，请检查网络后重试' }); return; }
      var base = SHARE_DOMAINS[i++];
      var p = needSign ? withSign(path) : path;
      api(method, base + p, body || '', true, function (d) {
        if (d && typeof d.code !== 'undefined') { cb(d); } else { attempt(); }
      });
    }
    attempt();
  }
  // 通用复制文本（含旧内核兜底）
  function copyText(text, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast(okMsg || '已复制'); } catch (e) { toast('复制失败，请手动复制'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg || '已复制'); }, function () { fallback(); });
    } else { fallback(); }
  }
  // ---- 我的分享 ----
  function openMyShares() {
    var box = $('shares-list');
    if (box) box.innerHTML = '<div class="loading-dot">加载中...</div>';
    show($('page-shares'));
    shareApi('GET', '/b/api/share/list?driveId=0&limit=500&next=0&orderBy=fileId&orderDirection=desc&event=shareListFile&operateType=1', '', false, function (d) {
      if (d && d.code === 0 && d.data) {
        renderSharesList(d.data.InfoList || []);
      } else {
        if (box) box.innerHTML = '<div class="p-empty">加载失败：' + esc((d && d.message) || '未知错误') + '</div>';
      }
    });
  }
  function renderSharesList(list) {
    var box = $('shares-list');
    if (!box) return;
    if (!list.length) { box.innerHTML = '<div class="p-empty">暂无分享记录</div>'; return; }
    var html = '';
    list.forEach(function (it, i) {
      var name = it.shareName || it.ShareName || '未命名分享';
      var exp = it.expiration || it.Expiration || '';
      var status = (it.shareStatus === undefined || it.shareStatus === 0 || it.shareStatus === '0') ? '' : '已失效';
      var sub = (exp ? ('有效期至 ' + fmtTime(exp)) : '永久有效') + (status ? (' · ' + status) : '');
      html += '<div class="share-item">'
        + '<div class="share-item-info">'
        + '<div class="share-item-name">' + esc(name) + '</div>'
        + '<div class="share-item-sub">' + esc(sub) + '</div>'
        + '</div>'
        + '<div class="share-item-btns">'
        + '<button class="mini-btn" data-act="copy" data-i="' + i + '">复制链接</button>'
        + '<button class="mini-btn danger" data-act="cancel" data-i="' + i + '">取消分享</button>'
        + '</div>'
        + '</div>';
    });
    box.innerHTML = html;
    box.onclick = function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!t) return;
      var i = Number(t.getAttribute('data-i'));
      var it = list[i]; if (!it) return;
      var act = t.getAttribute('data-act');
      if (act === 'copy') {
        var key = it.ShareKey || it.shareKey || it.Key || it.key || '';
        var pwd = it.SharePwd || it.sharePwd || '';
        var url = '';
        // 优先从 shareLinkList 取真实分享域名链接
        if (it.shareLinkList && Array.isArray(it.shareLinkList) && it.shareLinkList.length) {
          url = it.shareLinkList[0] || '';
        }
        if (!url) url = it.ShareUrl || it.shareUrl || it.ShareLink || it.shareLink || '';
        if (!url && key) url = 'https://www.123pan.com/s/' + key;
        if (url && pwd && url.indexOf('pwd=') < 0) {
          url += (url.indexOf('?') >= 0 ? '&' : '?') + 'pwd=' + pwd;
        }
        if (!url) { toast('该分享无可用链接'); return; }
        copyText(url, '分享链接已复制');
        setTimeout(function () { toast('链接: ' + url); }, 300);
      } else if (act === 'cancel') {
        doCancelShare(it);
      }
    };
  }
  function doCancelShare(it) {
    var name = it.shareName || it.ShareName || '该分享';
    showConfirm('确认取消分享「' + name + '」？取消后链接将立即失效。', function () {
      var sid = it.shareId || it.ShareId;
      var body = JSON.stringify({
        driveId: 0,
        shareInfoList: [{ shareId: sid }],
        isPayShare: 0,
        event: 'shareCancel',
        operatePlace: 2
      });
      shareApi('POST', '/b/api/share/delete', body, false, function (d) {
        if (d && d.code === 0) {
          toast('已取消分享');
          openMyShares();
        } else {
          toast('取消失败：' + ((d && d.message) || '未知错误'));
        }
      });
    });
  }
  // ---- 接收分享 ----
  function parseShareKey(input) {
    input = String(input || '').trim();
    if (!input) return null;
    var key = '', pwd = '', m, fromUrl = false;
    m = input.match(/[?&#](?:pwd|Pwd|p)=([A-Za-z0-9]{1,16})/);
    if (m) pwd = m[1];
    // 支持旧格式 /s/KEY、新格式 /123/KEY、/123pan/KEY
    m = input.match(/\/(?:s|123|123pan)\/([A-Za-z0-9_-]+)/);
    if (m) { key = m[1]; fromUrl = true; }
    else {
      m = input.match(/([A-Za-z0-9]{4,})(?:-([A-Za-z0-9]{1,16}))?$/);
      if (m) { key = m[1]; if (m[2] && !pwd) pwd = m[2]; }
    }
    if (!key) return null;
    // 只有纯输入（非URL匹配）才拆分 - 作为提取码；URL匹配到的key完整保留
    if (!fromUrl) {
      var dash = key.indexOf('-');
      if (dash >= 0) { if (!pwd) pwd = key.slice(dash + 1); key = key.slice(0, dash); }
    }
    return { key: key, pwd: pwd };
  }
  function openReceiveShare() {
    if (!shareState) shareState = { key: '', pwd: '', level: 1, parentId: '0', stack: [], list: [], sel: {} };
    shareState.key = ''; shareState.stack = []; shareState.list = []; shareState.sel = {};
    var box = $('receive-list');
    if (box) box.innerHTML = '<div class="p-empty">输入分享链接并打开后，可浏览与转存</div>';
    var crumbs = $('receive-crumbs');
    if (crumbs) { crumbs.classList.add('hidden'); crumbs.innerHTML = ''; }
    var tip = $('receive-tip');
    if (tip) {
      tip.textContent = '转存目标：' + (state.breadcrumb && state.breadcrumb.length ? state.breadcrumb[state.breadcrumb.length - 1].name : '我的网盘根目录')
        + '（如需更换目标目录，请先在文件页进入对应文件夹）';
    }
    updateReceiveBar();
    show($('page-receive'));
  }
  function doOpenReceiveShare() {
    var parsed = parseShareKey($('receive-link') ? $('receive-link').value : '');
    if (!parsed || !parsed.key) { toast('请输入有效的分享链接或分享码'); return; }
    if (!shareState) shareState = { key: '', pwd: '', level: 1, parentId: '0', stack: [], list: [], sel: {} };
    shareState.key = parsed.key;
    var manualPwd = $('receive-pwd') ? String($('receive-pwd').value || '').trim() : '';
    shareState.pwd = manualPwd || parsed.pwd || '';
    shareState.stack = [];
    shareState.sel = {};
    loadShareDir('0', 1);
  }
  // ---- 直链解析 ----
  var dlState = { key: '', pwd: '', list: [] };
  function openDirectLink() {
    dlState.key = ''; dlState.list = [];
    var box = $('dl-list');
    if (box) box.innerHTML = '';
    show($('page-directlink'));
  }
  function doOpenDirectLink() {
    var parsed = parseShareKey($('dl-link') ? $('dl-link').value : '');
    if (!parsed || !parsed.key) { toast('请输入有效的分享链接或分享码'); return; }
    dlState.key = parsed.key;
    var manualPwd = $('dl-pwd') ? String($('dl-pwd').value || '').trim() : '';
    dlState.pwd = manualPwd || parsed.pwd || '';
    loadDlList();
  }
  function loadDlList() {
    var box = $('dl-list');
    if (box) box.innerHTML = '<div class="loading-dot">加载中...</div>';
    var path = '/b/api/share/get?ShareKey=' + encodeURIComponent(dlState.key)
      + '&SharePwd=' + encodeURIComponent(dlState.pwd)
      + '&parentFileId=0&Page=1&limit=200&next=0&orderBy=file_name&orderDirection=asc&event=homeListFile';
    shareApi('GET', path, '', true, function (d) {
      if (d && d.code === 0 && d.data) {
        dlState.list = d.data.InfoList || [];
        renderDlList();
      } else {
        if (box) box.innerHTML = '<div class="p-empty">解析失败：' + esc((d && d.message) || '分享不存在或提取码错误') + '</div>';
      }
    });
  }
  function renderDlList() {
    var box = $('dl-list');
    if (!box) return;
    if (!dlState.list.length) { box.innerHTML = '<div class="p-empty">分享中无文件</div>'; return; }
    box.innerHTML = '';
    dlState.list.forEach(function (it) {
      var isDir = (it.Type === 1);
      var row = document.createElement('div');
      row.className = 'rc-row';
      var iconCls = isDir ? 'folder' : 'file';
      row.innerHTML = '<div class="rc-ic" style="color:var(--accent)"><span class="file-icon" data-icon="' + iconCls + '"></span></div>'
        + '<div class="rc-info"><div class="rc-name">' + esc(it.FileName || '') + '</div>'
        + '<div class="rc-meta">' + (isDir ? '文件夹' : fmtSize(it.Size || it.FileSize || 0)) + '</div></div>'
        + '<div class="rc-enter">›</div>';
      row.addEventListener('click', function () {
        if (isDir) loadDlDir(it.FileId || it.fileId);
        else getDirectUrl(it);
      });
      box.appendChild(row);
    });
    injectIcons(box);
  }
  function loadDlDir(parentId) {
    var box = $('dl-list');
    if (box) box.innerHTML = '<div class="loading-dot">加载中...</div>';
    var path = '/b/api/share/get?ShareKey=' + encodeURIComponent(dlState.key)
      + '&SharePwd=' + encodeURIComponent(dlState.pwd)
      + '&parentFileId=' + encodeURIComponent(parentId)
      + '&Page=1&limit=200&next=0&orderBy=file_name&orderDirection=asc&event=homeListFile';
    shareApi('GET', path, '', true, function (d) {
      if (d && d.code === 0 && d.data) {
        dlState.list = d.data.InfoList || [];
        renderDlList();
      } else {
        if (box) box.innerHTML = '<div class="p-empty">加载失败：' + esc((d && d.message) || '') + '</div>';
      }
    });
  }
  function getDirectUrl(it) {
    var box = $('dl-list');
    if (box) box.innerHTML = '<div class="loading-dot">正在获取直链...</div>';
    var sz = Number(it.Size) || Number(it.FileSize) || Number(it.size) || 0;
    var body = JSON.stringify({
      ShareKey: dlState.key,
      SharePwd: dlState.pwd,
      FileId: it.FileId || it.fileId,
      S3KeyFlag: it.S3KeyFlag || it.s3KeyFlag || '',
      Etag: it.Etag || it.etag || '',
      FileName: it.FileName || it.fileName || '',
      FileNameType: it.Type !== undefined ? it.Type : 0,
      Size: sz,
      size: sz,
      driveId: 0,
      type: 'download'
    });
    shareApi('POST', '/b/api/share/download/info', body, true, function (d) {
      loadDlList();
      if (d && d.code === 0 && d.data) {
        var url = d.data.DownloadUrl || d.data.downloadUrl || d.data.DownloadURL || d.data.url || '';
        if (!url) { toast('未获取到直链地址'); return; }
        $('dl-filename').textContent = it.FileName || it.fileName || '';
        $('dl-url-box').textContent = url;
        showDlQR(url);
        show($('dl-result-modal'));
      } else {
        toast((d && d.message) || '获取直链失败，可能该文件不支持分享下载');
      }
    });
  }
  function showDlQR(text) {
    var wrap = $('dl-qr-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    // 用在线二维码API生成HTTP URL图片，方便直接下载
    var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=' + encodeURIComponent(text);
    var img = document.createElement('img');
    img.src = qrUrl;
    img.style.cssText = 'width:180px;height:180px;';
    wrap.appendChild(img);
    // 保存当前QR URL供下载用
    wrap.dataset.qrUrl = qrUrl;
  }
  function loadShareDir(parentId, level) {
    var box = $('receive-list');
    if (box) box.innerHTML = '<div class="loading-dot">加载中...</div>';
    var path = '/b/api/share/get?ShareKey=' + encodeURIComponent(shareState.key)
      + '&SharePwd=' + encodeURIComponent(shareState.pwd)
      + '&parentFileId=' + encodeURIComponent(parentId)
      + '&Page=1&limit=200&next=0&orderBy=file_name&orderDirection=asc&event=homeListFile';
    shareApi('GET', path, '', true, function (d) {
      if (d && d.code === 0 && d.data) {
        shareState.parentId = parentId;
        shareState.level = level;
        shareState.list = d.data.InfoList || [];
        renderReceiveList();
      } else {
        if (box) box.innerHTML = '<div class="p-empty">打开失败：' + esc((d && d.message) || '分享不存在、已失效或提取码错误') + '</div>';
      }
    });
  }
  function enterShareDir(it) {
    var fid = it.FileId || it.fileId;
    shareState.stack.push({ id: fid, name: it.FileName || '' });
    loadShareDir(fid, shareState.level + 1);
  }
  function backShareDir() {
    if (!shareState || !shareState.stack.length) return;
    shareState.stack.pop();
    var parent = shareState.stack.length ? shareState.stack[shareState.stack.length - 1].id : '0';
    loadShareDir(parent, shareState.stack.length + 1);
  }
  function toggleShareSel(it) {
    if (!shareState) return;
    if (!shareState.sel) shareState.sel = {};
    var fid = it.FileId || it.fileId;
    if (fid == null) return;
    if (shareState.sel[fid]) { delete shareState.sel[fid]; }
    else { shareState.sel[fid] = it; }
    renderReceiveList();
  }
  function updateReceiveBar() {
    var bar = $('receive-bar');
    if (!bar) return;
    var isRoot = shareState && shareState.key && shareState.stack.length === 0;
    if (!isRoot) { hide(bar); return; }
    var cnt = shareState.sel ? Object.keys(shareState.sel).length : 0;
    var info = $('receive-selinfo');
    if (info) info.textContent = '已选 ' + cnt + ' 项';
    var btn = $('receive-save');
    if (btn) btn.classList.toggle('disabled', cnt === 0);
    show(bar);
  }
  function renderReceiveList() {
    if (!shareState) return;
    var box = $('receive-list');
    if (!box) return;
    var list = shareState.list || [];
    var isRoot = shareState.stack.length === 0;
    var crumbs = $('receive-crumbs');
    if (crumbs) {
      if (!isRoot) {
        var parentName = shareState.stack.length > 1 ? shareState.stack[shareState.stack.length - 2].name : '分享根目录';
        crumbs.innerHTML = '<span class="rc-back" id="rc-up">‹ 返回 ' + esc(parentName) + '</span>';
        crumbs.classList.remove('hidden');
        var up = $('rc-up');
        if (up) up.addEventListener('click', backShareDir);
      } else {
        crumbs.classList.add('hidden');
        crumbs.innerHTML = '';
      }
    }
    if (!list.length) {
      box.innerHTML = '<div class="p-empty">此目录为空</div>';
      updateReceiveBar();
      return;
    }
    var html = '';
    list.forEach(function (it, i) {
      var isFolder = Number(it.Type) === 1;
      var fid = it.FileId || it.fileId;
      var sel = isRoot && shareState.sel && shareState.sel[fid];
      html += '<div class="rc-row" data-i="' + i + '">'
        + (isRoot ? '<span class="rc-ck' + (sel ? ' checked' : '') + '"></span>' : '')
        + '<span class="rc-ic" data-icon="' + (isFolder ? 'folder' : iconForName(it.FileName)) + '"></span>'
        + '<div class="rc-info"><div class="rc-name">' + esc(it.FileName || '') + '</div>'
        + '<div class="rc-meta">' + (isFolder ? '文件夹' : fmtSize(it.Size)) + '</div></div>'
        + (isFolder ? '<span class="rc-enter" data-enter="1">›</span>' : '')
        + '</div>';
    });
    box.innerHTML = html;
    injectIcons(box);
    box.querySelectorAll('.rc-row').forEach(function (row) {
      row.addEventListener('click', function (e) {
        var i = Number(row.getAttribute('data-i'));
        var it = list[i]; if (!it) return;
        var isFolder = Number(it.Type) === 1;
        var onEnter = e.target && e.target.getAttribute && e.target.getAttribute('data-enter');
        if (onEnter) { enterShareDir(it); return; }
        if (isRoot) { toggleShareSel(it); return; }
        if (isFolder) { enterShareDir(it); }
      });
    });
    updateReceiveBar();
  }
  function doSaveSelectedShare() {
    if (!shareState || !shareState.sel) return;
    var keys = Object.keys(shareState.sel);
    if (!keys.length) { toast('请先勾选要转存的内容'); return; }
    var target = state.currentDir || 0;
    var body = JSON.stringify({
      share_key: shareState.key,
      share_pwd: shareState.pwd,
      current_level: 1,
      event: 'transfer',
      file_list: keys.map(function (k) {
        var it = shareState.sel[k];
        return {
          file_id: it.FileId || it.fileId,
          file_name: it.FileName || it.fileName || '',
          etag: it.Etag || it.etag || '',
          size: Number(it.Size || it.size || 0),
          parent_file_id: target,
          drive_id: 0,
          type: Number(it.Type || 0)
        };
      })
    });
    toast('正在提交转存...');
    shareApi('POST', '/b/api/file/copy/async', body, true, function (d) {
      if (d && d.code === 0) {
        toast('已提交转存，稍后可在网盘查看');
        hide($('page-receive'));
        if (state.view === 'files') loadList();
      } else {
        toast('转存失败：' + ((d && d.message) || '未知错误'));
      }
    });
  }
  // ---------- 自动更新 ----------
  function renderAutoUpdate() {
    var el = $('upd-switch');
    if (el) el.classList.toggle('on', !!state.autoUpdate);
  }
  // ---------- 屏幕常亮 ----------
  function applyKeepScreenOn() {
    var on = !!(state.keepScreenOn || state.transferKeepWake);
    try { if (bridge && bridge.setKeepScreenOn) bridge.setKeepScreenOn(on); } catch (e) {}
  }
  function renderKeepScreenOn() {
    var el = $('keep-switch');
    if (el) el.classList.toggle('on', !!state.keepScreenOn);
    applyKeepScreenOn();
  }
  function onToggleKeepScreenOn() {
    state.keepScreenOn = !state.keepScreenOn;
    try { localStorage.setItem('pan_keep_screen', state.keepScreenOn ? '1' : '0'); } catch (e) {}
    renderKeepScreenOn();
    toast(state.keepScreenOn ? '屏幕常亮已开启' : '屏幕常亮已关闭');
  }
  // 传输进行中自动保持屏幕常亮
  function refreshTransferKeepWake() {
    var active = false;
    try {
      // 下载任务
      if (bridge && bridge.queryDownloads) {
        var dl = JSON.parse(bridge.queryDownloads() || '[]');
        for (var j = 0; j < dl.length; j++) {
          var st = Number(dl[j].status);
          if (isNaN(st)) continue;
          if (st !== 8 && st !== 16 && st !== 0) { active = true; break; }
        }
      }
      if (!active && bridge && bridge.streamingTasks) {
        var st2 = JSON.parse(bridge.streamingTasks() || '[]');
        for (var k = 0; k < st2.length; k++) { active = true; break; }
      }
      // 上传任务
      if (!active && state.upQueue && state.upQueue.length) {
        for (var u = 0; u < state.upQueue.length; u++) {
          var ut = state.upQueue[u];
          if (ut && !ut.done && ut.status !== 2 && ut.status !== 3) { active = true; break; }
        }
      }
    } catch (e) {}
    if (active !== state.transferKeepWake) {
      state.transferKeepWake = active;
      applyKeepScreenOn();
    }
  }
  // ---------- 主题模式 ----------
  function systemDark() {
    try { if (bridge && bridge.isSystemDark) return !!bridge.isSystemDark(); } catch (e) {}
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function applyTheme() {
    var m = state.themeMode || 'auto';
    var dark = (m === 'dark') || (m === 'auto' && systemDark());
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }
  function renderTheme() {
    var labels = { auto: '跟随系统', light: '白天模式', dark: '夜间模式' };
    var el = $('theme-val');
    if (el) el.textContent = labels[state.themeMode] || '跟随系统';
    applyTheme();
  }
  function onChangeTheme() {
    var cur = state.themeMode || 'auto';
    var items = [
      { label: '跟随系统', fn: function () { state.themeMode = 'auto'; saveTheme(); closeSheet(); } },
      { label: '白天模式', fn: function () { state.themeMode = 'light'; saveTheme(); closeSheet(); } },
      { label: '夜间模式', fn: function () { state.themeMode = 'dark'; saveTheme(); closeSheet(); } }
    ];
    // 默认高亮当前
    var grid = $('sheet-grid');
    grid.innerHTML = '';
    $('sheet-title').textContent = '选择主题模式';
    items.forEach(function (it) {
      var el = document.createElement('div');
      el.className = 'sheet-grid-item' + (cur === (it.label === '跟随系统' ? 'auto' : it.label === '白天模式' ? 'light' : 'dark') ? ' primary' : '');
      var ic = document.createElement('div'); ic.className = 'sgi-icon';
      ic.textContent = it.label;
      el.appendChild(ic);
      el.title = it.label;
      el.addEventListener('click', it.fn);
      grid.appendChild(el);
    });
    grid.style.gridTemplateColumns = 'repeat(3,1fr)';
    show($('action-sheet'));
  }
  function saveTheme() {
    try { localStorage.setItem('pan_theme', state.themeMode); } catch (e) {}
    renderTheme();
  }
  // 跟随系统变化
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (state.themeMode === 'auto') applyTheme();
    });
  }

  // ---------- 下载目录 ----------
  function renderDownloadDir() {
    var el = $('mine-dir-val');
    if (el) {
      var cur = '123云盘';
      try { if (bridge && bridge.getDownloadSubDir) cur = bridge.getDownloadSubDir() || cur; } catch (e) {}
      el.textContent = 'Download/' + cur;
    }
  }
  function onChangeDownloadDir() {
    // 调原生目录选择器（SAF）
    try {
      if (bridge && bridge.pickDownloadDir) {
        bridge.pickDownloadDir();
      } else {
        // 回退到输入框
        var cur = '123云盘';
        try { cur = bridge.getDownloadSubDir() || cur; } catch (e) {}
        var val = prompt('输入下载子目录名（位于系统Download目录下）', cur);
        if (val === null) return;
        val = String(val).trim();
        if (!val) { toast('目录名不能为空'); return; }
        if (/[\/\\]/.test(val)) { toast('目录名不能包含斜杠'); return; }
        bridge.setDownloadSubDir(val);
        renderDownloadDir();
        toast('下载目录已改为 /Download/' + val);
      }
    } catch (e) { toast('选择目录失败：' + e.message); }
  }

  // ---------- 同名文件处理策略 ----------
  function getDupStrategy() {
    try { return localStorage.getItem('pan_dup') || 'rename'; } catch (e) { return 'rename'; }
  }
  function renderDupStrategy() {
    var m = { prompt: '每次提示', skip: '跳过', overwrite: '覆盖', rename: '保留两者' };
    var el = $('dup-val');
    if (el) el.textContent = m[getDupStrategy()] || '每次提示';
  }
  function onChangeDupStrategy() {
    var cur = getDupStrategy();
    var opts = [
      { v: 'prompt', label: '提示（每次弹窗）' },
      { v: 'skip', label: '跳过' },
      { v: 'overwrite', label: '覆盖' },
      { v: 'rename', label: '保留两者（自动更名）' }
    ];
    var grid = $('sheet-grid');
    grid.innerHTML = '';
    $('sheet-title').textContent = '同名文件处理策略';
    opts.forEach(function (o) {
      var el = document.createElement('div');
      el.className = 'sheet-grid-item' + (cur === o.v ? ' primary' : '');
      var ic = document.createElement('div'); ic.className = 'sgi-icon';
      ic.textContent = o.label;
      el.appendChild(ic);
      el.addEventListener('click', function () {
        try { localStorage.setItem('pan_dup', o.v); } catch (e) {}
        renderDupStrategy();
        closeSheet();
        toast('已设置：' + o.label);
      });
      grid.appendChild(el);
    });
    grid.style.gridTemplateColumns = 'repeat(2,1fr)';
    show($('action-sheet'));
  }

  // 下载目录选择回调（原生 SAF 选完后调用）
  window.__onDownloadDirPicked = function (name) {
    renderDownloadDir();
    toast('下载目录：Download/' + (name || ''));
  };

  function copyText(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    } catch (e) {}
  }

  //版本号归一化：dev-47 → 1.0.47；无法识别时原样返回
  function normVer(s) {
    s = String(s || '').trim();
    var m = s.match(/^dev-([0-9]+)$/);
    return m ? ('1.0.' + m[1]) : s;
  }
  //版本比较：a>b返回1；相等0；a<b返回-1
  function cmpVer(a, b) {
    var pa = String(a || '').match(/[0-9]+/g) || [];
    var pb = String(b || '').match(/[0-9]+/g) || [];
    var n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
      var x = parseInt(pa[i] || '0', 10);
      var y = parseInt(pb[i] || '0', 10);
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }
  var _upChecking = false; //检查请求进行中（防重入）
  var _upManual = false;   //本次是否手动检查（手动检查结束会有提示反馈）
  var _upTimer = null;     //安全兜底定时器
  function checkAppUpdate(manual) {
    if (_upChecking) return;
    if (!bridge || !bridge.checkUpdate) return;
    _upChecking = true;
    _upManual = !!manual;
    if (manual) toast('正在检查更新...');
    if (_upTimer) clearTimeout(_upTimer);
    _upTimer = setTimeout(function () { _upChecking = false; }, 20000);
    try { bridge.checkUpdate(); } catch (e) { _upChecking = false; if (manual) toast('检查更新失败'); }
  }
  function onToggleAutoUpdate() {
    state.autoUpdate = !state.autoUpdate;
    try { localStorage.setItem('pan_autoupdate', state.autoUpdate ? '1' : '0'); } catch (e) {}
    renderAutoUpdate();
    toast(state.autoUpdate ? '自动更新已开启' : '自动更新已关闭');
    if (state.autoUpdate) checkAppUpdate(true);
  }
  //更新弹窗：点下载按钮
  function onUpdGo() {
    hide($('update-modal'));
    var info = state.updateInfo || {};
    state.updateInfo = null;
    // 移除了 REQUEST_INSTALL_PACKAGES 权限以降低杀毒软件误报，
    // 改为直接用浏览器打开 Releases 页面手动下载安装。
    var releaseUrl = 'https://github.com/sillycats/123pan-mobile-app/releases/latest';
    if (bridge && bridge.openExternalWeb) {
      bridge.openExternalWeb(releaseUrl);
    } else {
      toast('请前往 GitHub Releases 页面手动下载更新');
    }
  }
  //原生回调：GitHub 最新 Release 信息
  window.__onUpdateCheck = function (info) {
    _upChecking = false;
    if (_upTimer) { clearTimeout(_upTimer); _upTimer = null; }
    var manual = _upManual;
    _upManual = false;
    if (!info || !info.ok) {
      if (manual) toast('检查更新失败，请稍后重试');
      return;
    }
    var cur = info.current || '';
    var cands = [];
    if (info.name && /[0-9]/.test(info.name)) cands.push(info.name);
    var nt = normVer(info.tag);
    if (nt && /[0-9]/.test(nt)) cands.push(nt);
    var latest = '';
    for (var i = 0; i < cands.length; i++) {
      if (!latest || cmpVer(cands[i], latest) > 0) latest = cands[i];
    }
    if (!latest || !cur || cmpVer(latest, cur) <= 0) {
      if (manual) toast('当前已是最新版本 v' + cur);
      return;
    }
    if (!state.autoUpdate && !manual) return; //启动检查时开关已被关闭：不打扰
    state.updateInfo = { version: latest, url: info.url || '', size: Number(info.size) || 0 };
    $('upd-message').textContent = '发现新版本 v' + latest + '（当前 v' + cur + '），是否下载安装包？';
    show($('update-modal'));
  };
  //启动后自动检查（每次进入软件时；受「我的-自动更新」开关控制）
  function scheduleUpdateBoot() {
    setTimeout(function () { if (state.autoUpdate) checkAppUpdate(false); }, 1800);
  }

  // ---------- 我的页 ----------
  function loadMine() {
    renderAccountList();
    updateCacheSize();
    renderAutoUpdate();
    renderKeepScreenOn();
    renderDownloadDir();
    renderTheme();
    api('GET', API.userInfo, '', true, function (d) {
      if (d && (d.data || d.Data)) {
        var u = d.data || d.Data;
        // 兼容：部分响应的用户信息嵌套在 user 对象中
        if (u.user && typeof u.user === 'object') u = u.user;
        // 123pan /b/api/user/info 真实字段：SpaceUsed（已用）、SpacePermanent（永久空间）、SpaceTemp（临时空间）
        var used = numOf(u, 'SpaceUsed', 'UsedSize', 'usedSize', 'space_used', 'used');
        var permanent = numOf(u, 'SpacePermanent', 'TotalSize', 'totalSize', 'space_total', 'total');
        var temp = numOf(u, 'SpaceTemp', 'freeSize', 'FreeSize', 'space_temp', 'free');
        // 总额 = 永久空间 + 临时空间；备用取 used + free
        var total = (permanent > 0 || temp > 0) ? (permanent + temp) : 0;
        if (!(total > 0)) total = used + (temp > 0 ? temp : 0);
        if (total > 0) {
          var usedV = used > 0 ? used : Math.max(0, total - temp);
          $('mine-quota-val').textContent =
            '已用 ' + fmtSize(usedV) + ' / 共 ' + fmtSize(total);
        } else {
          $('mine-quota-val').textContent = '容量不可用';
        }
      } else {
        $('mine-quota-val').textContent = '容量获取失败';
      }
    });
  }

  function doLogout() {
    showConfirm('确认退出当前账号？', function () {
      // 官方登录页方案：退出 = 清除本地会话 + 清官方域 cookie（sso-token）+ 回到官方登录页
      if (bridge && bridge.logout) {
        try { localStorage.setItem(ACCT_CUR, ''); } catch (e) {}
        bridge.logout();
      } else {
        // 兜底
        if (bridge.clearSession) bridge.clearSession();
        state.token = ''; state.user = '';
        toast('已退出登录');
        // 尝试回到官方登录页
        if (bridge && bridge.openOfficialLogin) bridge.openOfficialLogin();
        else { show($('page-login')); hide($('page-main')); }
      }
    });
  }

  // ---------- 多账号系统 ----------
  var ACCT_KEY = 'pan_accounts';
  var ACCT_CUR = 'pan_current_user';
  function loadAccounts() {
    try {
      var arr = JSON.parse(localStorage.getItem(ACCT_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveAccounts(list) {
    try { localStorage.setItem(ACCT_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function currentAccountUser() {
    try { return localStorage.getItem(ACCT_CUR) || ''; } catch (e) { return ''; }
  }
  function setCurrentAccountUser(u) {
    try { localStorage.setItem(ACCT_CUR, u || ''); } catch (e) {}
  }
  // 登录成功后加入账号列表（去重），并设为当前账号
  function addAccount(user, token, pass) {
    if (!user) return;
    var list = loadAccounts();
    var exists = false;
    list.forEach(function (a) {
      if (a.user === user) { a.token = token; a.pass = pass || a.pass; exists = true; }
    });
    if (!exists) list.unshift({ user: user, token: token, pass: pass || '' });
    saveAccounts(list);
    setCurrentAccountUser(user);
  }
  // 切换账号：用本地已保存的账号凭证（token）直接切换，无需重新登录。
  // 多账号系统设计：每个账号在首次登录时已将 token 存入 pan_accounts 列表，
  // 切换时直接取出目标账号 token 更新会话（前端 state + 原生 API 认证 token + 当前标记），
  // 并刷新文件列表到根目录。仅当目标账号缺少本地 token（异常/旧数据）才回退官方登录页重新登录。
  function switchAccount(user) {
    if (user === state.user) { toast('已是当前账号'); return; }
    var list = loadAccounts();
    var target = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].user === user) { target = list[i]; break; }
    }
    // 目标账号缺少本地凭证：回退官方登录页重新登录
    if (!target || !target.token) {
      toast('该账号缺少本地凭证，请在官方登录页重新登录');
      try { localStorage.setItem(ACCT_CUR, ''); } catch (e) {}
      openOfficialLogin();
      return;
    }
    // 直接用本地 token 切换（无网络 re-login）
    state.token = target.token;
    state.user = target.user;
    setCurrentAccountUser(user);
    try { if (bridge && bridge.saveSession) bridge.saveSession(target.token, user, target.pass || ''); } catch (e) {}
    // 重置到根目录并重新加载文件列表（使用新账号 token 发起 API 请求）
    state.currentDir = 0;
    state.breadcrumb = [];
    state.selectedMap = {};
    toast('已切换到「' + user + '」');
    enterMain();
    loadList();
  }
  // 删除账号
  function removeAccount(user) {
    var list = loadAccounts().filter(function (a) { return a.user !== user; });
    saveAccounts(list);
    var cur = currentAccountUser();
    if (cur === user) {
      setCurrentAccountUser('');
      // 官方登录页方案：删除当前账号后走官方登录页重新登录/登录其他账号
      if (list.length > 0) {
        toast('已删除账号「' + user + '」，请在弹出的官方登录页中登录其他账号');
        openOfficialLogin();
      } else {
        if (bridge && bridge.logout) bridge.logout();
        else { if (bridge.clearSession) bridge.clearSession(); state.token = ''; state.user = ''; show($('page-login')); hide($('page-main')); }
        toast('账号已删除');
      }
    } else {
      toast('账号已删除');
    }
    loadMine();
  }
  // 渲染"我的"页的账号管理。
  // 新布局：我的界面只显示【当前账号 + 展开按钮】；点击按钮打开覆盖式底部 sheet 弹层显示账号列表。
  // 弹层内只列【其他账号】+ 末尾"添加账号"按钮（不重复当前账号），且为覆盖层不占用"我的"页布局高度。
  function renderAccountList() {
    var box = $('account-list');
    if (!box) return;
    var list = loadAccounts();
    // 兼容：列表为空但当前已登录（升级前场景），把当前账号纳入列表
    if (list.length === 0 && state.token && state.user) {
      list = [{ user: state.user, token: state.token, pass: '' }];
      saveAccounts(list);
      setCurrentAccountUser(state.user);
    }
    var cur = currentAccountUser();
    if (list.length === 0) {
      box.innerHTML = ''
        + '<div class="acct-summary">'
        + '<div class="acct-avatar sm"><span class="mi-icon" data-icon="user"></span></div>'
        + '<div class="acct-info"><div class="acct-user">未登录账号</div>'
        + '<div class="acct-addline" data-add="1">添加账号</div></div>'
        + '<span class="acct-toggle"><span class="mi-icon" data-icon="plus"></span></span>'
        + '</div>';
      injectIcons(box);
      bindAccountList(box);
      return;
    }
    // 当前账号（用于折叠区展示）
    var curName = cur || state.user || list[0].user;
    var curAcct = null;
    for (var i = 0; i < list.length; i++) { if (list[i].user === curName) { curAcct = list[i]; break; } }
    if (!curAcct) curAcct = list[0];
    var cLetter = (curAcct.user.charAt(0) || '用').toUpperCase();

    var html = '';
    // ---- 折叠区：当前账号 + 展开按钮 ----
    html += '<div class="acct-summary" data-summary="1">'
      + '<div class="acct-avatar sm">' + esc(cLetter) + '</div>'
      + '<div class="acct-info">'
      + '<div class="acct-user">' + esc(curAcct.user) + '</div>'
      + '<div class="acct-meta"><span class="mi-icon" data-icon="check"></span>当前账号</div>'
      + '</div>'
      + '<span class="acct-toggle" data-toggle="1">'
      + '<span class="mi-icon" data-icon="chevron-down"></span>'
      + '</span>'
      + '</div>';

    // ---- 展开态：改为覆盖式底部 sheet 弹层（不占用"我的"页布局高度） ----
    // 折叠区仅展示当前账号+展开按钮；点击展开打开 #account-sheet 弹层，
    // 弹层内只列【其他账号】+ 末尾添加按钮，不重复显示当前账号。
    // 注：不再在页面内追加 .acct-list（避免撑高"我的"页）。

    box.innerHTML = html;
    if (cur === '' && list.length > 0) setCurrentAccountUser(list[0].user);
    // 注入折叠区动态图标（chevron/check 等）
    injectIcons(box);
    bindAccountList(box);
  }
  // 账号管理折叠区事件委托：点击当前账号行/展开按钮 → 打开账号列表弹层
  function bindAccountList(box) {
    box.onclick = function (e) {
      e.stopPropagation();
      var t = e.target && e.target.closest ? e.target.closest('[data-summary],[data-toggle],[data-add]') : null;
      if (!t) return;
      if (t.hasAttribute('data-summary') || t.hasAttribute('data-toggle')) { openAccountSheet(); return; }
      if (t.hasAttribute('data-add')) { openAddAccount(); return; }
    };
  }
  // 打开账号列表弹层（覆盖式底部 sheet）。列表只列其他账号 + 末尾添加按钮，不重复当前账号。
  function openAccountSheet() {
    var list = loadAccounts();
    var cur = currentAccountUser();
    var others = list.filter(function (a) { return a.user !== cur; });
    var box = $('account-sheet-list');
    if (!box) return;
    var html = '';
    if (others.length === 0) {
      html += '<div class="acct-empty">暂无其他账号</div>';
    } else {
      others.forEach(function (a) {
        var name = a.user || '';
        var letter = (name.charAt(0) || '用').toUpperCase();
        html += '<div class="acct-item" data-user="' + esc(name) + '">'
          + '<div class="acct-avatar xs">' + esc(letter) + '</div>'
          + '<div class="acct-info">'
          + '<div class="acct-user">' + esc(name) + '</div>'
          + '<span class="acct-meta">点击切换</span>'
          + '</div>'
          + '<span class="acct-goto"><span class="mi-icon" data-icon="chevron-right"></span></span>'
          + '</div>';
      });
    }
    // 列表末尾：添加账号按钮
    html += '<div class="acct-item add" data-add="1">'
      + '<span class="acct-plus"><span class="mi-icon" data-icon="plus"></span></span>'
      + '<div class="acct-info"><div class="acct-user">添加账号</div></div>'
      + '</div>';
    box.innerHTML = html;
    injectIcons(box);
    // 弹层内事件委托：账号条目 → 操作菜单；添加按钮 → 添加账号
    box.onclick = function (e) {
      e.stopPropagation();
      var t = e.target && e.target.closest ? e.target.closest('[data-add],[data-user]') : null;
      if (!t) return;
      var self = this;
      if (t.hasAttribute('data-add')) { hide($('account-sheet')); openAddAccount(); return; }
      if (t.hasAttribute('data-user')) {
        var u = t.getAttribute('data-user');
        hide($('account-sheet'));
        openAccountAction(u);
      }
    };
    show($('account-sheet'));
  }
  // 账号操作菜单：切换 / 删除
  function openAccountAction(user) {
    var title = $('account-action-title');
    var body = $('account-actions-body');
    var cur = currentAccountUser();
    var isCur = user === cur || (!cur && user === state.user);
    title.textContent = user;
    var html = ''
      + '<div class="account-action-item" data-act="switch">'
      + (isCur ? '<span>切换到此账号</span><span class="aa-tag">当前</span>'
               : '<span>切换到该账号</span><span class="aa-tag">›</span>')
      + '</div>'
      + '<div class="account-action-item danger" data-act="del">删除该账号</div>';
    body.innerHTML = html;
    body.querySelectorAll('.account-action-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var act = item.getAttribute('data-act');
        hide($('account-action'));
        if (act === 'switch') { switchAccount(user); if (state.view === 'mine') loadMine(); }
        else if (act === 'del') {
          showConfirm('确认删除账号「' + user + '」？', function () {
            removeAccount(user);
          });
        }
      });
    });
    show($('account-action'));
  }
  // 添加账号：统一走官方 123 云盘登录页（账号密码 / 手机验证码 + 滑块均官方处理）
  function openAddAccount() {
    openOfficialLogin();
  }
  // 添加账号提交（兼容兜底）：统一走官方登录页（本地密码登录会被官方滑块拦截，不从 App 内发起）
  function submitAddAccount() {
    try { hide($('account-modal')); } catch (e) {}
    openOfficialLogin();
  }
  // 读取并显示应用缓存大小
  function updateCacheSize() {
    var el = $('mine-cache-size');
    if (!el) return;
    try {
      var sz = (bridge && bridge.getCacheSize) ? Number(bridge.getCacheSize() || 0) : 0;
      el.textContent = fmtSize(sz);
    } catch (e) { el.textContent = '0 B'; }
  }
  // 清除缓存：清本地存储记录 + 调用原生清除 WebView/应用缓存
  function clearCache() {
    try { localStorage.removeItem('pan_transfers'); } catch (e) {}
    state.transfers = state.transfers || [];
    state.transfers.length = 0;
    try { saveTransfers(); } catch (e) {}
    try { localStorage.removeItem('pan_upqueue'); } catch (e) {}
    state.upQueue = state.upQueue || [];
    state.upQueue.length = 0;
    try { saveUpQueue(); } catch (e) {}
    try { localStorage.removeItem('pan_download_cache'); } catch (e) {}
    if (bridge && bridge.clearCache) {
      try { bridge.clearCache(); } catch (e) {}
    }
    toast('缓存已清除');
    setTimeout(updateCacheSize, 300);
  }

  // ---------- Android 返回键 ----------
  // 安全验证完成后自动刷新回收站
  window.__onVerifyDone = function () {
    toast('验证完成，请重新操作');
    if (typeof loadRecycle === 'function' && !$('page-recycle').classList.contains('hidden')) loadRecycle();
  };
  window.__handleBack = function () {
    // 覆盖式二级页（文件预览 / 我的分享 / 接收分享）：优先关闭
    if (!$('page-preview').classList.contains('hidden')) { closePreview(); return true; }
    if (!$('page-receive').classList.contains('hidden')) { hide($('page-receive')); return true; }
    if (!$('page-directlink').classList.contains('hidden')) { hide($('page-directlink')); return true; }
    if (!$('page-shares').classList.contains('hidden')) { hide($('page-shares')); return true; }
    if (!$('dl-result-modal').classList.contains('hidden')) { hide($('dl-result-modal')); return true; }
    // 去重页面：返回先关闭
    if (!$('dup-page').classList.contains('hidden')) { closeDupFinder(); return true; }
    // 优先关闭弹出的浮层/弹窗
    if (!$('confirm-modal').classList.contains('hidden')) { hide($('confirm-modal')); state.confirmOk = null; return true; }
    if (!$('move-picker').classList.contains('hidden')) { hide($('move-picker')); state.pickerState = null; return true; }
    if (!$('share-config-modal').classList.contains('hidden')) { hide($('share-config-modal')); return true; }
    if (!$('newfolder-modal').classList.contains('hidden')) { hide($('newfolder-modal')); return true; }
    if (!$('share-modal').classList.contains('hidden')) { hide($('share-modal')); return true; }
    if (!$('rename-modal').classList.contains('hidden')) { hide($('rename-modal')); return true; }
    if (!$('action-sheet').classList.contains('hidden')) { hide($('action-sheet')); return true; }
    // 多选（整理）模式：返回先退出多选
    if (state.selectMode) { exitSelectMode(); return true; }
    // 再回退文件目录
    if (state.view === 'files' && state.currentDir !== 0) {
      state.breadcrumb.pop();
      var prev = state.breadcrumb[state.breadcrumb.length - 1];
      state.currentDir = prev ? prev.id : 0;
      loadList();
      return true;
    }
    // 无更多可回退：退出
    if (bridge && bridge.exitApp) bridge.exitApp();
    else {
      // 兜底：用 History API
      if (window.history && window.history.back) window.history.back();
    }
    return true;
  };

  // ---------- 初始化 ----------
  function init() {
    // 注入所有静态 data-icon 图标（含搜索栏 search/x-circle、tab、工具栏等）
    injectIcons();
    // 底部标签切换
    document.querySelectorAll('#tabbar .tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        switchView(tab.getAttribute('data-view'));
      });
    });
    // 传输页子页签切换（下载 / 上传）
    document.querySelectorAll('#view-transfers .ttab').forEach(function (b) {
      b.addEventListener('click', function () {
        state.transferTab = b.getAttribute('data-ttab');
        try { localStorage.setItem('pan_ttab', state.transferTab); } catch (e) {}
        renderTransfers();
      });
    });
    // 登录（统一官方登录页）
    var officialLoginBtn = $('official-login-btn');
    if (officialLoginBtn) officialLoginBtn.addEventListener('click', openOfficialLogin);
    // 重命名
    $('rename-ok').addEventListener('click', doRename);
    // 自定义确认弹窗：点"确定"执行回调
    $('cf-ok').addEventListener('click', onCfOk);
    //自动更新开关与下载按钮绑定
    $('mine-autoupdate').addEventListener('click', onToggleAutoUpdate);
    $('upd-go').addEventListener('click', onUpdGo);
    // 屏幕常亮开关与下载目录
    var keepBtn = $('mine-keep-screen');
    if (keepBtn) keepBtn.addEventListener('click', onToggleKeepScreenOn);
    var dirBtn = $('mine-download-dir');
    if (dirBtn) dirBtn.addEventListener('click', onChangeDownloadDir);
    var themeBtn = $('mine-theme');
    if (themeBtn) themeBtn.addEventListener('click', onChangeTheme);
    renderKeepScreenOn();
    renderDownloadDir();
    renderTheme();
    // 每2秒检测一次传输状态，自动保持/解除屏幕常亮
    setInterval(refreshTransferKeepWake, 2000);
    // 新建文件夹
    $('tool-newfolder').addEventListener('click', function () {
      $('newfolder-input').value = '';
      show($('newfolder-modal'));
    });
    $('newfolder-ok').addEventListener('click', doNewFolder);
    $('newfolder-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') doNewFolder(); });
    // 上传
    // 上传：弹出方式选择（文件 / 文件夹）；文件由原生接管，文件夹走 SAF 目录树
    $('tool-upload').addEventListener('click', doUpload);
    $('up-choice-file').addEventListener('click', pickUploadFile);
    $('up-choice-folder').addEventListener('click', pickUploadFolder);
    $('upload-input').addEventListener('change', function () {
      // 文件选择实际由原生 onShowFileChooser 接管；此处仅清理 input 值（防重复触发）
      this.value = '';
    });
    // 整理（多选）：进入多选模式
    var toolOrganize = $('tool-organize');
    if (toolOrganize) toolOrganize.addEventListener('click', enterSelectMode);
    // 多选操作栏：取消 / 删除 / 移动
    $('select-cancel').addEventListener('click', exitSelectMode);
    $('select-delete').addEventListener('click', deleteSelected);
    $('select-move').addEventListener('click', openMovePicker);
    $('select-copy').addEventListener('click', function () {
      state.pickerAction = 'copy';
      setPickerTitle('copy');
      state.pickerState = { dir: 0, path: [] };
      show($('move-picker'));
      loadPickerDir(0, []);
    });
    // 移动文件夹选择器：取消 / 确定移动
    $('picker-cancel').addEventListener('click', closeMovePicker);
    $('picker-confirm').addEventListener('click', confirmMove);
    // 滚动时隐藏/显示底部"上传/新建"工具栏，避免遮挡文件列表
    var scrollEl = $('content');
    (function () {
      var lastScrollTop = scrollEl.scrollTop || 0;
      scrollEl.addEventListener('scroll', function () {
        var st = scrollEl.scrollTop || 0;
        var tb = $('file-toolbar');
        var bt = $('back-top');
        if (tb) {
          if (st > lastScrollTop + 2) {
            tb.classList.add('toolbar-hidden');
          } else if (st < lastScrollTop - 2) {
            tb.classList.remove('toolbar-hidden');
          }
          if (st <= 0) tb.classList.remove('toolbar-hidden');
        }
        // 置顶按钮：下滑显示，上滑隐藏；超过300px才显示
        if (bt) {
          if (st > 300 && st > lastScrollTop) {
            bt.classList.add('hidden');
          } else if (st < lastScrollTop) {
            bt.classList.remove('hidden');
          }
          if (st <= 300) bt.classList.add('hidden');
        }
        lastScrollTop = st;
      });
    })();
    // 回到顶部
    var backTopBtn = $('back-top');
    if (backTopBtn) backTopBtn.addEventListener('click', function () {
      scrollEl.scrollTo({ top: 0, behavior: 'smooth' });
    });
    // 一键查重：打开面板 / 返回 / 重新扫描 / 整理 / 删除重复项
    // 右上角刷新按钮
    var topRefreshBtn = $('top-refresh');
    if (topRefreshBtn) topRefreshBtn.addEventListener('click', function () {
      loadList();
    });
    // 底部去重按钮：扫描当前目录
    var toolDupBtn = $('tool-dup');
    if (toolDupBtn) toolDupBtn.addEventListener('click', function () { _doDupScan(state.currentDir || 0); });
    // 设置里的去重入口：全盘扫描
    var mineDupBtn = $('mine-dup');
    if (mineDupBtn) mineDupBtn.addEventListener('click', function () { _doDupScan(0); });
    // 网页端管理
    var mineWebBtn = $('mine-web');
    if (mineWebBtn) mineWebBtn.addEventListener('click', function () {
      if (bridge && bridge.openVerifyWeb) bridge.openVerifyWeb();
      else if (bridge && bridge.openExternalWeb) bridge.openExternalWeb('https://canary-yun.123pan.cn/');
    });
    var dupBack = $('dup-back');
    if (dupBack) dupBack.addEventListener('click', closeDupFinder);
    var dupRescan = $('dup-rescan');
    if (dupRescan) dupRescan.addEventListener('click', openDupFinder);
    var dupOrganizeBtn = $('dup-organize');
    if (dupOrganizeBtn) dupOrganizeBtn.addEventListener('click', dupOrganize);
    var dupDeleteBtn = $('dup-delete');
    if (dupDeleteBtn) dupDeleteBtn.addEventListener('click', dupDeleteSelected);
    // 排序：打开面板 / 选择字段+方向
    var topSortBtn = $('top-sort');
    if (topSortBtn) topSortBtn.addEventListener('click', openSortSheet);
    document.querySelectorAll('#sort-fields .sort-row').forEach(function (row) {
      var by = row.getAttribute('data-by');
      row.querySelectorAll('.sort-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.orderBy = by;
          state.orderDirection = btn.getAttribute('data-dir');
          applySort();
        });
      });
    });
    // 全盘搜索
    var searchInput = $('search-input');
    var searchClear = $('search-clear');
    if (searchInput) {
      // 回车触发搜索
      searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { doSearch(searchInput.value); }
      });
      // 输入变化：非空时显示清除按钮，清空时隐藏并退出搜索
      searchInput.addEventListener('input', function () {
        if (searchClear) {
          if (searchInput.value.trim()) show(searchClear);
          else hide(searchClear);
        }
      });
    }
    if (searchClear) {
      searchClear.addEventListener('click', function () {
        exitSearch();
        if (searchInput) searchInput.focus();
      });
    }
    // 分享弹窗复制链接
    $('share-copy').addEventListener('click', doCopyLink);
    // 创建分享：确认按钮 + 自定义提取码切换
    $('sc-create').addEventListener('click', doCreateShare);
    document.querySelectorAll('input[name="sc-pwd"]').forEach(function (rd) {
      rd.addEventListener('change', function () {
        var showCustom = rd.value === '3';
        if (showCustom) show($('sc-custom'));
        else hide($('sc-custom'));
      });
    });
    // 清空回收站（二次确认）
    var clearRecycleBtn = $('recycle-clear');
    if (clearRecycleBtn) clearRecycleBtn.addEventListener('click', function () {
      showConfirm('确认清空回收站的所有文件数据？\n清空后将无法恢复！', recycleClearAll);
    });
    // 回收站批量操作
    var rbCancel = $('rb-cancel');
    if (rbCancel) rbCancel.addEventListener('click', function () {
      state.recycleSelected = {};
      state.recycleSelectMode = false;
      loadRecycle();
    });
    var rbRestore = $('rb-restore');
    if (rbRestore) rbRestore.addEventListener('click', function () {
      var ids = Object.keys(state.recycleSelected || {}).map(Number);
      if (!ids.length) return;
      showConfirm('确认恢复选中的 ' + ids.length + ' 项？', function () {
        var body = { RequestSource: null, driveId: 0, event: 'recycleRestore', fileTrashInfoList: ids.map(function (id) { return { FileId: id }; }), operatePlace: 1, operation: false, safeBox: false };
        api('POST', API.trash, JSON.stringify(body), true, function (d) {
          if (d && (d.code === 0 || (d.message && /已删除|已恢复|释放空间/.test(d.message)))) { toast('已恢复 ' + ids.length + ' 项'); state.recycleSelected = {}; state.recycleSelectMode = false; loadRecycle(); }
          else toast((d && d.message) || '恢复失败');
        });
      });
    });
    var rbDelete = $('rb-delete');
    if (rbDelete) rbDelete.addEventListener('click', function () {
      var ids = Object.keys(state.recycleSelected || {}).map(Number);
      if (!ids.length) return;
      showConfirm('确认彻底删除选中的 ' + ids.length + ' 项？\n清理后将无法恢复！', function () {
        var body = { RequestSource: null, event: 'recycleDelete', fileIdList: ids.map(function (id) { return { FileId: id }; }), operatePlace: 1 };
        api('POST', API.trashDelete, JSON.stringify(body), true, function (d) {
          if (d && (d.code === 0 || (d.message && /已删除|释放空间/.test(d.message)))) { toast((d.message || '已彻底删除 ') + ids.length + ' 项'); state.recycleSelected = {}; state.recycleSelectMode = false; loadRecycle(); }
          else if (d && (d.code === 4001 || /安全验证|验证码|验证/i.test(d.message || ''))) {
            showConfirm('触发安全验证，需要在验证页面完成滑块+短信验证。\n是否立即打开验证页面？', function () {
              if (bridge && bridge.openVerifyWeb) bridge.openVerifyWeb();
              else if (bridge && bridge.openExternalWeb) bridge.openExternalWeb('https://canary-yun.123pan.cn/recycle?notoken=1');
            });
          }
          else toast((d && d.message) || '删除失败');
        });
      });
    });
    // 分享：我的分享 / 接收分享入口
    var mineShares = $('mine-shares');
    if (mineShares) mineShares.addEventListener('click', openMyShares);
    var mineReceive = $('mine-receive');
    if (mineReceive) mineReceive.addEventListener('click', openReceiveShare);
    var mineDirect = $('mine-directlink');
    if (mineDirect) mineDirect.addEventListener('click', openDirectLink);
    // 覆盖页返回按钮
    var sharesBack = $('shares-back');
    if (sharesBack) sharesBack.addEventListener('click', function () { hide($('page-shares')); });
    var receiveBack = $('receive-back');
    if (receiveBack) receiveBack.addEventListener('click', function () { hide($('page-receive')); });
    var dlBack = $('dl-back');
    if (dlBack) dlBack.addEventListener('click', function () { hide($('page-directlink')); });
    var dlOpen = $('dl-open');
    if (dlOpen) dlOpen.addEventListener('click', doOpenDirectLink);
    var dlLink = $('dl-link');
    if (dlLink) dlLink.addEventListener('keydown', function (e) { if (e.key === 'Enter') doOpenDirectLink(); });
    var dlCopy = $('dl-copy');
    if (dlCopy) dlCopy.addEventListener('click', function () {
      var u = $('dl-url-box') ? $('dl-url-box').textContent.trim() : '';
      if (!u) { toast('无直链可复制'); return; }
      copyText(u, '');
      hide($('dl-result-modal'));
      setTimeout(function () { toast('直链已复制到剪贴板'); }, 200);
    });
    var dlSaveQr = $('dl-save-qr');
    if (dlSaveQr) dlSaveQr.addEventListener('click', function () {
      var wrap = $('dl-qr-wrap');
      if (!wrap || !wrap.dataset.qrUrl) { toast('无二维码'); return; }
      var qrUrl = wrap.dataset.qrUrl;
      var fname = 'qr_' + Date.now() + '.png';
      if (bridge && bridge.downloadStream) {
        try {
          var gid = Number(bridge.downloadStream(qrUrl, fname, 0));
          if (gid >= 0) toast('二维码已保存到下载目录');
          else toast('保存失败');
        } catch (e) { toast('保存失败: ' + e); }
      } else if (bridge && bridge.download) {
        try { bridge.download(qrUrl, fname); toast('二维码已保存'); } catch (e) { toast('保存失败'); }
      } else {
        var a = document.createElement('a');
        a.href = qrUrl; a.download = fname; a.click();
        toast('二维码已保存');
      }
    });
    // 预览页返回 / 复制链接
    var previewBack = $('pv-back');
    if (previewBack) previewBack.addEventListener('click', closePreview);
    var previewCopy = $('pv-copy');
    if (previewCopy) previewCopy.addEventListener('click', copyPreviewLink);
    // 接收分享：打开 / 回车 / 转存
    var receiveOpen = $('receive-open');
    if (receiveOpen) receiveOpen.addEventListener('click', doOpenReceiveShare);
    var receiveLink = $('receive-link');
    if (receiveLink) receiveLink.addEventListener('keydown', function (e) { if (e.key === 'Enter') doOpenReceiveShare(); });
    var receiveSave = $('receive-save');
    if (receiveSave) receiveSave.addEventListener('click', doSaveSelectedShare);
    // 退出
    $('logout-btn').addEventListener('click', doLogout);
    // 多账号：添加账号入口（统一走官方登录页）
    var accountAdd = $('account-add');
    if (accountAdd) accountAdd.addEventListener('click', openAddAccount);
    // 清除缓存
    var clearCacheBtn = $('mine-clear-cache');
    if (clearCacheBtn) clearCacheBtn.addEventListener('click', clearCache);
    // 关闭浮层/弹窗（data-close）
    document.querySelectorAll('[data-close]').forEach(function (el) {
      el.addEventListener('click', function () {
        el.closest && el.closest('.sheet') && hide(el.closest('.sheet'));
        el.closest && el.closest('.modal') && hide(el.closest('.modal'));
      });
    });
    // 初始：检查登录态
    setupListScroll();
    var t = loadToken();
    if (t) {
      state.token = t;
      enterMain();
    } else {
      show($('page-login'));
      hide($('page-main'));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); scheduleUpdateBoot(); });
  } else {
    init();
    scheduleUpdateBoot();
  }
})();