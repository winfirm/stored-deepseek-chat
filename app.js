'use strict';

/* ============================================================
 * DeepSeek Chat · 纯前端 H5
 * - 对话直连 DeepSeek API（浏览器 SSE 流式）
 * - 记录保存到 GitHub 仓库（git tree 取列表 + contents 读写）
 * ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const LS = {
  settings: 'dsc.settings',
  list: 'dsc.list',
  draft: 'dsc.draft',
  theme: 'dsc.theme',
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
};

const MODELS = ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'];
state.model = MODELS.indexOf(state.settings.model) >= 0 ? state.settings.model : DEFAULT_SETTINGS.model;

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
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && !m.error)
    .map((m) => ({ role: m.role, content: m.content }));
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
  };
  if (state.model !== 'deepseek-reasoner') body.temperature = 1;

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
    .filter((m) => m.content && !m.error)
    .slice(-8)
    .map((m) => (m.role === 'user' ? '用户：' : '助手：') + m.content)
    .join('\n')
    .slice(0, 2400);

  const model = state.model === 'deepseek-reasoner' ? 'deepseek-flash' : state.model;
  const res = await fetch(apiUrl('/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + state.settings.apiKey,
    },
    body: JSON.stringify({
      model,
      stream: false,
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
  const first = state.messages.find((m) => m.role === 'user' && m.content);
  const t = cleanTitle(first ? first.content : '新对话');
  return Array.from(t).slice(0, 16).join('') || '新对话';
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
    .map((m) => m.role + '\u0001' + (m.content || '') + '\u0001' + (m.reasoning || ''))
    .join('\u0002');
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ':' + s.length;
}

function isDirty() {
  return state.messages.some((m) => m.role === 'user' && m.content)
    && hashMessages() !== state.current.savedHash;
}

function setSaveState(kind) {
  const el = $('#saveState');
  if (!el) return;
  if (!state.messages.length || !kind) {
    el.textContent = '';
    el.style.display = 'none';
    el.removeAttribute('data-s');
    return;
  }
  el.style.display = '';
  const map = { local: '仅本地', saving: '同步中', saved: '已同步', error: '同步失败', dirty: '待同步' };
  el.dataset.s = kind;
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

async function doSave() {
  if (!state.messages.some((m) => m.role === 'user' && m.content)) return;
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

    const data = {
      id: path,
      title,
      model: state.model,
      createdAt: new Date(createdAt).toISOString(),
      updatedAt: new Date().toISOString(),
      messages: state.messages
        .filter((m) => !m.error && (m.content || m.reasoning))
        .map((m) => {
          const out = { role: m.role, content: m.content, time: new Date(m.time || Date.now()).toISOString() };
          if (m.reasoning) out.reasoning = m.reasoning;
          return out;
        }),
    };
    const text = JSON.stringify(data, null, 2) + '\n';

    if (!path) {
      const base = joinPath(ghDir(), makeFileName(createdAt, title));
      let attempt = 0;
      for (;;) {
        const candidate = attempt === 0 ? base : base.replace(/\.json$/, '_' + attempt + '.json');
        try {
          sha = await ghPut(candidate, text, 'chat: ' + title, null);
          path = candidate;
          break;
        } catch (err) {
          if ((err.status === 422 || err.status === 409) && attempt < 6) {
            attempt += 1;
            continue;
          }
          throw err;
        }
      }
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
 * 草稿（本地兜底）
 * ============================================================ */

function persistDraft() {
  if (!state.messages.length) {
    localStorage.removeItem(LS.draft);
    return;
  }
  try {
    localStorage.setItem(LS.draft, JSON.stringify({
      at: Date.now(),
      model: state.model,
      current: state.current,
      messages: state.messages,
    }));
  } catch {}
}

