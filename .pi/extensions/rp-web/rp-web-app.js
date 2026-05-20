/**
 * RP Web App - 乐园回响角色扮演专用 Web 前端
 * 基于 tau-mirror 的消息镜像机制，增加 RP 副视角和状态面板
 */

import { MessageRenderer } from './rp-web-message-renderer.js';

// ============================================================
// WebSocket 连接
// ============================================================

const wsUrl = `ws://${window.location.host}/ws`;
let ws = null;
let reconnectTimer = null;
let isConnected = false;

const messageRenderer = new MessageRenderer(document.getElementById('messages'));

// UI elements
const messageInput = document.getElementById('message-input');
const chatForm = document.getElementById('chat-form');
const sendBtn = document.getElementById('send-btn');
const abortBtn = document.getElementById('abort-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');

// RP 模式
const rpModeBtn = document.getElementById('rp-mode-btn');
const rpStatusBtn = document.getElementById('rp-status-btn');
const rpStatusOverlay = document.getElementById('rp-status-overlay');
const rpStatusClose = document.getElementById('rp-status-close');
const rpStatusContent = document.getElementById('rp-status-content');

let rpMode = true;  // RP 专用页面，默认开启
let currentStreamingElement = null;
let currentStreamingText = '';
let hasShownPicker = false;  // 是否已经弹出过会话选择器

// ============================================================
// 会话选择器
// ============================================================

const sessionPickerOverlay = document.getElementById('session-picker-overlay');
const sessionPickerList = document.getElementById('session-picker-list');
const sessionPickerNew = document.getElementById('session-picker-new');

function showSessionPicker() {
  sessionPickerOverlay.classList.add('open');
  sessionPickerList.innerHTML = '<div style="text-align:center;padding:20px;color:#8899bb;">加载中...</div>';
  sendCommand('list_sessions');
}

function hideSessionPicker() {
  sessionPickerOverlay.classList.remove('open');
}

function renderSessionPicker(sessions) {
  if (!sessions || sessions.length === 0) {
    sessionPickerList.innerHTML = '<div style="text-align:center;padding:30px;color:#8899bb;">暂无历史会话，点击下方按钮开始新会话</div>';
    return;
  }
  let html = '';
  for (const s of sessions) {
    const date = new Date(s.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const preview = s.preview ? s.preview.slice(0, 60) : '(空)';
    html += `<button class="session-picker-item" data-file="${s.file}">
      <span class="sp-date">${date}</span>
      <span class="sp-preview">${escapeHtml(preview)}</span>
      <span class="sp-size">${(s.size / 1024).toFixed(0)}KB</span>
    </button>`;
  }
  sessionPickerList.innerHTML = html;
  
  // 绑定点击
  document.querySelectorAll('.session-picker-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const file = btn.dataset.file;
      hideSessionPicker();
      // 通过命令加载旧会话
      sendCommand('load_session', { file });
    });
  });
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ============================================================
// WebSocket
// ============================================================

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    isConnected = true;
    statusIndicator.style.background = '#4caf50';
    statusText.textContent = 'Connected';
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // 只在第一次连接时弹出会话选择器
    if (!hasShownPicker) {
      hasShownPicker = true;
      showSessionPicker();
    }
    // 请求初始同步
    sendCommand('mirror_sync_request');
  };

  ws.onclose = () => {
    isConnected = false;
    statusIndicator.style.background = '#f44336';
    statusText.textContent = 'Disconnected';
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(connect, 3000);
    }
  };

  ws.onerror = () => {
    statusIndicator.style.background = '#ff9800';
    statusText.textContent = 'Error';
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  };
}

function sendCommand(type, extra = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...extra }));
}

// ============================================================
// 消息处理
// ============================================================

function handleMessage(msg) {
  switch (msg.type) {
    case 'mirror_sync':
      handleMirrorSync(msg);
      break;
    case 'event':
      handleRPCEvent(msg.event);
      break;
    case 'response':
      handleResponse(msg);
      break;
    case 'rp_state':
      handleRPState(msg);
      break;
    case 'sessions_list':
      renderSessionPicker(msg.sessions);
      break;
    case 'new_session_started':
      messageRenderer.clear();
      messageRenderer.renderWelcome();
      break;
    default:
      console.log('Unknown message type:', msg.type);
  }
}

