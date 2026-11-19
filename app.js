'use strict';

/* ============================================================
 * DeepSeek Chat · 纯前端 H5
 * - 对话直连 DeepSeek API（浏览器 SSE 流式）
 * - DeepThink 切换 R1，Search 先联网检索再回答
 * - 记录保存到 GitHub 仓库（git tree 取列表 + contents 读写）
 * ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const LS = {
  settings: 'dsc.settings',
  list: 'dsc.list',
  draft: 'dsc.draft',
  theme: 'dsc.theme',
  collapsed: 'dsc.collapsed',
};

const DEFAULT_SETTINGS = {
  apiKey: '',
  apiBase: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  ghToken: '',
  ghOwner: '',
  ghRepo: '',
  ghBranch: 'main',
  ghDir: 'chats',
};

const EFFORTS = ['low', 'high', 'max'];

/* 上传文件：按扩展名决定 purpose 与体积上限（上限来自 Files API 文档） */
const ATTACH_MAX = 20;

/* 文件存储配额（Files API 文档：单账号 25 GiB / 10,000 个文件） */
const FILE_QUOTA = { count: 10000, bytes: 25 * 1024 * 1024 * 1024 };
const USAGE_TTL = 10 * 60 * 1000;
const ATTACH_KINDS = [
  {
    kind: 'image',
    purpose: 'user_data',
    max: 64 * 1024 * 1024,
    exts: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
  },
  {
    kind: 'doc',
    purpose: 'rich_layout_recognition',
    max: 100 * 1024 * 1024,
    exts: ['pdf', 'doc', 'docx', 'ppt', 'pptx'],
  },
  {
    kind: 'data',
    purpose: 'user_data',
    max: 32 * 1024 * 1024,
    exts: ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xlsx', 'xls', 'epub', 'mobi',
      'log', 'xml', 'yaml', 'yml', 'html', 'htm', 'css', 'js', 'mjs', 'ts', 'jsx', 'tsx', 'py',
      'java', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'rb', 'swift', 'kt', 'sql', 'sh',
      'ini', 'conf', 'toml'],
  },
];

const state = {
  settings: readSettings(),
  model: '',
  messages: [],
  current: { path: '', sha: '', title: '', createdAt: 0, savedHash: '' },
  list: [],
  streaming: false,
  controller: null,
  sid: 0,
  saveChain: Promise.resolve(),
  pinBottom: true,
  themePref: localStorage.getItem(LS.theme) || 'auto',
  searchOn: false,
  thinking: false,
  effort: 'high',
  attachments: [],
};

state.model = DEFAULT_SETTINGS.model;

/* ============================================================
 * 基础工具
 * ============================================================ */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function readJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function readSettings() {
  return Object.assign({}, DEFAULT_SETTINGS, readJSON(LS.settings, {}) || {});
}

function persistSettings() {
  try {
    localStorage.setItem(LS.settings, JSON.stringify(state.settings));
  } catch {}
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    toast('复制失败');
  }
}

/* ============================================================
 * 主题
 * ============================================================ */

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(pref) {
  state.themePref = pref;
  localStorage.setItem(LS.theme, pref);
  document.documentElement.dataset.theme = resolveTheme(pref);
  updateThemeMeta();
}

function updateThemeMeta() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#1b1c1d' : '#ffffff');
}

function initTheme() {
  document.documentElement.dataset.theme = resolveTheme(state.themePref);
  updateThemeMeta();
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (state.themePref === 'auto') {
      document.documentElement.dataset.theme = resolveTheme('auto');
      updateThemeMeta();
    }
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
}

/* ============================================================
 * Markdown
 * ============================================================ */

if (window.marked) {
  window.marked.setOptions({ gfm: true, breaks: true });
}

function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) {
    try {
      return window.DOMPurify.sanitize(window.marked.parse(text), { ADD_ATTR: ['target', 'rel'] });
    } catch (err) {
      console.warn('markdown 渲染失败', err);
    }
  }
  return '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
}

function decorateCode(root) {
  $$('pre', root).forEach((pre) => {
    if (pre.querySelector('.copy-code')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-code';
    btn.type = 'button';
    btn.textContent = '复制';
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const code = pre.querySelector('code');
      await copyText(code ? code.textContent : pre.textContent);
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制'; }, 1200);
    });
    pre.appendChild(btn);
  });
}

/* ============================================================
 * DeepSeek API
 * ============================================================ */

function apiUrl(pathname) {
  const base = String(state.settings.apiBase || DEFAULT_SETTINGS.apiBase).replace(/\/+$/, '');
  return base + pathname;
}

function apiMessages() {
  return state.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.error
      && (m.content || (m.files && m.files.length)))
    .map((m) => ({ role: m.role, content: apiContent(m) }));
}

async function apiError(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = (j && j.error && j.error.message) || JSON.stringify(j);
  } catch {
    try { detail = await res.text(); } catch {}
  }
  return new Error('API ' + res.status + (detail ? '：' + String(detail).slice(0, 260) : ''));
}

async function streamChat(messages, opts) {
  const onDelta = opts.onDelta;
  const signal = opts.signal;
  const body = {
    model: state.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: state.thinking ? 'enabled' : 'disabled' },
    // reasoning_effort 默认 high 会重新打开思考，关闭时必须显式传 none
    reasoning_effort: state.thinking ? state.effort : 'none',
  };
  if (!state.thinking) body.temperature = 1;

  const res = await fetch(apiUrl('/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + state.settings.apiKey,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw await apiError(res);
  if (!res.body) throw new Error('当前浏览器不支持流式响应');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let usage = null;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.usage) usage = json.usage;
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      if (!delta) continue;
      if (delta.reasoning_content) onDelta({ reasoning: delta.reasoning_content });
      if (delta.content) onDelta({ content: delta.content });
    }
  }
  return { usage };
}