function restoreDraft() {
  const d = readJSON(LS.draft, null);
  if (!d || !Array.isArray(d.messages) || !d.messages.length) return false;
  if (Date.now() - (d.at || 0) > 1000 * 60 * 60 * 24 * 30) return false;
  state.messages = d.messages;
  state.model = d.model || state.model;
  state.current = Object.assign({ path: '', sha: '', title: '', createdAt: 0, savedHash: '' }, d.current || {});
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
  wrap.innerHTML = '<div class="empty-logo">DS</div>'
    + '<h1>我是 DeepSeek</h1>'
    + '<p>有什么可以帮你的吗？</p>'
    + '<div class="chips"></div>';
  const chips = [
    '用简单的语言解释量子纠缠',
    '写一个 Python 爬虫骨架',
    '帮我把这段话改得更正式',
    '给我的周末旅行做个计划',
  ];
  const box = wrap.querySelector('.chips');
  chips.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = c;
    b.addEventListener('click', () => {
      $('#input').value = c;
      autoGrow();
      updateSendState();
      $('#input').focus();
    });
    box.appendChild(b);
  });
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
  bubble.className = 'bubble';
  bubble.textContent = msg.content || '';
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  addAct(actions, '复制', () => copyText(msg.content));
  wrap.append(bubble, actions);
  return wrap;
}

function assistantNode(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const think = document.createElement('details');
  think.className = 'think';
  think.hidden = !msg.reasoning;
  think.innerHTML = '<summary>思考过程</summary><div class="think-body"></div>';
  const thinkBody = think.querySelector('.think-body');
  if (msg.reasoning) thinkBody.textContent = msg.reasoning;

  const md = document.createElement('div');
  md.className = 'md';
  if (msg.content) {
    md.innerHTML = renderMarkdown(msg.content);
    decorateCode(md);
  } else if (msg.error) {
    md.innerHTML = '<p style="color:var(--danger)">请求失败：' + esc(msg.error) + '</p>';
  } else {
    md.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
  }

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  bubble.append(think, md);
  wrap.append(bubble, actions);

  if (msg.content && !msg.error) {
    addAct(actions, '复制', () => copyText(msg.content));
    if (msg === state.messages[state.messages.length - 1] && !state.streaming) {
      addAct(actions, '重新生成', regenerate);
    }
  }
  return { wrap, md, think, thinkBody, actions };
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
 * 发送 / 流式
 * ============================================================ */

function autoGrow() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 168) + 'px';
}

function updateSendState() {
  const btn = $('#btnSend');
  const hasText = $('#input').value.trim().length > 0;
  btn.classList.toggle('streaming', state.streaming);
  btn.disabled = state.streaming ? false : !hasText;
  btn.setAttribute('aria-label', state.streaming ? '停止生成' : '发送');
}

