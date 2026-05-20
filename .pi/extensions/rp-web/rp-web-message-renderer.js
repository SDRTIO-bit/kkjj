/**
 * RP Message Renderer - 基于 tau-mirror 的 MessageRenderer，增加 RP 副视角折叠功能
 */

import { renderMarkdown } from './rp-web-markdown.js';

export class MessageRenderer {
  constructor(container) {
    this.container = container;
    this.isNearBottom = true;
    this.rpMode = false;

    this.container.addEventListener('scroll', () => {
      const threshold = 100;
      this.isNearBottom =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < threshold;
    });
  }

  setRPMode(enabled) {
    this.rpMode = enabled;
  }

  clear() {
    this.container.innerHTML = '';
  }

  renderWelcome() {
    this.container.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon"><img src="icons/tau-192.png" alt="τ" class="tau-icon-welcome"></div>
        <p>RP Web · 乐园回响</p>
        <p class="hint">开启 RP 模式后，副视角和状态面板自动可用</p>
      </div>
    `;
  }

  renderUserMessage(message, isHistory = false) {
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message user${isHistory ? ' history' : ''}`;
    div.innerHTML = `<div class="message-content">${this.escapeHtml(message.content)}</div>`;
    this.container.appendChild(div);
    if (!isHistory) this.scrollToBottom();
  }