async function generateTitle(messages) {
  const text = messages
    .filter((m) => !m.error && (m.content || (m.files && m.files.length)))
    .slice(-8)
    .map((m) => {
      const files = (m.files || []).map((f) => '［文件：' + f.name + '］').join('');
      return (m.role === 'user' ? '用户：' : '助手：') + (m.content || '') + files;
    })
    .join('\n')
    .slice(0, 2400);

  const model = 'deepseek-flash';
  const res = await fetch(apiUrl('/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + state.settings.apiKey,
    },
    body: JSON.stringify({
      model,
      stream: false,
      thinking: { type: 'disabled' },
      reasoning_effort: 'none',
      temperature: 0.3,
      max_tokens: 40,
      messages: [
        {
          role: 'system',
          content: '你是对话标题生成器。根据用户给出的对话内容，输出一个能概括主题的简短中文标题，不超过 12 个字。只输出标题本身，不要引号、不要句号、不要解释。',
        },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  return cleanTitle(raw);
}

function cleanTitle(raw) {
  const t = String(raw || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["'“”‘’「」《》\u0060*#]/g, '')
    .replace(/^[：:，,。.\s-]+|[：:，,。.\s-]+$/g, '')
    .trim();
  const chars = Array.from(t);
  return chars.length > 20 ? chars.slice(0, 20).join('') : t;
}

function fallbackTitle() {
  const first = state.messages.find((m) => m.role === 'user' && (m.content || (m.files && m.files.length)));
  let raw = '新对话';
  if (first && first.content) raw = first.content;
  else if (first && first.files && first.files.length) raw = first.files[0].name;
  const t = cleanTitle(raw);
  return Array.from(t).slice(0, 16).join('') || '新对话';
}

/* ============================================================
 * 附件上传（Files API）
 * ============================================================ */

const ICON_FILE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/></svg>';

let attachSeq = 0;

function fileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function attachSpec(name) {
  const ext = fileExt(name);
  for (let i = 0; i < ATTACH_KINDS.length; i += 1) {
    if (ATTACH_KINDS[i].exts.indexOf(ext) >= 0) return ATTACH_KINDS[i];
  }
  return null;
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10 * 1024 ? 1 : 0) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(v < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function uploadStateText(item) {
  if (item.status === 'error') return item.error ? '失败：' + item.error : '上传失败';
  if (item.status === 'parsing') return '解析中…';
  if (item.status === 'uploading') return '上传中 ' + (item.progress || 0) + '%';
  return formatBytes(item.size);
}

function newAttachment(file, spec) {
  attachSeq += 1;
  return {
    key: 'att' + attachSeq + '_' + Date.now(),
    name: file.name,
    size: file.size,
    kind: spec.kind,
    purpose: spec.purpose,
    status: 'uploading',
    progress: 0,
    id: '',
    error: '',
    url: spec.kind === 'image' ? URL.createObjectURL(file) : '',
  };
}

function uploadAttachment(item, file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/files'));
    xhr.setRequestHeader('Authorization', 'Bearer ' + state.settings.apiKey);
    xhr.timeout = 300000;

    const fd = new FormData();
    // purpose 必须排在 file 之前，文档解析要靠它
    fd.append('purpose', item.purpose);
    fd.append('file', file, item.name);

    xhr.upload.addEventListener('progress', (ev) => {
      if (!ev.lengthComputable) return;
      item.progress = Math.min(99, Math.round((ev.loaded / ev.total) * 100));
      if (item.progress >= 99 && item.status === 'uploading') item.status = 'parsing';
      paintAttachment(item);
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let json = null;
        try { json = JSON.parse(xhr.responseText); } catch {}
        if (!json || !json.id) {
          reject(new Error('返回结果缺少 file_id'));
          return;
        }
        resolve(json);
        return;
      }
      let msg = '';
      try {
        const json = JSON.parse(xhr.responseText);
        msg = (json && json.error && json.error.message) || (json && json.message) || '';
      } catch {
        msg = xhr.responseText || '';
      }
      reject(new Error('上传失败 ' + xhr.status + (msg ? '：' + String(msg).slice(0, 160) : '')));
    });
    xhr.addEventListener('error', () => reject(new Error('网络错误，上传失败')));
    xhr.addEventListener('timeout', () => reject(new Error('上传超时')));
    xhr.addEventListener('abort', () => reject(new Error('已取消')));
    item.xhr = xhr;
    xhr.send(fd);
  });
}

function deleteRemoteFile(id) {
  if (!id || !state.settings.apiKey) return;
  fetch(apiUrl('/files/' + encodeURIComponent(id)), {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + state.settings.apiKey },
  }).catch(() => {});
}

/* ---------- 文件用量 ---------- */

const usageState = { at: 0, key: '', data: null, promise: null, warned: false };

function usagePercent(data) {
  if (!data) return 0;
  const byBytes = data.bytes / FILE_QUOTA.bytes;
  const byCount = data.count / FILE_QUOTA.count;
  return Math.min(100, Math.round(Math.max(byBytes, byCount) * 100));
}

async function fetchFileUsage(key) {
  let after = '';
  let count = 0;
  let bytes = 0;
  let pages = 0;
  let partial = false;

  for (;;) {
    const qs = new URLSearchParams();
    qs.set('limit', '1000');
    qs.set('order', 'desc');
    if (after) qs.set('after', after);

    const res = await fetch(apiUrl('/files?' + qs.toString()), {
      headers: { Authorization: 'Bearer ' + key },
    });
    if (!res.ok) throw await apiError(res);

    const json = await res.json();
    (json.data || []).forEach((f) => {
      count += 1;
      bytes += Number(f.bytes) || 0;
    });
    pages += 1;
    if (!json.has_more || !json.last_id) break;
    if (pages >= 10) { partial = true; break; }
    after = json.last_id;
  }

  return { count, bytes, partial };
}

function getFileUsage(key, force) {
  if (!key) return Promise.resolve(null);
  if (!force && usageState.data && usageState.key === key
    && Date.now() - usageState.at < USAGE_TTL) {
    return Promise.resolve(usageState.data);
  }
  if (usageState.promise) return usageState.promise;

  usageState.promise = fetchFileUsage(key)
    .then((data) => {
      usageState.at = Date.now();
      usageState.key = key;
      usageState.data = data;
      usageState.promise = null;
      return data;
    })
    .catch((err) => {
      usageState.promise = null;
      throw err;
    });
  return usageState.promise;
}

function renderUsage(status, data, message) {
  const card = $('#usageCard');
  const pctEl = $('#usagePct');
  const fill = $('#usageFill');
  const countEl = $('#usageCount');
  const bytesEl = $('#usageBytes');
  const tip = $('#usageTip');
  if (!card || !pctEl) return;

  card.classList.remove('warn', 'full');

  if (status === 'loading') {
    pctEl.textContent = '…';
    fill.style.width = '0%';
    countEl.textContent = '—';
    bytesEl.textContent = '—';
    tip.textContent = '正在读取账号里的文件用量…';
    return;
  }

  if (status === 'empty') {
    pctEl.textContent = '—';
    fill.style.width = '0%';
    countEl.textContent = '—';
    bytesEl.textContent = '—';
    tip.textContent = '填写 API Key 后显示用量';
    return;
  }

  if (status === 'error') {
    pctEl.textContent = '—';
    fill.style.width = '0%';
    countEl.textContent = '—';
    bytesEl.textContent = '—';
    tip.textContent = '读取失败：' + (message || '请稍后重试');
    return;
  }

  const pct = usagePercent(data);
  pctEl.textContent = pct + '%';
  fill.style.width = pct + '%';
  countEl.textContent = data.partial ? '10,000+' : Number(data.count).toLocaleString('en-US');
  bytesEl.textContent = formatBytes(data.bytes);

  const notes = [];
  if (pct >= 80) {
    card.classList.add(pct >= 100 ? 'full' : 'warn');
    notes.push(pct >= 100
      ? '配额已满，新的上传会失败，需要先在 DeepSeek 账号里删掉一些文件。'
      : '接近配额上限，仍可继续上传；空间不足时再清理，删除会让引用它的历史对话失效。');
  } else {
    notes.push('空间充裕，文件默认永久有效，历史对话可以一直引用。');
  }
  if (data.partial) notes.push('（只统计了最近 10,000 个文件）');
  tip.textContent = notes.join('');
}

async function refreshUsage(force) {
  const input = $('#setApiKey');
  const key = (input && input.value.trim()) || state.settings.apiKey;
  if (!key) {
    renderUsage('empty');
    return;
  }
  if (!force && usageState.data && usageState.key === key
    && Date.now() - usageState.at < USAGE_TTL) {
    renderUsage('ok', usageState.data);
    return;
  }

  renderUsage('loading');
  try {
    const data = await getFileUsage(key, Boolean(force));
    if (data) renderUsage('ok', data);
    else renderUsage('empty');
  } catch (err) {
    renderUsage('error', null, err.message || '读取失败');
  }
}

function checkUsageAfterUpload() {
  if (usageState.warned || !usageState.data) return;
  const pct = usagePercent(usageState.data);
  if (pct < 80) return;
  usageState.warned = true;
  toast('文件存储已用 ' + pct + '%，接近 DeepSeek 配额上限', 4200);
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!state.settings.apiKey) {
    openSettings(true);
    toast('请先填写 DeepSeek API Key');
    return;
  }

  let room = ATTACH_MAX - state.attachments.length;
  let full = false;
  files.forEach((file) => {
    if (room <= 0) {
      if (!full) toast('每条消息最多 ' + ATTACH_MAX + ' 个文件');
      full = true;
      return;
    }
    const spec = attachSpec(file.name);
    if (!spec) {
      toast('不支持的文件类型：' + file.name, 3200);
      return;
    }
    if (file.size > spec.max) {
      toast(file.name + ' 超过 ' + formatBytes(spec.max) + ' 上限', 3200);
      return;
    }
    if (new TextEncoder().encode(file.name).length > 512) {
      toast('文件名过长：' + String(file.name).slice(0, 18), 3200);
      return;
    }
    room -= 1;
    const item = newAttachment(file, spec);
    state.attachments.push(item);
    renderAttachments();
    uploadOne(item, file);
  });

  persistDraft();
  updateSendState();
}

async function uploadOne(item, file) {
  try {
    const obj = await uploadAttachment(item, file);
    item.id = obj.id;
    item.status = 'ready';
    item.progress = 100;
    if (obj.bytes) item.size = obj.bytes;
  } catch (err) {
    item.status = 'error';
    item.error = err.message || '上传失败';
  }
  item.xhr = null;
  paintAttachment(item);
  updateSendState();
  persistDraft();
  if (item.status === 'ready') checkUsageAfterUpload();
  if (item.status === 'error' && !item.cancelled) toast(item.name + ' ' + item.error, 3800);
}

function attachmentThumb(item) {
  const thumb = document.createElement('span');
  thumb.className = 'ac-thumb';
  if (item.kind === 'image' && item.url) {
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = '';
    thumb.appendChild(img);
  } else {
    thumb.innerHTML = ICON_FILE;
  }
  return thumb;
}

function attachmentChip(item, removable) {
  const root = document.createElement('div');
  root.className = 'attach-chip';
  const stateText = document.createElement('span');
  stateText.className = 'ac-state';

  const info = document.createElement('span');
  info.className = 'ac-info';
  const name = document.createElement('span');
  name.className = 'ac-name';
  name.textContent = item.name;
  name.title = item.name;
  info.append(name, stateText);

  const bar = document.createElement('span');
  bar.className = 'ac-bar';
  const barFill = document.createElement('i');
  bar.appendChild(barFill);

  root.append(attachmentThumb(item), info, bar);
  if (removable !== false) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ac-del';
    del.setAttribute('aria-label', '移除');
    del.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeAttachment(item);
    });
    root.appendChild(del);
  }

  item._el = { root, stateText, barFill };
  paintAttachment(item);
  return root;
}