async function send(text) {
  if (state.streaming) return;
  const input = $('#input');
  const content = (text != null ? text : input.value).trim();
  if (!content) return;
  if (!state.settings.apiKey) {
    openSettings(true);
    toast('请先填写 DeepSeek API Key');
    return;
  }

  state.messages.push({ role: 'user', content, time: Date.now() });
  input.value = '';
  autoGrow();
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

  const msg = { role: 'assistant', content: '', reasoning: '', time: Date.now() };
  state.messages.push(msg);
  const ref = assistantNode(msg);
  appendNode(ref.wrap);

  state.streaming = true;
  updateSendState();
  const ctrl = new AbortController();
  state.controller = ctrl;

  let raf = 0;
  const paint = () => {
    raf = 0;
    if (msg.reasoning) {
      ref.think.hidden = false;
      ref.thinkBody.textContent = msg.reasoning;
    }
    if (msg.content) {
      ref.md.innerHTML = renderMarkdown(msg.content) + '<span class="cursor"></span>';
    }
    scrollToBottom();
  };

  try {
    await streamChat(apiMessages(), {
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
    tip.className = 'drawer-empty';
    tip.innerHTML = '还没有配置 GitHub 存储。<br>配置后对话会自动同步到仓库，<br>换设备也能接着聊。';
    box.appendChild(tip);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost-btn';
    btn.style.margin = '0 auto';
    btn.textContent = '去配置';
    btn.addEventListener('click', () => openSettings());
    box.appendChild(btn);
    return;
  }

  if (!items.length) {
    const tip = document.createElement('div');
    tip.className = 'drawer-empty';
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
  state.messages = [];
  state.current = { path: '', sha: '', title: '', createdAt: 0, savedHash: '' };
  localStorage.removeItem(LS.draft);
  renderChat();
  renderList();
  updateSendState();
}

async function newChat() {
  if (state.streaming) stopStream();
  await flushSave();
  resetChat();
  closeDrawer();
  $('#input').focus();
}

async function openConv(item) {
  closeDrawer();
  if (state.streaming) stopStream();
  if (item.path === state.current.path) return;

  await flushSave();
  const sid = ++state.sid;
  const chat = $('#chat');
  chat.innerHTML = '<div class="drawer-empty" style="height:100%;display:grid;place-items:center">加载中…</div>';

  try {
    const file = await ghGet(item.path);
    if (sid !== state.sid) return;
    const data = JSON.parse(file.text);
    state.messages = Array.isArray(data.messages)
      ? data.messages.map((m) => Object.assign({}, m, { time: m.time ? new Date(m.time).getTime() : item.time }))
      : [];
    state.model = MODELS.indexOf(data.model) >= 0 ? data.model : state.model;
    state.current = {
      path: item.path,
      sha: file.sha,
      title: data.title || item.title,
      createdAt: data.createdAt ? new Date(data.createdAt).getTime() : item.time,
      savedHash: '',
    };
    $('#modelSelect').value = state.model;
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
  if (!window.confirm('删除「' + item.title + '」？文件会从 GitHub 仓库中移除。')) return;
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
 * 设置面板
 * ============================================================ */

function openSettings(firstRun) {
  const s = state.settings;
  $('#setApiKey').value = s.apiKey || '';
  $('#setApiBase').value = s.apiBase || DEFAULT_SETTINGS.apiBase;
  $('#setModel').value = s.model || 'deepseek-chat';
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
}

function closeSettings() {
  $('#settingsModal').classList.remove('show');
}

function collectSettings() {
  state.settings = {
    apiKey: $('#setApiKey').value.trim(),
    apiBase: $('#setApiBase').value.trim() || DEFAULT_SETTINGS.apiBase,
    model: $('#setModel').value,
    ghToken: $('#setGhToken').value.trim(),
    ghOwner: $('#setGhOwner').value.trim(),
    ghRepo: $('#setGhRepo').value.trim(),
    ghBranch: $('#setGhBranch').value.trim() || 'main',
    ghDir: $('#setGhDir').value.trim().replace(/^\/+|\/+$/g, ''),
  };
  state.model = state.settings.model;
  $('#modelSelect').value = state.model;
  persistSettings();
  applyTheme($('#setTheme').value);
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
 * 抽屉
 * ============================================================ */

function openDrawer() {
  $('#drawer').classList.add('show');
  $('#scrim').classList.add('show');
  renderList();
}

function closeDrawer() {
  $('#drawer').classList.remove('show');
  $('#scrim').classList.remove('show');
}

/* ============================================================
 * 事件 & 初始化
 * ============================================================ */

function bind() {
  $('#btnMenu').addEventListener('click', openDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#btnNew').addEventListener('click', newChat);
  $('#btnNew2').addEventListener('click', newChat);
  $('#btnSettingsTop').addEventListener('click', () => openSettings());
  $('#btnSettings').addEventListener('click', () => { closeDrawer(); openSettings(); });
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  $('#btnSaveSettings').addEventListener('click', () => {
    collectSettings();
    closeSettings();
    loadList({ silent: true });
    renderChat();
    if (isDirty()) scheduleSave(300);
    toast('设置已保存');
  });
  $('#btnTest').addEventListener('click', testConnections);
  $('#btnRefresh').addEventListener('click', () => { loadList({}); });
  $('#searchInput').addEventListener('input', renderList);

  $('#settingsModal').addEventListener('click', (ev) => {
    if (ev.target === $('#settingsModal')) closeSettings();
  });

  $('#btnSend').addEventListener('click', () => {
    if (state.streaming) stopStream();
    else send();
  });

  const input = $('#input');
  input.addEventListener('input', () => { autoGrow(); updateSendState(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
    if (window.matchMedia('(pointer: coarse)').matches) return;
    ev.preventDefault();
    send();
  });

  $('#modelSelect').addEventListener('change', (ev) => {
    state.model = ev.target.value;
    state.settings.model = state.model;
    persistSettings();
  });

  $('#chat').addEventListener('scroll', () => {
    const chat = $('#chat');
    state.pinBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 90;
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      closeSettings();
      closeDrawer();
    }
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
  $('#modelSelect').value = state.model;
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
