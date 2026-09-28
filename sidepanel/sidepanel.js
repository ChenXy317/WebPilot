/**
 * 侧边栏用户交互与通信控制器
 * 维护后台长连接会话、明暗主题切换、置底输入框自适应以及结构化流式消息渲染
 */

const PROVIDER_PRESETS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o'
  },
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct'
  },
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:latest'
  },
  custom: {
    baseUrl: '',
    model: ''
  }
};

document.addEventListener('DOMContentLoaded', async () => {
  // DOM 元素引用
  const streamContainer = document.getElementById('conversation-stream');
  const emptyState = document.getElementById('empty-state');
  const statusBadge = document.getElementById('status-badge');
  const statusText = statusBadge.querySelector('.indicator-text');
  const stepBadge = document.getElementById('step-badge');

  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const clearHistoryBtn = document.getElementById('clear-history-btn');
  const settingsToggleBtn = document.getElementById('settings-toggle-btn');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const settingsPanel = document.getElementById('settings-panel');

  const providerSelect = document.getElementById('provider-select');
  const baseUrlInput = document.getElementById('base-url-input');
  const apiKeyInput = document.getElementById('api-key-input');
  const toggleKeyBtn = document.getElementById('toggle-key-btn');
  const modelInput = document.getElementById('model-input');
  const maxStepsInput = document.getElementById('max-steps-input');
  const visionToggle = document.getElementById('vision-toggle');
  const cdpToggle = document.getElementById('cdp-toggle');
  const saveSettingsBtn = document.getElementById('save-settings-btn');

  const taskInput = document.getElementById('task-input');
  const sendBtn = document.getElementById('send-btn');
  const pauseResumeBtn = document.getElementById('pause-resume-btn');
  const pauseIcon = document.getElementById('pause-icon');
  const resumeIcon = document.getElementById('resume-icon');
  const pauseBtnText = document.getElementById('pause-btn-text');
  const stopBtn = document.getElementById('stop-btn');

  // 当前活跃的模型消息流节点与工具节点缓存
  let currentModelNode = null;
  let currentThoughtBox = null;
  let currentDirectTextBox = null;
  const activeToolCards = new Map();

  let currentStatus = 'idle';

  // 1. 主题初始化与切换
  const storedTheme = await chrome.storage.local.get(['theme']);
  let activeTheme = storedTheme.theme;
  if (!activeTheme) {
    activeTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', activeTheme);

  themeToggleBtn.addEventListener('click', async () => {
    activeTheme = activeTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', activeTheme);
    await chrome.storage.local.set({ theme: activeTheme });
  });

  // 2. 读取已保存设置
  const stored = await chrome.storage.local.get(['apiConfig', 'maxSteps', 'enableVision', 'enableCdp']);
  const savedConfig = stored.apiConfig || {
    provider: 'deepseek',
    baseUrl: PROVIDER_PRESETS.deepseek.baseUrl,
    apiKey: '',
    model: PROVIDER_PRESETS.deepseek.model
  };
  const savedMaxSteps = stored.maxSteps || 20;
  const savedVision = stored.enableVision || false;
  const savedCdp = stored.enableCdp || false;

  providerSelect.value = savedConfig.provider || 'deepseek';
  baseUrlInput.value = savedConfig.baseUrl || '';
  apiKeyInput.value = savedConfig.apiKey || '';
  modelInput.value = savedConfig.model || '';
  maxStepsInput.value = savedMaxSteps;
  visionToggle.checked = savedVision;
  cdpToggle.checked = savedCdp;

  // 抽屉展开/折叠
  settingsToggleBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('collapsed');
  });

  settingsCloseBtn.addEventListener('click', () => {
    settingsPanel.classList.add('collapsed');
  });

  providerSelect.addEventListener('change', (e) => {
    const preset = PROVIDER_PRESETS[e.target.value];
    if (preset) {
      if (preset.baseUrl) baseUrlInput.value = preset.baseUrl;
      if (preset.model) modelInput.value = preset.model;
    }
  });

  toggleKeyBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleKeyBtn.textContent = '隐藏';
    } else {
      apiKeyInput.type = 'password';
      toggleKeyBtn.textContent = '查看';
    }
  });

  saveSettingsBtn.addEventListener('click', async () => {
    const config = {
      provider: providerSelect.value,
      baseUrl: baseUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value.trim()
    };
    const maxSteps = parseInt(maxStepsInput.value, 10) || 20;
    const enableVision = visionToggle.checked;
    const enableCdp = cdpToggle.checked;

    await chrome.storage.local.set({
      apiConfig: config,
      maxSteps,
      enableVision,
      enableCdp
    });

    settingsPanel.classList.add('collapsed');
  });

  // 3. 消息流渲染辅助函数
  function removeEmptyState() {
    if (emptyState && emptyState.parentNode) {
      emptyState.remove();
    }
  }

  function scrollToBottom() {
    streamContainer.scrollTop = streamContainer.scrollHeight;
  }

  /**
   * 渲染用户消息：明确框起来展示
   */
  function appendUserMessage(text) {
    removeEmptyState();
    const container = document.createElement('div');
    container.className = 'user-query-container stream-node';

    const card = document.createElement('div');
    card.className = 'user-query-card';
    card.textContent = text;

    container.appendChild(card);
    streamContainer.appendChild(container);
    scrollToBottom();
  }

  /**
   * 确保存在当前活动模型响应容器（模型回复直接自然排版，不加大外框）
   */
  function ensureModelResponseNode() {
    removeEmptyState();
    if (!currentModelNode) {
      currentModelNode = document.createElement('div');
      currentModelNode.className = 'assistant-response stream-node';
      streamContainer.appendChild(currentModelNode);
      currentThoughtBox = null;
      currentDirectTextBox = null;
    }
    return currentModelNode;
  }

  /**
   * 追加流式模型思考内容
   */
  function appendThoughtChunk(text) {
    const parent = ensureModelResponseNode();
    if (!currentThoughtBox) {
      currentThoughtBox = document.createElement('div');
      currentThoughtBox.className = 'model-thought-box';
      currentThoughtBox.textContent = '思考过程: ';
      parent.appendChild(currentThoughtBox);
    }
    currentThoughtBox.textContent += text;
    scrollToBottom();
  }

  /**
   * 追加流式模型正文消息（直接输出）
   */
  function appendContentChunk(text) {
    const parent = ensureModelResponseNode();
    if (!currentDirectTextBox) {
      currentDirectTextBox = document.createElement('div');
      currentDirectTextBox.className = 'model-text-direct';
      parent.appendChild(currentDirectTextBox);
    }
    currentDirectTextBox.textContent += text;
    scrollToBottom();
  }

  /**
   * 渲染工具信息卡片：明确框起来展示
   */
  function createToolCard({ id, name, args }) {
    removeEmptyState();
    // 开启工具卡片时重置当前模型文本流容器
    currentModelNode = null;
    currentThoughtBox = null;
    currentDirectTextBox = null;

    const card = document.createElement('div');
    card.className = 'tool-action-card stream-node';
    card.dataset.toolId = id;

    const header = document.createElement('div');
    header.className = 'tool-card-header';

    const nameGroup = document.createElement('div');
    nameGroup.className = 'tool-name-group';
    nameGroup.textContent = name;

    const badge = document.createElement('span');
    badge.className = 'tool-indicator-badge running';
    badge.textContent = '执行中';

    header.appendChild(nameGroup);
    header.appendChild(badge);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'tool-card-body';

    const argsText = document.createElement('div');
    argsText.className = 'tool-args-preview';
    argsText.textContent = args ? JSON.stringify(args) : '';
    body.appendChild(argsText);

    card.appendChild(body);
    streamContainer.appendChild(card);
    activeToolCards.set(id, { card, badge, body });
    scrollToBottom();
  }

  /**
   * 更新工具卡片执行结果
   */
  function updateToolCard({ id, success, result }) {
    const entry = activeToolCards.get(id);
    if (!entry) return;

    const { badge, body } = entry;
    badge.className = `tool-indicator-badge ${success ? 'success' : 'error'}`;
    badge.textContent = success ? '已完成' : '失败';

    const resBox = document.createElement('div');
    resBox.className = `tool-result-box ${success ? 'success' : 'error'}`;
    resBox.textContent = result || (success ? '执行完毕' : '执行失败');
    body.appendChild(resBox);

    scrollToBottom();
  }

  // 4. 更新界面控制状态
  function updateUiStatus(status) {
    currentStatus = status;
    statusBadge.className = `status-indicator status-${status}`;

    if (status === 'running') {
      statusText.textContent = '执行中';
      sendBtn.disabled = true;
      pauseResumeBtn.disabled = false;
      stopBtn.disabled = false;
      pauseIcon.classList.remove('hidden');
      resumeIcon.classList.add('hidden');
      pauseBtnText.textContent = '暂停';
    } else if (status === 'paused') {
      statusText.textContent = '已挂起';
      sendBtn.disabled = true;
      pauseResumeBtn.disabled = false;
      stopBtn.disabled = false;
      pauseIcon.classList.add('hidden');
      resumeIcon.classList.remove('hidden');
      pauseBtnText.textContent = '继续';
    } else if (status === 'completed') {
      statusText.textContent = '已完成';
      sendBtn.disabled = false;
      pauseResumeBtn.disabled = true;
      stopBtn.disabled = true;
      stepBadge.classList.add('hidden');
    } else if (status === 'stopped' || status === 'idle') {
      statusText.textContent = '就绪';
      sendBtn.disabled = false;
      pauseResumeBtn.disabled = true;
      stopBtn.disabled = true;
      stepBadge.classList.add('hidden');
    } else if (status === 'error') {
      statusText.textContent = '异常';
      sendBtn.disabled = false;
      pauseResumeBtn.disabled = true;
      stopBtn.disabled = true;
    }
  }

  // 5. 与后台 Service Worker 建立端口通信
  let port = null;

  function connectToBackground() {
    port = chrome.runtime.connect({ name: 'webauto-sidepanel' });

    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'INIT_STATE':
          updateUiStatus(msg.status);
          if (msg.events && msg.events.length > 0) {
            removeEmptyState();
            // 重建历史日志
            for (const ev of msg.events) {
              handleEngineEvent(ev);
            }
          }
          break;

        case 'statusChange':
          updateUiStatus(msg.status);
          break;

        case 'stepStart':
          stepBadge.classList.remove('hidden');
          stepBadge.textContent = `第 ${msg.step} / ${msg.maxSteps} 步`;
          break;

        case 'modelThinkingStart':
          ensureModelResponseNode();
          break;

        case 'thoughtChunk':
          appendThoughtChunk(msg.text);
          break;

        case 'contentChunk':
          appendContentChunk(msg.text);
          break;

        case 'modelThinkingEnd':
          break;

        case 'toolCallStart':
          createToolCard(msg);
          break;

        case 'toolCallEnd':
          updateToolCard(msg);
          break;

        case 'complete':
          appendContentChunk(`\n任务总结：${msg.summary}`);
          updateUiStatus('completed');
          break;

        case 'error':
          const errDiv = document.createElement('div');
          errDiv.className = 'tool-result-box error stream-node';
          errDiv.textContent = `执行异常: ${msg.message}`;
          streamContainer.appendChild(errDiv);
          updateUiStatus('error');
          scrollToBottom();
          break;

        case 'HISTORY_CLEARED':
          streamContainer.innerHTML = `
            <div id="empty-state" class="empty-state">
              <div class="empty-icon-wrapper">
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                  <line x1="8" y1="21" x2="16" y2="21"></line>
                  <line x1="12" y1="17" x2="12" y2="21"></line>
                </svg>
              </div>
              <p class="empty-title">网页自动化就绪</p>
              <p class="empty-subtitle">在下方输入指令，助手将自主感知网页并执行点击、输入与导航</p>
            </div>
          `;
          updateUiStatus('idle');
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      // 端口断开后尝试重连
      setTimeout(connectToBackground, 1000);
    });
  }

  function handleEngineEvent(ev) {
    if (ev.type === 'toolCallStart') {
      createToolCard(ev);
    } else if (ev.type === 'toolCallEnd') {
      updateToolCard(ev);
    } else if (ev.type === 'thoughtChunk') {
      appendThoughtChunk(ev.text);
    } else if (ev.type === 'contentChunk') {
      appendContentChunk(ev.text);
    } else if (ev.type === 'complete') {
      appendContentChunk(`\n任务总结：${ev.summary}`);
    }
  }

  connectToBackground();

  // 6. 输入框自适应扩展与快捷键
  function autoResizeTextarea() {
    taskInput.style.height = 'auto';
    taskInput.style.height = `${Math.min(taskInput.scrollHeight, 140)}px`;
  }

  taskInput.addEventListener('input', autoResizeTextarea);

  taskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      triggerSendTask();
    }
  });

  // 7. 发送任务
  async function triggerSendTask() {
    const goal = taskInput.value.trim();
    if (!goal) return;

    appendUserMessage(goal);
    taskInput.value = '';
    taskInput.style.height = 'auto';

    const currentConfig = {
      apiConfig: {
        baseUrl: baseUrlInput.value.trim(),
        apiKey: apiKeyInput.value.trim(),
        model: modelInput.value.trim()
      },
      maxSteps: parseInt(maxStepsInput.value, 10) || 20,
      enableVision: visionToggle.checked,
      enableCdp: cdpToggle.checked
    };

    updateUiStatus('running');

    if (port) {
      port.postMessage({
        action: 'START_TASK',
        goal: goal,
        config: currentConfig
      });
    }
  }

  sendBtn.addEventListener('click', triggerSendTask);

  // 8. 暂停/恢复与停止控制
  pauseResumeBtn.addEventListener('click', () => {
    if (!port) return;
    if (currentStatus === 'running') {
      port.postMessage({ action: 'PAUSE_TASK' });
    } else if (currentStatus === 'paused') {
      port.postMessage({ action: 'RESUME_TASK' });
    }
  });

  stopBtn.addEventListener('click', () => {
    if (port) {
      port.postMessage({ action: 'STOP_TASK' });
    }
  });

  // 9. 清空历史
  clearHistoryBtn.addEventListener('click', () => {
    if (port) {
      port.postMessage({ action: 'CLEAR_HISTORY' });
    }
  });
});