function paintAttachment(item) {
  const el = item._el;
  if (!el) return;
  el.root.classList.toggle('error', item.status === 'error');
  el.root.classList.toggle('busy', item.status === 'uploading' || item.status === 'parsing');
  el.stateText.textContent = uploadStateText(item);
  const showBar = item.status === 'uploading' || item.status === 'parsing';
  el.barFill.style.width = item.status === 'parsing' ? '100%' : (item.progress || 0) + '%';
  el.barFill.parentNode.classList.toggle('show', showBar);
  el.barFill.classList.toggle('indeterminate', item.status === 'parsing');
}

function renderAttachments() {
  const strip = $('#attachStrip');
  if (!strip) return;
  strip.innerHTML = '';
  strip.hidden = !state.attachments.length;
  state.attachments.forEach((item) => strip.appendChild(attachmentChip(item, true)));
  autoGrow();
}

function removeAttachment(item) {
  const idx = state.attachments.indexOf(item);
  if (idx < 0) return;
  state.attachments.splice(idx, 1);
  stopUpload(item);
  if (item.url) URL.revokeObjectURL(item.url);
  if (item.id) deleteRemoteFile(item.id);
  renderAttachments();
  updateSendState();
  persistDraft();
}

function clearAttachments(remote) {
  state.attachments.forEach((item) => {
    stopUpload(item);
    if (item.url) URL.revokeObjectURL(item.url);
    if (remote && item.id) deleteRemoteFile(item.id);
  });
  state.attachments = [];
  renderAttachments();
  updateSendState();
}

function stopUpload(item) {
  item.cancelled = true;
  if (!item.xhr) return;
  try { item.xhr.abort(); } catch {}
  item.xhr = null;
}

function messageFilesNode(files) {
  const box = document.createElement('div');
  box.className = 'attach-strip in-msg';
  files.forEach((f) => {
    const spec = attachSpec(f.name);
    box.appendChild(attachmentChip({
      name: f.name,
      size: f.size,
      kind: f.kind || (spec ? spec.kind : 'data'),
      status: 'ready',
      progress: 100,
      id: f.id,
      error: '',
      url: '',
    }, false));
  });
  return box;
}

function apiContent(m) {
  const files = m.files || [];
  if (!files.length) return m.content;
  const blocks = [];
  if (m.content) blocks.push({ type: 'text', text: m.content });
  files.forEach((f) => {
    if (f.id) blocks.push({ type: 'file', file_id: f.id });
  });
  return blocks.length ? blocks : (m.content || '');
}

/* ============================================================
 * 网页搜索（DeepSeek /v1/tools/search）
 * ============================================================ */

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function searchEndpoint() {
  const base = String(state.settings.apiBase || DEFAULT_SETTINGS.apiBase).replace(/\/+$/, '');
  return base.replace(/\/v1$/, '') + '/v1/tools/search';
}

async function searchWeb(query, original) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 128);
  if (!q) return [];
  const res = await fetch(searchEndpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + state.settings.apiKey,
    },
    body: JSON.stringify({
      query: q,
      count: 5,
      ori_question: String(original || q).slice(0, 128),
    }),
  });
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  return (j.results || [])
    .filter((r) => r && r.url)
    .map((r) => ({
      title: r.title || hostOf(r.url),
      url: r.url,
      snippet: r.snippet || r.summary || '',
      summary: r.summary || r.snippet || '',
      host: r.site_name || hostOf(r.url),
      score: typeof r.rerank_score === 'number' ? r.rerank_score : null,
      date: r.date || '',
    }));
}

function searchSystemMessage(results) {
  const lines = results.map((r, i) => '[' + (i + 1) + '] ' + r.title
    + (r.date ? '（' + String(r.date).slice(0, 10) + '）' : '')
    + '\n' + (r.summary || r.snippet) + '\n链接：' + r.url).join('\n\n');
  return {
    role: 'system',
    content: '以下是刚刚通过网页搜索检索到的资料（' + new Date().toLocaleString('zh-CN') + '）。'
      + '回答时优先依据这些资料，并在引用处用 [1] 这样的编号标注来源；'
      + '资料不足以回答时请直接说明，不要编造。\n\n' + lines,
  };
}

function renderSources(host, msg) {
  host.innerHTML = '';
  if (msg.searching) {
    host.innerHTML = '<div class="searching"><i class="spinner"></i>正在搜索网页…</div>';
    return;
  }
  if (!msg.search) return;
  if (msg.searchError) {
    const p = document.createElement('div');
    p.className = 'search-note';
    p.textContent = '网页搜索暂不可用，已直接回答';
    host.appendChild(p);
    return;
  }
  if (!msg.sources || !msg.sources.length) {
    const p = document.createElement('div');
    p.className = 'search-note';
    p.textContent = '未搜索到相关网页，已直接回答';
    host.appendChild(p);
    return;
  }

  const details = document.createElement('details');
  details.className = 'sources';
  const summary = document.createElement('summary');
  summary.textContent = '搜索到 ' + msg.sources.length + ' 个网页';
  details.appendChild(summary);

  const list = document.createElement('div');
  list.className = 'sources-list';
  msg.sources.forEach((s, i) => {
    const a = document.createElement('a');
    a.className = 'source';
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);
    const title = document.createElement('span');
    title.className = 'stitle';
    title.textContent = s.title || s.url;
    title.title = s.snippet || s.title || '';
    const hostEl = document.createElement('span');
    hostEl.className = 'host';
    hostEl.textContent = s.host || hostOf(s.url);
    a.append(idx, title, hostEl);
    list.appendChild(a);
  });
  details.appendChild(list);
  host.appendChild(details);
}