function handleMirrorSync(data) {
  // 重建消息历史
  if (data.entries && Array.isArray(data.entries)) {
    messageRenderer.clear();
    for (const entry of data.entries) {
      if (entry.type === 'message' && entry.message) {
        const msg = entry.message;
        if (msg.role === 'user') {
          messageRenderer.renderUserMessage(msg, true);
        } else if (msg.role === 'assistant') {
          messageRenderer.renderAssistantMessage(msg, false, true);
        }
      }
    }
  }

  // 更新模型信息
  if (data.model) {
    const label = document.getElementById('model-dropdown-label');
    if (label) label.textContent = data.model.id || data.model;
  }

  isStreaming = data.isStreaming || false;
  updateUI();
}

function handleRPCEvent(event) {
  switch (event.type) {
    case 'agent_start':
      isStreaming = true;
      updateUI();
      break;
    case 'agent_end':
      isStreaming = false;
      currentStreamingElement = null;
      currentStreamingText = '';
      updateUI();
      break;
    case 'message_start':
      handleMessageStart(event.message);
      break;
    case 'message_update':
      handleMessageUpdate(event);
      break;
    case 'message_end':
      handleMessageEnd(event.message);
      break;
    case 'session_name':
      if (event.name) document.title = event.name + ' · RP';
      break;
  }
}

function handleMessageStart(message) {
  if (message.role === 'assistant') {
    currentStreamingText = '';
    currentStreamingElement = messageRenderer.renderAssistantMessage(
      { content: '' },
      true
    );
  } else if (message.role === 'user') {
    const text = getMessageText(message);
    if (text) {
      messageRenderer.renderUserMessage({ content: text });
    }
  }
}

function getMessageText(message) {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return '';
}

function handleMessageUpdate(event) {
  const { assistantMessageEvent } = event;
  if (assistantMessageEvent.type === 'text_delta' && currentStreamingElement) {
    currentStreamingText += assistantMessageEvent.delta;
    messageRenderer.updateStreamingMessage(currentStreamingElement, currentStreamingText);
  }
}

function handleMessageEnd(message) {
  if (currentStreamingElement) {
    messageRenderer.finalizeStreamingMessage(currentStreamingElement, message?.usage, '');
    currentStreamingElement = null;
  }
}

function handleResponse(msg) {
  // RPC 响应处理
  console.log('RPC response:', msg);
}

function handleRPState(msg) {
  // 渲染状态面板
  const data = msg.data;
  if (!data) {
    rpStatusContent.innerHTML = '<div style="text-align:center;padding:20px;color:#888;">暂无角色数据</div>';
    return;
  }
  renderStatusPanel(data);
}

// ============================================================
// 状态面板渲染
// ============================================================

function renderStatusPanel(data) {
  const world = data['世界'] || {};
  const ignoreKeys = ['世界', '_meta', '{{user}}'];
  const charKeys = Object.keys(data).filter(k => !ignoreKeys.includes(k));

  let html = '';

  // 世界信息
  html += `<div class="rp-world-strip">
    <div class="rp-world-item"><span class="label">DATE</span> ${world['当前日期'] || '--'}</div>
    <div class="rp-world-item"><span class="label">WEEK</span> ${world['当前星期'] || '--'}</div>
    <div class="rp-world-item"><span class="label">TIME</span> ${world['当前时间'] || '--'}</div>
    <div class="rp-world-item"><span class="label">LOC</span> ${world['当前位置'] || '--'}</div>
  </div>`;

  // 角色 Tab 导航
  html += `<div class="rp-char-tabs" id="rp-char-tabs">`;
  charKeys.forEach((key, i) => {
    const char = data[key];
    const name = (char['基本信息'] && char['基本信息']['姓名']) || key;
    html += `<button class="rp-char-tab ${i === 0 ? 'active' : ''}" data-char="${key}">${name}</button>`;
  });
  html += `</div>`;

  // 内容区
  html += `<div id="rp-char-detail">`;
  if (charKeys.length > 0) {
    html += renderCharDetail(data, charKeys[0]);
  }
  html += `</div>`;

  rpStatusContent.innerHTML = html;

  // 绑定 Tab 点击
  document.querySelectorAll('.rp-char-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rp-char-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const key = btn.dataset.char;
      document.getElementById('rp-char-detail').innerHTML = renderCharDetail(data, key);
    });
  });
}