  renderAssistantMessage(message, isStreaming = false, isHistory = false) {
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message assistant${isHistory ? ' history' : ''}`;
    div.dataset.messageId = message.id || 'streaming';

    let contentHtml = '';
    if (typeof message.content === 'string') {
      const processed = isStreaming ? this.escapeHtml(message.content) : this._processRPContent(message.content);
      contentHtml = processed;
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text') {
          const processed = isStreaming ? this.escapeHtml(block.text) : this._processRPContent(block.text);
          contentHtml += processed;
        } else if (block.type === 'thinking') {
          contentHtml += this.renderThinkingBlock(block.thinking);
        }
      }
    }

    const streamingClass = isStreaming ? ' streaming' : '';
    div.innerHTML = `<div class="message-content${streamingClass}">${contentHtml}</div>`;

    this.container.appendChild(div);
    if (!isHistory) this.scrollToBottom();
    return div;
  }

  /**
   * RP 内容处理核心函数
   * - 如果 RP 模式开启，将 <perspective> 标签转为可折叠 HTML 卡片
   * - 移除 <thinking> 和 <UpdateVariable> 标签
   */
  _processRPContent(text) {
    if (!this.rpMode) {
      // 非 RP 模式：正常 markdown 渲染
      return renderMarkdown(this._stripXMLTags(text));
    }

    // RP 模式：处理副视角
    return this._renderWithPerspectives(text);
  }

  /**
   * 去掉 thinking 和 UpdateVariable 标签（非 RP 模式用）
   */
  _stripXMLTags(text) {
    return text
      .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
      .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/g, '')
      .replace(/<Analysis>[\s\S]*?<\/Analysis>/g, '')
      .replace(/<perspective>[\s\S]*?<\/perspective>/g, '')
      .replace(/<choice>[\s\S]*?<\/choice>/g, '')
      .replace(/<content>([\s\S]*?)<\/content>/g, '$1')
      .trim();
  }

  /**
   * 渲染含副视角和选项的 RP 内容
   */
  _renderWithPerspectives(text) {
    // 先移除 thinking 和 UpdateVariable
    let cleaned = text
      .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
      .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/g, '')
      .replace(/<Analysis>[\s\S]*?<\/Analysis>/g, '')
      .trim();

    // 提取内容区
    const contentMatch = cleaned.match(/<content>([\s\S]*?)<\/content>/);
    const mainContent = contentMatch ? contentMatch[1].trim() : cleaned;

    // 提取副视角
    const perspectiveRegex = /<perspective>[\s\S]*?<toggle_title>([\s\S]*?)<\/toggle_title>[\s\S]*?<content_html>([\s\S]*?)<\/content_html>[\s\S]*?<\/perspective>/g;
    let perspectives = [];
    let match;
    while ((match = perspectiveRegex.exec(cleaned)) !== null) {
      perspectives.push({
        title: match[1].trim(),
        html: match[2].trim()
      });
    }

    // 提取选项 <choice>...</choice>
    const choiceRegex = /<choice>([\s\S]*?)<\/choice>/g;
    const choices = [];
    while ((match = choiceRegex.exec(mainContent)) !== null) {
      const t = match[1].trim();
      if (t) choices.push(t);
    }

    // 从正文移除 <choice> 标签
    let cleanMain = mainContent.replace(/<choice>[\s\S]*?<\/choice>/g, '').trim();

    // 渲染正文
    let result = renderMarkdown(cleanMain);

    // 渲染副视角折叠卡片
    for (const p of perspectives) {
      const id = 'rp-persp-' + Math.random().toString(36).slice(2, 8);
      result += `
<div class="rp-perspective">
  <button class="rp-perspective-toggle" onclick="
    var c=document.getElementById('${id}');
    c.classList.toggle('open');
    this.textContent = c.classList.contains('open') ? '▲ 收起 ${this.escapeHtml(p.title)}' : '${this.escapeHtml(p.title)}';
  ">${p.title}</button>
  <div class="rp-perspective-content" id="${id}">
    <div class="rp-perspective-inner">${p.html}</div>
  </div>
</div>`;
    }

    // 渲染选项按钮（使用全局回调，避免 onclick 中的 this 问题）
    if (choices.length > 0) {
      const uid = 'rp-choices-' + Math.random().toString(36).slice(2, 8);
      // 存储选项文本供点击回调使用
      window._rpChoices = window._rpChoices || {};
      window._rpChoices[uid] = choices;
      result += '<div class="rp-choices">';
      for (let i = 0; i < choices.length; i++) {
        const escaped = this.escapeHtml(choices[i]);
        result += '<button class="rp-choice-btn" data-choices-id="' + uid + '" data-choice-index="' + i + '">' + escaped + '</button>';
      }
      result += '</div>';
    }

    return result;
  }

  renderThinkingBlock(thinking) {
    const id = 'thinking-' + Math.random().toString(36).slice(2, 8);
    return `<div class="thinking-block">
<div class="thinking-toggle" onclick="var c=document.getElementById('${id}');c.classList.toggle('expanded');this.classList.toggle('expanded')">
<span class="chevron">▶</span>
<span class="thinking-label">💭 Thinking</span>
</div>
<div class="thinking-content" id="${id}">${this.escapeHtml(thinking)}</div>
</div>`;
  }

  updateStreamingThinking(messageElement, thinking) {
    let thinkingDiv = messageElement.querySelector('.streaming-thinking');
    if (!thinkingDiv) {
      const contentDiv = messageElement.querySelector('.message-content');
      if (!contentDiv) return;
      thinkingDiv = document.createElement('div');
      thinkingDiv.className = 'thinking-block streaming-thinking';
      thinkingDiv.innerHTML = `<div class="thinking-toggle expanded">
          <span class="chevron">▶</span>
          <span class="thinking-label">💭 Thinking</span>
        </div>
        <div class="thinking-content expanded"></div>`;
      contentDiv.prepend(thinkingDiv);
    }
    const contentEl = thinkingDiv.querySelector('.thinking-content');
    if (contentEl) {
      contentEl.textContent = thinking;
      this.scrollToBottom();
    }
  }

  updateStreamingMessage(messageElement, content) {
    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      let textNode = contentDiv.querySelector('.streaming-text');
      if (!textNode) {
        textNode = document.createElement('div');
        textNode.className = 'streaming-text';
        contentDiv.appendChild(textNode);
      }
      textNode.innerHTML = this.escapeHtml(content);
      this.scrollToBottom();
    }
  }

  finalizeStreamingMessage(messageElement, usage = null, thinking = '') {
    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      contentDiv.classList.remove('streaming');
      const streamingText = contentDiv.querySelector('.streaming-text');
      const rawText = streamingText ? streamingText.textContent : contentDiv.textContent;
      let html = '';
      if (thinking) {
        html += this.renderThinkingBlock(thinking);
      }
      html += this._processRPContent(rawText);
      contentDiv.innerHTML = html;
    }
  }

  renderSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.textContent = text;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  renderError(errorMessage) {
    const div = document.createElement('div');
    div.className = 'error-message';
    div.textContent = '⚠️ ' + errorMessage;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom() {
    if (this.isNearBottom) {
      requestAnimationFrame(() => {
        this.container.scrollTop = this.container.scrollHeight;
      });
    }
  }
}