/* ============================================================
 * GitHub 存储
 * ============================================================ */

function ghReady() {
  const s = state.settings;
  return Boolean(s.ghToken && s.ghOwner && s.ghRepo);
}

function ghHeaders(extra) {
  return Object.assign({
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: 'Bearer ' + state.settings.ghToken,
  }, extra || {});
}

async function gh(path, opts) {
  const options = opts || {};
  const url = /^https?:/.test(path) ? path : 'https://api.github.com' + path;
  const res = await fetch(url, Object.assign({}, options, { headers: ghHeaders(options.headers) }));
  if (!res.ok) {
    let msg = '';
    try {
      const j = await res.json();
      msg = j.message || '';
    } catch {}
    if (res.status === 401) msg = 'Token 无效或已过期';
    else if (res.status === 404) msg = msg || '仓库、分支或文件不存在';
    else if (res.status === 403) msg = msg || '没有权限或触发限流';
    const err = new Error(msg + ' (' + res.status + ')');
    err.status = res.status;
    throw err;
  }
  return res;
}

function repoPath() {
  return encodeURIComponent(state.settings.ghOwner) + '/' + encodeURIComponent(state.settings.ghRepo);
}

function encodeContentPath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

function ghDir() {
  return String(state.settings.ghDir || '').replace(/^\/+|\/+$/g, '');
}

function joinPath(dir, name) {
  return dir ? dir + '/' + name : name;
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(String(b64 || '').replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function sanitizeFileTitle(title) {
  let t = String(title || '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  const chars = Array.from(t);
  if (chars.length > 24) t = chars.slice(0, 24).join('');
  return t || 'chat';
}

function makeFileName(time, title) {
  const d = new Date(time);
  const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  return stamp + '_' + sanitizeFileTitle(title) + '.json';
}

function parseFileName(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})_(.+)\.json$/i.exec(name);
  if (!m) return null;
  const time = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  const title = m[7].replace(/_/g, ' ').trim() || '未命名对话';
  return { title, time };
}

async function ghList() {
  const res = await gh('/repos/' + repoPath() + '/git/trees/'
    + encodeURIComponent(state.settings.ghBranch) + '?recursive=1');
  const j = await res.json();
  const dir = ghDir();
  const items = [];

  (j.tree || []).forEach((node) => {
    if (node.type !== 'blob' || !/\.json$/i.test(node.path)) return;
    if (dir && node.path.indexOf(dir + '/') !== 0) return;
    const name = dir ? node.path.slice(dir.length + 1) : node.path;
    const meta = parseFileName(name);
    if (!meta) return;
    items.push({ path: node.path, sha: node.sha, title: meta.title, time: meta.time });
  });

  items.sort((a, b) => b.time - a.time);
  return items;
}

async function ghGet(path) {
  const res = await gh('/repos/' + repoPath() + '/contents/' + encodeContentPath(path)
    + '?ref=' + encodeURIComponent(state.settings.ghBranch));
  const j = await res.json();
  return { text: b64decode(j.content), sha: j.sha };
}

async function ghPut(path, text, message, sha) {
  const payload = {
    message,
    content: b64encode(text),
    branch: state.settings.ghBranch,
  };
  if (sha) payload.sha = sha;
  const res = await gh('/repos/' + repoPath() + '/contents/' + encodeContentPath(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await res.json();
  return j.content ? j.content.sha : '';
}

async function ghDelete(path, sha) {
  await gh('/repos/' + repoPath() + '/contents/' + encodeContentPath(path), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'chat: delete ' + path.split('/').pop(),
      sha,
      branch: state.settings.ghBranch,
    }),
  });
}

/* ============================================================
 * 保存对话
 * ============================================================ */

function hashMessages() {
  const s = state.messages
    .filter((m) => !m.error)
    .map((m) => m.role + '\u0001' + (m.content || '') + '\u0001' + (m.reasoning || '')
      + '\u0001' + ((m.files || []).map((f) => f.id).join(','))
      + '\u0001' + ((m.sources || []).map((x) => x.url).join(',')))
    .join('\u0002');
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ':' + s.length;
}

function isDirty() {
  return state.messages.some((m) => m.role === 'user' && (m.content || (m.files && m.files.length)))
    && hashMessages() !== state.current.savedHash;
}

function setSaveState(kind) {
  const el = $('#saveState');
  if (!el) return;
  el.dataset.s = state.messages.length ? (kind || '') : '';
  const map = { local: '仅本地', saving: '同步中', saved: '已同步', error: '同步失败', dirty: '待同步' };
  el.textContent = map[kind] || '';
}

function enqueueSave(opts) {
  state.saveChain = state.saveChain
    .then(() => doSave(opts || {}))
    .catch((err) => { console.warn('[save]', err); });
  return state.saveChain;
}

let saveTimer = 0;
function scheduleSave(delay) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    if (isDirty()) enqueueSave({});
  }, delay == null ? 1600 : delay);
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (!isDirty()) return;
  await enqueueSave({});
}

function chatData(title, createdAt, id) {
  return {
    id: id || '',
    title,
    model: state.model,
    thinking: state.thinking,
    effort: state.effort,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date().toISOString(),
    messages: state.messages
      .filter((m) => !m.error && (m.content || m.reasoning
        || (m.sources && m.sources.length) || (m.files && m.files.length)))
      .map((m) => {
        const out = { role: m.role, content: m.content, time: new Date(m.time || Date.now()).toISOString() };
        if (m.reasoning) out.reasoning = m.reasoning;
        if (m.reasoning && m.thinkMs) out.thinkMs = m.thinkMs;
        if (m.search) out.search = true;
        if (m.sources && m.sources.length) out.sources = m.sources;
        if (m.files && m.files.length) {
          out.files = m.files.map((f) => ({
            id: f.id, name: f.name, size: f.size, kind: f.kind, purpose: f.purpose,
          }));
        }
        return out;
      }),
  };
}