function renderCharDetail(data, key) {
  const char = data[key];
  if (!char) return '<div>无数据</div>';

  const name = (char['基本信息'] && char['基本信息']['姓名']) || key;
  const identity = char['身份'] || '';
  const age = char['年龄'] || '?';
  const status = char['当前状态'] || {};
  const phys = char['生理状态'] || {};
  const flower = char['花开蒂落'] || {};

  let html = `<div class="rp-char-header">
    <div class="rp-char-name">${name}</div>
    <div class="rp-char-meta">${age}岁 · ${identity}</div>
  </div>`;

  // 位置和想法
  html += `<div class="rp-data-box" style="margin-bottom:8px;">
    <div class="box-title">当前状态</div>
    <div class="rp-data-row"><span class="rp-data-label">📍 地点</span><span class="rp-data-value">${status['所在地点'] || '未知'}</span></div>
    <div class="rp-data-row"><span class="rp-data-label">💭 想法</span><span class="rp-data-value" style="font-style:italic;">"${(status['内心想法'] || '').substring(0, 60)}"</span></div>
  </div>`;

  // 归属/情分
  if (char['归属值'] !== undefined || char['情分值'] !== undefined) {
    html += `<div class="rp-data-grid">`;
    if (char['归属值'] !== undefined) {
      const v = Math.min(100, Math.max(0, char['归属值']));
      html += `<div class="rp-data-box">
        <div class="box-title">归属值</div>
        <div style="text-align:right;">${v}</div>
        <div class="rp-bar-container"><div class="rp-bar-fill" style="width:${v}%;background:#90caf9;"></div></div>
      </div>`;
    }
    if (char['情分值'] !== undefined) {
      const v = Math.min(100, Math.max(0, char['情分值']));
      html += `<div class="rp-data-box">
        <div class="box-title">情分值</div>
        <div style="text-align:right;">${v}</div>
        <div class="rp-bar-container"><div class="rp-bar-fill" style="width:${v}%;background:#ff8a80;"></div></div>
      </div>`;
    }
    html += `</div>`;
  }

  // 生理状态
  html += `<div class="rp-data-grid" style="margin-top:8px;">`;
  if (Object.keys(phys).length > 0) {
    const physStatus = phys['是否为生理期'] ? '<span class="rp-tag active" style="color:#ff6b6b;">🔴 生理期</span>' : '<span class="rp-tag">🟢 安全期</span>';
    html += `<div class="rp-data-box" style="background:#0d1b2a;">
      <div class="box-title">生理监测</div>
      <div class="rp-data-row"><span class="rp-data-label">状态</span><span>${physStatus}</span></div>
      <div class="rp-data-row"><span class="rp-data-label">安全期</span><span class="rp-data-value">${phys['安全期'] || 0}天</span></div>
      <div class="rp-data-row"><span class="rp-data-label">怀孕</span><span class="rp-data-value">${phys['怀孕状态'] || '未怀孕'}</span></div>
    </div>`;
  }
  if (Object.keys(flower).length > 0) {
    html += `<div class="rp-data-box" style="background:#0d1b2a;">
      <div class="box-title">花开蒂落</div>
      <div class="rp-data-row"><span class="rp-data-label">状态</span><span>${flower['触发状态'] ? '✅ 已触发' : '⬜ 未触发'}</span></div>
      <div class="rp-data-row"><span class="rp-data-label">对象</span><span class="rp-data-value">${flower['触发对象'] || '-'}</span></div>
      <div class="rp-data-row"><span class="rp-data-label">形式</span><span class="rp-data-value">${flower['触发形式'] || '-'}</span></div>
    </div>`;
  }
  html += `</div>`;

  // 着装
  const outfit = status['当前着装'];
  if (outfit) {
    const outfitText = typeof outfit === 'object' ? (outfit['现实'] || outfit['游戏'] || JSON.stringify(outfit)) : String(outfit);
    html += `<div class="rp-data-box" style="margin-top:8px;">
      <div class="box-title">着装</div>
      <div class="rp-long-text">${outfitText}</div>
    </div>`;
  }

  // 贞洁
  const virgin = char['贞洁状态'];
  const sexCount = char['性交次数'];
  if (virgin || sexCount) {
    html += `<div class="rp-data-box" style="margin-top:8px;">
      <div class="box-title">私密档案</div>
      <div class="rp-data-row">
        <span class="rp-data-label">贞洁</span>
        <span class="rp-data-value">${typeof virgin === 'object' ? `${virgin['现实'] || ''}/${virgin['游戏'] || ''}` : (virgin || '-')}</span>
      </div>
      <div class="rp-data-row">
        <span class="rp-data-label">性交次数</span>
        <span class="rp-data-value">${typeof sexCount === 'object' ? sexCount['总次数'] || 0 : (sexCount || 0)}</span>
      </div>
    </div>`;
  }

  // 特殊事件
  const events = char['特殊事件'];
  if (events) {
    html += `<div class="rp-data-box" style="margin-top:8px;">
      <div class="box-title">特殊事件</div>`;
    for (const [k, v] of Object.entries(events)) {
      const active = (v === true || (typeof v === 'object' && (v['触发状态'] === true || v['状态'] === true)));
      html += `<span class="rp-tag ${active ? 'active' : ''}">${active ? '☑' : '☐'} ${k}</span>`;
    }
    html += `</div>`;
  }

  return html;
}