async function putNewChatFile(text, createdAt, title) {
  const base = joinPath(ghDir(), makeFileName(createdAt, title));
  let attempt = 0;
  for (;;) {
    const candidate = attempt === 0 ? base : base.replace(/\.json$/, '_' + attempt + '.json');
    try {
      const sha = await ghPut(candidate, text, 'chat: ' + title, null);
      return { path: candidate, sha };
    } catch (err) {
      if ((err.status === 422 || err.status === 409) && attempt < 6) {
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

async function doSave() {
  if (!state.messages.some((m) => m.role === 'user' && (m.content || (m.files && m.files.length)))) return;
  if (!ghReady()) {
    setSaveState('local');
    return;
  }
  if (!isDirty()) return;

  const sid = state.sid;
  setSaveState('saving');

  try {
    let path = state.current.path;
    let sha = state.current.sha;
    let title = state.current.title;
    const createdAt = state.current.createdAt || Date.now();

    if (!title) {
      try {
        title = await generateTitle(state.messages) || fallbackTitle();
      } catch (err) {
        console.warn('标题生成失败', err);
        title = fallbackTitle();
      }
    }
    if (sid !== state.sid) return;

    const text = JSON.stringify(chatData(title, createdAt, path), null, 2) + '\n';

    if (!path) {
      const created = await putNewChatFile(text, createdAt, title);
      path = created.path;
      sha = created.sha;
    } else {
      try {
        sha = await ghPut(path, text, 'chat: ' + title, sha);
      } catch (err) {
        if (err.status === 409 || err.status === 422) {
          const fresh = await ghGet(path);
          sha = await ghPut(path, text, 'chat: ' + title, fresh.sha);
        } else {
          throw err;
        }
      }
    }

    const hash = hashMessages();
    if (sid === state.sid) {
      state.current = { path, sha, title, createdAt, savedHash: hash };
      setSaveState('saved');
      $('#chatTitle').textContent = title;
    }
    upsertList({ path, sha, title, time: createdAt });
    persistDraft();
  } catch (err) {
    setSaveState('error');
    toast('保存失败：' + err.message, 4200);
    throw err;
  }
}

function upsertList(item) {
  const rest = state.list.filter((i) => i.path !== item.path);
  rest.push(item);
  rest.sort((a, b) => b.time - a.time);
  state.list = rest;
  try { localStorage.setItem(LS.list, JSON.stringify(rest)); } catch {}
  renderList();
}

/* ============================================================
 * 重命名对话
 * ============================================================ */

let renaming = false;

function cleanUserTitle(raw) {
  const t = String(raw || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[._-]+|[._-]+$/g, '');
  const chars = Array.from(t);
  return chars.slice(0, 24).join('');
}

function startRename() {
  if (renaming) return;
  if (state.streaming) {
    toast('正在生成回复，稍后再改标题', 2200);
    return;
  }
  const input = $('#titleInput');
  if (!input) return;
  renaming = true;
  input.value = state.current.title || '新对话';
  $('#btnRename').hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

function finishRename(commit) {
  if (!renaming) return;
  renaming = false;
  const input = $('#titleInput');
  const value = input ? input.value : '';
  if (input) input.hidden = true;
  const btn = $('#btnRename');
  if (btn) btn.hidden = false;
  if (commit) commitRename(value);
  else $('#chatTitle').textContent = state.current.title || '新对话';
}

let renameTask = Promise.resolve();

function commitRename(raw) {
  renameTask = renameTask.then(() => performRename(raw)).catch((err) => {
    console.warn('[rename]', err);
  });
  return renameTask;
}

async function performRename(raw) {
  const title = cleanUserTitle(raw);
  const prevTitle = state.current.title;

  if (!title || title === prevTitle) {
    $('#chatTitle').textContent = prevTitle || '新对话';
    if (!title && prevTitle) toast('标题不能为空', 2200);
    return;
  }

  state.current.title = title;
  $('#chatTitle').textContent = title;
  const hasUserMsg = state.messages.some((m) => m.role === 'user'
    && (m.content || (m.files && m.files.length)));

  if (!hasUserMsg) {
    persistDraft();
    return;
  }
  if (!ghReady()) {
    persistDraft();
    setSaveState('local');
    toast('标题已改，配置 GitHub 后会一起同步', 2600);
    return;
  }

  // 还没生成文件的新对话：直接用新标题走首次保存
  if (!state.current.path) {
    setSaveState('dirty');
    await enqueueSave({});
    return;
  }

  const sid = state.sid;
  const oldPath = state.current.path;
  const oldSha = state.current.sha;
  const createdAt = state.current.createdAt || Date.now();
  setSaveState('saving');

  try {
    const text = JSON.stringify(chatData(title, createdAt, oldPath), null, 2) + '\n';
    const created = await putNewChatFile(text, createdAt, title);
    if (sid !== state.sid) return;

    let deleteFailed = false;
    try {
      await ghDelete(oldPath, oldSha);
    } catch (err) {
      console.warn('[rename] 旧文件删除失败', err);
      deleteFailed = true;
    }

    const hash = hashMessages();
    state.current = {
      path: created.path,
      sha: created.sha,
      title,
      createdAt,
      savedHash: hash,
    };
    state.list = state.list.filter((i) => i.path !== oldPath);
    upsertList({ path: created.path, sha: created.sha, title, time: createdAt });
    persistDraft();
    setSaveState('saved');
    toast(deleteFailed ? '标题已更新，但旧文件删除失败，可在侧边栏手动删除' : '标题已更新',
      deleteFailed ? 4200 : 1800);
  } catch (err) {
    state.current.title = prevTitle;
    $('#chatTitle').textContent = prevTitle || '新对话';
    setSaveState('error');
    toast('重命名失败：' + err.message, 4200);
  }
}

/* ============================================================
 * 草稿（本地兜底）
 * ============================================================ */

function persistDraft() {
  if (!state.messages.length && !state.attachments.some((a) => a.status === 'ready')
    && !state.current.title) {
    localStorage.removeItem(LS.draft);
    return;
  }
  try {
    localStorage.setItem(LS.draft, JSON.stringify({
      at: Date.now(),
      model: state.model,
      search: state.searchOn,
      thinking: state.thinking,
      effort: state.effort,
      current: state.current,
      messages: state.messages,
      attachments: state.attachments
        .filter((a) => a.status === 'ready' && a.id)
        .map((a) => ({
          key: a.key, name: a.name, size: a.size, kind: a.kind,
          purpose: a.purpose, id: a.id, status: 'ready', progress: 100, error: '', url: '',
        })),
    }));
  } catch {}
}

function restoreDraft() {
  const d = readJSON(LS.draft, null);
  if (!d) return false;
  const hasMessages = Array.isArray(d.messages) && d.messages.length > 0;
  const hasFiles = Array.isArray(d.attachments) && d.attachments.length > 0;
  const hasTitle = Boolean(d.current && d.current.title);
  if (!hasMessages && !hasFiles && !hasTitle) return false;
  if (Date.now() - (d.at || 0) > 1000 * 60 * 60 * 24 * 30) return false;
  state.messages = hasMessages ? d.messages : [];
  state.thinking = Boolean(d.thinking) || d.model === 'deepseek-reasoner';
  if (EFFORTS.indexOf(d.effort) >= 0) state.effort = d.effort;
  state.current = Object.assign({ path: '', sha: '', title: '', createdAt: 0, savedHash: '' }, d.current || {});
  state.attachments = Array.isArray(d.attachments)
    ? d.attachments.filter((a) => a && a.id).map((a) => Object.assign({}, a, {
      status: 'ready', progress: 100, error: '', url: '',
    }))
    : [];
  renderAttachments();
  return true;
}

/* ============================================================
 * 渲染
 * ============================================================ */

function setupCard() {
  if (state.settings.apiKey && ghReady()) return null;
  const card = document.createElement('div');
  card.className = 'setup-card';
  card.innerHTML = '<div class="setup-head"><span>先完成两步配置</span>'
    + '<button class="mini-btn" type="button">去设置</button></div>'
    + '<div class="setup-row"><i class="dot"></i><b>DeepSeek API Key</b><span class="state"></span></div>'
    + '<div class="setup-row"><i class="dot"></i><b>GitHub 存储</b><span class="state"></span></div>';
  const rows = $$('.setup-row', card);
  const info = [
    [Boolean(state.settings.apiKey), '未填写', '已填写'],
    [ghReady(), '未配置', '已配置'],
  ];
  rows.forEach((row, i) => {
    if (info[i][0]) row.querySelector('.dot').classList.add('on');
    row.querySelector('.state').textContent = info[i][0] ? info[i][2] : info[i][1];
  });
  card.querySelector('.mini-btn').addEventListener('click', () => openSettings());
  return card;
}

function emptyState() {
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  wrap.innerHTML = '<h1>有什么可以帮你的吗？</h1>'
    + '<p>DeepThink 深度思考 · Search 联网检索</p>';
  const card = setupCard();
  if (card) wrap.appendChild(card);
  return wrap;
}

function addAct(container, label, handler) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'act-btn';
  b.textContent = label;
  b.addEventListener('click', handler);
  container.appendChild(b);
  return b;
}

function userNode(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (msg.content ? '' : ' files-only');
  if (msg.content) {
    const text = document.createElement('div');
    text.className = 'bubble-text';
    text.textContent = msg.content;
    bubble.appendChild(text);
  }
  if (msg.files && msg.files.length) bubble.appendChild(messageFilesNode(msg.files));
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  addAct(actions, '复制', () => copyText(msg.content));
  wrap.append(bubble, actions);
  return wrap;
}

function thinkLabel(msg) {
  if (msg.thinkMs) return '已深度思考（' + Math.max(1, Math.round(msg.thinkMs / 1000)) + ' 秒）';
  return '思考过程';
}

function assistantNode(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const think = document.createElement('details');
  think.className = 'think';
  think.hidden = !msg.reasoning;
  think.innerHTML = '<summary>' + thinkLabel(msg) + '</summary><div class="think-body"></div>';
  const thinkBody = think.querySelector('.think-body');
  if (msg.reasoning) thinkBody.textContent = msg.reasoning;

  const sourcesHost = document.createElement('div');
  sourcesHost.className = 'sources-host';
  renderSources(sourcesHost, msg);

  const md = document.createElement('div');
  md.className = 'md';
  if (msg.content) {
    md.innerHTML = renderMarkdown(msg.content);
    decorateCode(md);
  } else if (msg.error) {
    md.innerHTML = '<p style="color:var(--danger)">请求失败：' + esc(msg.error) + '</p>';
  } else if (!msg.searching) {
    md.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
  } else {
    md.innerHTML = '';
  }

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  bubble.append(think, sourcesHost, md);
  wrap.append(bubble, actions);

  if (msg.content && !msg.error) {
    addAct(actions, '复制', () => copyText(msg.content));
    if (msg === state.messages[state.messages.length - 1] && !state.streaming) {
      addAct(actions, '重新生成', regenerate);
    }
  }
  return { wrap, md, think, thinkBody, actions, sourcesHost };
}

function renderChat() {
  const chat = $('#chat');
  chat.innerHTML = '';
  if (!state.messages.length) {
    chat.appendChild(emptyState());
    setSaveState('');
    $('#chatTitle').textContent = state.current.title || 'DeepSeek Chat';
    return;
  }
  state.messages.forEach((m) => {
    chat.appendChild(m.role === 'user' ? userNode(m) : assistantNode(m).wrap);
  });
  const kind = state.current.savedHash
    ? (isDirty() ? 'dirty' : 'saved')
    : (ghReady() ? 'dirty' : 'local');
  setSaveState(kind);
  $('#chatTitle').textContent = state.current.title || '新对话';
  state.pinBottom = true;
  scrollToBottom(true);
}

function scrollToBottom(force) {
  const chat = $('#chat');
  if (!chat) return;
  if (!force && !state.pinBottom) return;
  chat.scrollTop = chat.scrollHeight;
}

function appendNode(node) {
  const chat = $('#chat');
  const empty = chat.querySelector('.empty');
  if (empty) empty.remove();
  chat.appendChild(node);
  scrollToBottom(true);
}

/* ============================================================
 * 模型 / 开关
 * ============================================================ */

function syncToggles() {
  $('#btnThink').classList.toggle('active', state.thinking);
  $('#btnThink').setAttribute('aria-pressed', state.thinking ? 'true' : 'false');
  $('#btnSearch').classList.toggle('active', state.searchOn);
  $('#btnSearch').setAttribute('aria-pressed', state.searchOn ? 'true' : 'false');
  const chip = $('#btnEffort');
  if (chip) chip.hidden = !state.thinking;
  const label = $('#effortLabel');
  if (label) label.textContent = state.effort === 'low' ? 'Low' : (state.effort === 'max' ? 'Max' : 'High');
  $$('#effortMenu button').forEach((b) => {
    b.classList.toggle('active', b.dataset.effort === state.effort);
  });
  if (!state.thinking) closeEffortMenu();
}

function closeEffortMenu() {
  const menu = $('#effortMenu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  const chip = $('#btnEffort');
  if (chip) chip.setAttribute('aria-expanded', 'false');
}

function toggleEffortMenu() {
  const menu = $('#effortMenu');
  if (!menu) return;
  if (menu.hidden) {
    menu.hidden = false;
    $('#btnEffort').setAttribute('aria-expanded', 'true');
  } else {
    closeEffortMenu();
  }
}

function setEffort(effort) {
  state.effort = EFFORTS.indexOf(effort) >= 0 ? effort : 'high';
  syncToggles();
  closeEffortMenu();
  persistDraft();
}

function toggleThink() {
  state.thinking = !state.thinking;
  if (state.thinking) state.effort = 'high';
  else closeEffortMenu();
  syncToggles();
  persistDraft();
}

function toggleSearch() {
  state.searchOn = !state.searchOn;
  syncToggles();
  toast(state.searchOn ? '已开启联网搜索' : '已关闭联网搜索', 1600);
}

/* ============================================================
 * 发送 / 流式
 * ============================================================ */

function autoGrow() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 200) + 'px';
}

function updateSendState() {
  const btn = $('#btnSend');
  const hasText = $('#input').value.trim().length > 0;
  const hasFiles = state.attachments.some((a) => a.status === 'ready');
  btn.classList.toggle('streaming', state.streaming);
  btn.disabled = state.streaming ? false : (!hasText && !hasFiles);
  btn.setAttribute('aria-label', state.streaming ? '停止生成' : '发送');
}

function lastUserText() {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    if (state.messages[i].role === 'user' && state.messages[i].content) return state.messages[i].content;
  }
  return '';
}

async function send(text) {
  if (state.streaming) return;
  const input = $('#input');
  const content = (text != null ? text : input.value).trim();
  const files = state.attachments
    .filter((a) => a.status === 'ready' && a.id)
    .map((a) => ({ id: a.id, name: a.name, size: a.size, kind: a.kind, purpose: a.purpose }));
  if (!content && !files.length) return;
  if (!state.settings.apiKey) {
    openSettings(true);
    toast('请先填写 DeepSeek API Key');
    return;
  }
  if (state.attachments.some((a) => a.status === 'uploading' || a.status === 'parsing')) {
    toast('文件还在上传中，请稍候');
    return;
  }

  const userMsg = { role: 'user', content, time: Date.now() };
  if (files.length) userMsg.files = files;
  state.messages.push(userMsg);
  input.value = '';
  autoGrow();
  // 文件已随消息发送，保留在服务端；只清空输入区的待发送列表
  clearAttachments(false);
  updateSendState();

  if (state.messages.length === 1) {
    renderChat();
  } else {
    appendNode(userNode(state.messages[state.messages.length - 1]));
  }
  setSaveState(ghReady() ? 'dirty' : 'local');
  persistDraft();

  await runCompletion();
}

async function regenerate() {
  if (state.streaming) return;
  while (state.messages.length && state.messages[state.messages.length - 1].role === 'assistant') {
    state.messages.pop();
  }
  if (!state.messages.length) return;
  renderChat();
  await runCompletion();
}

async function runCompletion() {
  if (!state.messages.some((m) => m.role === 'user')) return;

  const useSearch = state.searchOn;
  const msg = { role: 'assistant', content: '', reasoning: '', time: Date.now(), search: useSearch };
  if (useSearch) msg.searching = true;

  state.messages.push(msg);
  const ref = assistantNode(msg);
  appendNode(ref.wrap);

  state.streaming = true;
  updateSendState();
  const ctrl = new AbortController();
  state.controller = ctrl;

  const thinkStart = Date.now();
  let raf = 0;
  const paint = () => {
    raf = 0;
    if (msg.reasoning) {
      ref.think.hidden = false;
      ref.thinkBody.textContent = msg.reasoning;
      if (!msg.content) {
        const sum = ref.think.querySelector('summary');
        if (sum) sum.textContent = '正在深度思考…';
      }
    }
    if (msg.content) {
      ref.md.innerHTML = renderMarkdown(msg.content) + '<span class="cursor"></span>';
    }
    scrollToBottom();
  };

  try {
    let apiBody = apiMessages();

    const searchQuery = lastUserText();
    if (useSearch && searchQuery) {
      let sources = [];
      try {
        sources = await searchWeb(searchQuery, searchQuery);
      } catch (err) {
        msg.searchError = err.message || '搜索失败';
      }
      msg.searching = false;
      msg.sources = sources;
      renderSources(ref.sourcesHost, msg);
      if (!msg.content) ref.md.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
      if (sources.length) apiBody = [searchSystemMessage(sources)].concat(apiBody);
      scrollToBottom();
    } else if (useSearch) {
      // 只发了文件没有文字，没有可搜索的关键词
      msg.search = false;
      msg.searching = false;
      renderSources(ref.sourcesHost, msg);
      if (!msg.content) ref.md.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
      scrollToBottom();
    }

    await streamChat(apiBody, {
      signal: ctrl.signal,
      onDelta: (d) => {
        if (d.reasoning) {
          msg.reasoning += d.reasoning;
          if (!msg.content) ref.think.open = true;
        }
        if (d.content) msg.content += d.content;
        if (!raf) raf = requestAnimationFrame(paint);
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      if (!msg.content) msg.stopped = true;
    } else {
      msg.error = err.message || String(err);
    }
  } finally {
    state.streaming = false;
    state.controller = null;
    msg.searching = false;
    if (raf) { cancelAnimationFrame(raf); paint(); }

    if (msg.content) {
      ref.md.innerHTML = renderMarkdown(msg.content);
      decorateCode(ref.md);
    } else if (msg.error) {
      ref.md.innerHTML = '<p style="color:var(--danger)">请求失败：' + esc(msg.error) + '</p>';
    } else if (msg.stopped) {
      ref.md.innerHTML = '<p style="color:var(--text-3)">已停止生成</p>';
    } else {
      ref.md.innerHTML = '';
    }

    if (msg.reasoning) {
      msg.thinkMs = Date.now() - thinkStart;
      const sum = ref.think.querySelector('summary');
      if (sum) sum.textContent = thinkLabel(msg);
      ref.think.open = false;
    }

    ref.actions.innerHTML = '';
    if (msg.content && !msg.error) {
      addAct(ref.actions, '复制', () => copyText(msg.content));
      addAct(ref.actions, '重新生成', regenerate);
    }

    const last = state.messages[state.messages.length - 1];
    if (last && !last.content && !last.reasoning && !last.error) state.messages.pop();

    updateSendState();
    persistDraft();
    if (state.messages.some((m) => m.role === 'user')) {
      setSaveState(ghReady() ? 'dirty' : 'local');
      scheduleSave(1200);
    }
  }
}

function stopStream() {
  if (state.controller) state.controller.abort();
}

/* ============================================================
 * 记录列表
 * ============================================================ */

function timeLabel(t) {
  const d = new Date(t);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes());
  const sameYear = d.getFullYear() === now.getFullYear();
  return (sameYear ? '' : d.getFullYear() + '/') + (d.getMonth() + 1) + '/' + d.getDate();
}

function monthLabel(t) {
  const d = new Date(t);
  const now = new Date();
  if (d.getFullYear() === now.getFullYear()) return d.getMonth() + 1 + ' 月';
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月';
}

function renderList() {
  const box = $('#drawerList');
  const keyword = ($('#searchInput').value || '').trim().toLowerCase();
  const items = state.list.filter((i) => !keyword || String(i.title).toLowerCase().indexOf(keyword) >= 0);

  box.innerHTML = '';

  if (!ghReady()) {
    const tip = document.createElement('div');
    tip.className = 'sb-empty';
    tip.innerHTML = '<div class="sb-empty-tip">还没有配置 GitHub 存储。<br>配置后对话会自动同步，<br>换设备也能接着聊。</div>';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost-btn';
    btn.textContent = '去配置';
    btn.addEventListener('click', () => openSettings());
    tip.appendChild(btn);
    box.appendChild(tip);
    return;
  }

  if (!items.length) {
    const tip = document.createElement('div');
    tip.className = 'sb-empty';
    tip.textContent = keyword ? '没有匹配的对话' : '还没有对话记录';
    box.appendChild(tip);
    return;
  }

  let currentMonth = '';
  items.forEach((item) => {
    const m = monthLabel(item.time);
    if (m !== currentMonth) {
      currentMonth = m;
      const label = document.createElement('div');
      label.className = 'group-label';
      label.textContent = m;
      box.appendChild(label);
    }

    const row = document.createElement('div');
    row.className = 'conv-item' + (item.path === state.current.path ? ' active' : '');
    row.innerHTML = '<div class="conv-main"><div class="conv-name"></div><div class="conv-time"></div></div>'
      + '<button class="conv-del" type="button" aria-label="删除">'
      + '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>'
      + '</button>';
    row.querySelector('.conv-name').textContent = item.title;
    row.querySelector('.conv-time').textContent = timeLabel(item.time);
    row.addEventListener('click', () => openConv(item));
    row.querySelector('.conv-del').addEventListener('click', (ev) => deleteConv(item, ev));
    box.appendChild(row);
  });
}

async function loadList(opts) {
  const silent = opts && opts.silent;
  $('#repoLabel').textContent = ghReady()
    ? state.settings.ghOwner + '/' + state.settings.ghRepo + ' · ' + (ghDir() || '/')
    : '未配置 GitHub';

  if (!ghReady()) {
    state.list = readJSON(LS.list, []) || [];
    renderList();
    return;
  }

  try {
    state.list = await ghList();
    try { localStorage.setItem(LS.list, JSON.stringify(state.list)); } catch {}
  } catch (err) {
    state.list = readJSON(LS.list, []) || [];
    if (!silent) toast('读取记录失败：' + err.message, 4200);
  }
  renderList();
}

/* ============================================================
 * 对话切换
 * ============================================================ */

function resetChat() {
  state.sid += 1;
  if (renaming) finishRename(false);
  clearAttachments(true);
  state.messages = [];
  state.searchOn = false;
  state.thinking = false;
  state.effort = 'high';
  syncToggles();
  state.current = { path: '', sha: '', title: '', createdAt: 0, savedHash: '' };
  localStorage.removeItem(LS.draft);
  renderChat();
  renderList();
  updateSendState();
}

async function newChat() {
  if (state.streaming) stopStream();
  await renameTask;
  await flushSave();
  resetChat();
  closeSidebar();
  $('#input').focus();
}

async function openConv(item) {
  closeSidebar();
  if (state.streaming) stopStream();
  if (item.path === state.current.path) return;

  await renameTask;
  await flushSave();
  if (renaming) finishRename(false);
  clearAttachments(true);
  const sid = ++state.sid;
  const chat = $('#chat');
  chat.innerHTML = '<div class="sb-empty" style="margin:auto">加载中…</div>';

  try {
    const file = await ghGet(item.path);
    if (sid !== state.sid) return;
    const data = JSON.parse(file.text);
    state.messages = Array.isArray(data.messages)
      ? data.messages.map((m) => Object.assign({}, m, { time: m.time ? new Date(m.time).getTime() : item.time }))
      : [];
    state.thinking = Boolean(data.thinking) || data.model === 'deepseek-reasoner';
    state.effort = EFFORTS.indexOf(data.effort) >= 0 ? data.effort : 'high';
    state.current = {
      path: item.path,
      sha: file.sha,
      title: data.title || item.title,
      createdAt: data.createdAt ? new Date(data.createdAt).getTime() : item.time,
      savedHash: '',
    };
    syncToggles();
    renderChat();
    state.current.savedHash = hashMessages();
    setSaveState('saved');
    persistDraft();
    renderList();
  } catch (err) {
    chat.innerHTML = '';
    chat.appendChild(emptyState());
    toast('打开失败：' + err.message, 4200);
  }
}

async function deleteConv(item, ev) {
  ev.stopPropagation();
  if (!ghReady()) return;
  const ok = await askConfirm(
    '删除这个对话？',
    '「' + item.title + '」的记录文件会从 GitHub 仓库移除，无法恢复。',
    '删除'
  );
  if (!ok) return;
  try {
    await ghDelete(item.path, item.sha);
    state.list = state.list.filter((i) => i.path !== item.path);
    try { localStorage.setItem(LS.list, JSON.stringify(state.list)); } catch {}
    if (state.current.path === item.path) resetChat();
    else renderList();
    toast('已删除');
  } catch (err) {
    toast('删除失败：' + err.message, 4200);
  }
}

/* ============================================================
 * 二次确认
 * ============================================================ */

let confirmResolve = null;

function askConfirm(title, message, okText) {
  const modal = $('#confirmModal');
  if (!modal) return Promise.resolve(false);
  if (confirmResolve) {
    const prev = confirmResolve;
    confirmResolve = null;
    prev(false);
  }
  $('#confirmTitle').textContent = title || '确认操作';
  $('#confirmText').textContent = message || '';
  $('#btnConfirmOk').textContent = okText || '确定';
  modal.classList.add('show');
  setTimeout(() => {
    const cancel = $('#btnConfirmCancel');
    if (cancel) cancel.focus();
  }, 40);
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function closeConfirm(ok) {
  const modal = $('#confirmModal');
  if (modal) modal.classList.remove('show');
  const fn = confirmResolve;
  confirmResolve = null;
  if (fn) fn(Boolean(ok));
}

/* ============================================================
 * 设置面板
 * ============================================================ */

function openSettings(firstRun) {
  const s = state.settings;
  $('#setApiKey').value = s.apiKey || '';
  $('#setApiBase').value = s.apiBase || DEFAULT_SETTINGS.apiBase;
  $('#setGhToken').value = s.ghToken || '';
  $('#setGhOwner').value = s.ghOwner || '';
  $('#setGhRepo').value = s.ghRepo || '';
  $('#setGhBranch').value = s.ghBranch || 'main';
  $('#setGhDir').value = s.ghDir || '';
  $('#setTheme').value = state.themePref;
  $('#settingsTitle').textContent = firstRun ? '开始使用' : '设置';
  $('#settingsSub').textContent = firstRun
    ? '填写自己的 API Key 与 GitHub 仓库，对话就会自动存进你的 repo'
    : '对话自动保存到你的 GitHub 仓库';
  $('#settingsModal').classList.add('show');
  refreshUsage(false);
}

function closeSettings() {
  $('#settingsModal').classList.remove('show');
}

function collectSettings() {
  state.settings = {
    apiKey: $('#setApiKey').value.trim(),
    apiBase: $('#setApiBase').value.trim() || DEFAULT_SETTINGS.apiBase,
    model: DEFAULT_SETTINGS.model,
    ghToken: $('#setGhToken').value.trim(),
    ghOwner: $('#setGhOwner').value.trim(),
    ghRepo: $('#setGhRepo').value.trim(),
    ghBranch: $('#setGhBranch').value.trim() || 'main',
    ghDir: $('#setGhDir').value.trim().replace(/^\/+|\/+$/g, ''),
  };
  persistSettings();
  applyTheme($('#setTheme').value);
  syncToggles();
}

async function testConnections() {
  collectSettings();
  const results = [];

  if (state.settings.apiKey) {
    try {
      const res = await fetch(apiUrl('/models'), { headers: { Authorization: 'Bearer ' + state.settings.apiKey } });
      results.push(res.ok ? 'DeepSeek 正常' : 'DeepSeek ' + res.status);
    } catch (err) {
      results.push('DeepSeek 连接失败');
    }
  } else {
    results.push('DeepSeek 未填写 Key');
  }

  if (ghReady()) {
    try {
      await ghList();
      results.push('GitHub 正常');
      loadList({ silent: true });
    } catch (err) {
      results.push('GitHub ' + err.message);
    }
  } else {
    results.push('GitHub 未配置');
  }

  toast(results.join(' · '), 4200);
}

/* ============================================================
 * 侧边栏
 * ============================================================ */

function openSidebar() {
  $('#sidebar').classList.add('show');
  $('#scrim').classList.add('show');
  renderList();
}

function closeSidebar() {
  $('#sidebar').classList.remove('show');
  $('#scrim').classList.remove('show');
}

function setCollapsed(collapsed) {
  $('#app').classList.toggle('collapsed', collapsed);
  try { localStorage.setItem(LS.collapsed, collapsed ? '1' : '0'); } catch {}
}

/* ============================================================
 * 事件 & 初始化
 * ============================================================ */

function bind() {
  $('#btnMenu').addEventListener('click', openSidebar);
  $('#scrim').addEventListener('click', closeSidebar);
  $('#btnNew').addEventListener('click', newChat);
  $('#btnNewMobile').addEventListener('click', newChat);
  $('#btnCollapse').addEventListener('click', () => setCollapsed(true));
  $('#btnExpand').addEventListener('click', () => setCollapsed(false));
  $('#btnSettings').addEventListener('click', () => { closeSidebar(); openSettings(); });
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  $('#btnSaveSettings').addEventListener('click', () => {
    collectSettings();
    closeSettings();
    loadList({ silent: true });
    renderChat();
    if (isDirty()) scheduleSave(300);
    refreshUsage(false);
    toast('设置已保存');
  });
  $('#btnTest').addEventListener('click', testConnections);
  $('#btnUsageRefresh').addEventListener('click', () => refreshUsage(true));
  $('#searchInput').addEventListener('input', renderList);

  $('#btnRename').addEventListener('click', startRename);
  const titleInput = $('#titleInput');
  titleInput.addEventListener('keydown', (ev) => {
    if (ev.isComposing) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      finishRename(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      finishRename(false);
    }
  });
  titleInput.addEventListener('blur', () => finishRename(true));

  $('#settingsModal').addEventListener('click', (ev) => {
    if (ev.target === $('#settingsModal')) closeSettings();
  });

  $('#btnConfirmCancel').addEventListener('click', () => closeConfirm(false));
  $('#btnConfirmOk').addEventListener('click', () => closeConfirm(true));
  $('#confirmModal').addEventListener('click', (ev) => {
    if (ev.target === $('#confirmModal')) closeConfirm(false);
  });

  $('#btnThink').addEventListener('click', toggleThink);
  $('#btnSearch').addEventListener('click', toggleSearch);
  $('#btnEffort').addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleEffortMenu();
  });
  $$('#effortMenu button').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setEffort(b.dataset.effort);
    });
  });

  $('#btnSend').addEventListener('click', () => {
    if (state.streaming) stopStream();
    else send();
  });

  $('#btnAttach').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (ev) => {
    addFiles(ev.target.files);
    ev.target.value = '';
  });

  const input = $('#input');
  input.addEventListener('input', () => { autoGrow(); updateSendState(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
    if (window.matchMedia('(pointer: coarse)').matches) return;
    ev.preventDefault();
    send();
  });


  $('#chat').addEventListener('scroll', () => {
    const chat = $('#chat');
    state.pinBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 90;
  });

  document.addEventListener('click', (ev) => {
    if (!ev.target.closest || !ev.target.closest('.effort-wrap')) closeEffortMenu();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if ($('#confirmModal').classList.contains('show')) {
      closeConfirm(false);
      return;
    }
    closeSettings();
    closeSidebar();
    closeEffortMenu();
  });

  window.addEventListener('pagehide', () => {
    persistDraft();
    if (isDirty() && ghReady()) enqueueSave({});
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistDraft();
  });
}

function init() {
  initTheme();
  bind();
  setCollapsed(localStorage.getItem(LS.collapsed) === '1');
  syncToggles();
  $('#setTheme').value = state.themePref;

  const restored = restoreDraft();
  renderChat();
  if (restored && isDirty()) scheduleSave(2000);

  updateSendState();
  loadList({ silent: true });

  if (!state.settings.apiKey || !ghReady()) {
    setTimeout(() => openSettings(true), 500);
  }
}

init();