// ============================================================
// UI 更新
// ============================================================

let isStreaming = false;

function updateUI() {
  if (isStreaming) {
    sendBtn.classList.add('hidden');
    abortBtn.classList.remove('hidden');
    statusText.textContent = 'Generating...';
    statusIndicator.style.background = '#ff9800';
  } else {
    sendBtn.classList.remove('hidden');
    abortBtn.classList.add('hidden');
    statusText.textContent = isConnected ? 'Ready' : 'Disconnected';
    statusIndicator.style.background = isConnected ? '#4caf50' : '#f44336';
  }
}

// ============================================================
// 事件绑定
// ============================================================

// RP 模式开关
// RP 模式开关——默认开启
rpModeBtn.classList.add('active');
messageRenderer.setRPMode(true);
rpStatusBtn.classList.add('visible');
rpModeBtn.querySelector('span:last-child').textContent = 'RP ON';

rpModeBtn.addEventListener('click', () => {
  rpMode = !rpMode;
  rpModeBtn.classList.toggle('active');
  messageRenderer.setRPMode(rpMode);
  if (rpMode) {
    rpStatusBtn.classList.add('visible');
    rpModeBtn.querySelector('span:last-child').textContent = 'RP ON';
  } else {
    rpStatusBtn.classList.remove('visible');
    rpModeBtn.querySelector('span:last-child').textContent = 'RP';
  }
});

// 状态面板按钮
rpStatusBtn.addEventListener('click', () => {
  rpStatusOverlay.classList.add('open');
  sendCommand('get_rp_state');
});

// 关闭状态面板
rpStatusClose.addEventListener('click', () => {
  rpStatusOverlay.classList.remove('open');
});
rpStatusOverlay.addEventListener('click', (e) => {
  if (e.target === rpStatusOverlay) {
    rpStatusOverlay.classList.remove('open');
  }
});

// 新会话按钮
sessionPickerNew.addEventListener('click', () => {
  hideSessionPicker();
  sendCommand('new_session');
});

// 选项按钮点击处理（委托事件）
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.rp-choice-btn');
  if (!btn) return;
  const text = btn.textContent.trim();
  if (!text) return;
  // 填入输入框，让用户编辑后再手动发送
  messageInput.value = text;
  messageInput.focus();
  // 触发 input 事件以调整 textarea 高度
  messageInput.dispatchEvent(new Event('input'));
});

// 发送消息
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  messageInput.value = '';
  sendCommand('prompt', { message: text });
});

// 中止
abortBtn.addEventListener('click', () => {
  sendCommand('abort');
});

// Enter 发送
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event('submit'));
  }
});

// ============================================================
// 启动
// ============================================================

connect();
