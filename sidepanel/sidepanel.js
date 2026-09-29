/**
 * 侧边栏用户交互与通信控制器
 * 维护后台长连接会话、供应商与多模型配置管理、明暗主题切换及结构化流式消息渲染
 */

document.addEventListener('DOMContentLoaded', async () => {
  // DOM 元素引用
  const streamContainer = document.getElementById('conversation-stream');
  const statusBadge = document.getElementById('status-badge');
  const statusText = statusBadge.querySelector('.indicator-text');
  const stepBadge = document.getElementById('step-badge');
  const activeModelTag = document.getElementById('active-model-tag');

  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const clearHistoryBtn = document.getElementById('clear-history-btn');
  const settingsToggleBtn = document.getElementById('settings-toggle-btn');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const settingsPanel = document.getElementById('settings-panel');

  const providerSelect = document.getElementById('provider-select');
  const addProviderBtn = document.getElementById('add-provider-btn');
  const deleteProviderBtn = document.getElementById('delete-provider-btn');
  const providerNameInput = document.getElementById('provider-name-input');
  const baseUrlInput = document.getElementById('base-url-input');
  const apiKeyInput = document.getElementById('api-key-input');
  const toggleKeyBtn = document.getElementById('toggle-key-btn');
  const modelSelect = document.getElementById('model-select');
  const newModelInput = document.getElementById('new-model-input');
  const addModelBtn = document.getElementById('add-model-btn');
  const modelsTagsContainer = document.getElementById('models-tags-container');
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

  // 当前活跃的模型消息流节点、思考折叠卡片与工具节点缓存
  let currentModelNode = null;
  let currentThoughtCard = null;
  let currentThoughtInner = null;
  let currentThoughtStatus = null;
  let currentThoughtHint = null;
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

  // 2. 供应商与多模型配置存储管理
  const stored = await chrome.storage.local.get([
    'customProviders',
    'activeProviderId',
    'apiConfig',
    'maxSteps',
    'enableVision',
    'enableCdp'
  ]);

  let providers = Array.isArray(stored.customProviders) ? stored.customProviders : [];
  let activeProviderId = stored.activeProviderId || null;

  // 严格遵循用户原则：未配置时绝不预设 DeepSeek，保持为空让用户自行填写配置
  if (providers.length === 0) {
    activeProviderId = null;
  } else if (!activeProviderId || !providers.some((p) => p.id === activeProviderId)) {
    activeProviderId = providers[0].id;
  }

  maxStepsInput.value = stored.maxSteps || 20;
  visionToggle.checked = stored.enableVision || false;
  cdpToggle.checked = stored.enableCdp || false;

  /**
   * 获取当前选中的供应商配置对象
   */
  function getCurrentProvider() {
    if (!providers || providers.length === 0) return null;
    return providers.find((p) => p.id === activeProviderId) || providers[0] || null;
  }

  /**
   * 渲染供应商下拉选择项
   */
  function renderProviderOptions() {
    providerSelect.innerHTML = '';
    if (!providers || providers.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '暂无供应商（请点击“+ 新建”）';
      opt.disabled = true;
      opt.selected = true;
      providerSelect.appendChild(opt);
      deleteProviderBtn.disabled = true;
      return;
    }

    deleteProviderBtn.disabled = false;
    for (const p of providers) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name ? p.name.trim() : '未命名供应商';
      if (p.id === activeProviderId) {
        opt.selected = true;
      }
      providerSelect.appendChild(opt);
    }
  }

  /**
   * 渲染指定供应商下的模型选择与管理标签
   */
  function renderModelControls(currentProvider) {
    modelSelect.innerHTML = '';
    modelsTagsContainer.innerHTML = '';

    if (!currentProvider) {
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '暂无模型';
      emptyOpt.disabled = true;
      emptyOpt.selected = true;
      modelSelect.appendChild(emptyOpt);

      const hint = document.createElement('div');
      hint.className = 'models-empty-hint';
      hint.textContent = '请先新建供应商并添加可用模型';
      modelsTagsContainer.appendChild(hint);
      return;
    }

    const models = Array.isArray(currentProvider.models) ? currentProvider.models : [];

    if (models.length === 0) {
      currentProvider.selectedModel = '';
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '暂无模型（请在下方添加）';
      emptyOpt.disabled = true;
      emptyOpt.selected = true;
      modelSelect.appendChild(emptyOpt);

      const hint = document.createElement('div');
      hint.className = 'models-empty-hint';
      hint.textContent = '暂无模型，请在上方输入模型名称并点击“+ 添加”';
      modelsTagsContainer.appendChild(hint);
      return;
    }

    if (!currentProvider.selectedModel || !models.includes(currentProvider.selectedModel)) {
      currentProvider.selectedModel = models[0];
    }

    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === currentProvider.selectedModel) {
        opt.selected = true;
      }
      modelSelect.appendChild(opt);
    }

    // 渲染管理标签列表
    for (const m of models) {
      const tag = document.createElement('div');
      tag.className = `model-tag${m === currentProvider.selectedModel ? ' active' : ''}`;

      const nameSpan = document.createElement('span');
      nameSpan.textContent = m;
      nameSpan.title = '点击设为当前生效模型';
      nameSpan.addEventListener('click', () => {
        currentProvider.selectedModel = m;
        renderModelControls(currentProvider);
        updateHeaderModelBadge();
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'model-tag-del-btn';
      delBtn.textContent = '×';
      delBtn.title = '移除此模型';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        currentProvider.models = currentProvider.models.filter((item) => item !== m);
        if (currentProvider.selectedModel === m) {
          currentProvider.selectedModel = currentProvider.models.length > 0 ? currentProvider.models[0] : '';
        }
        renderModelControls(currentProvider);
        updateHeaderModelBadge();
      });

      tag.appendChild(nameSpan);
      tag.appendChild(delBtn);
      modelsTagsContainer.appendChild(tag);
    }
  }

  /**
   * 同步更新顶栏模型指示标签
   */
  function updateHeaderModelBadge() {
    const cp = getCurrentProvider();
    if (!cp || !cp.name || !cp.selectedModel) {
      activeModelTag.classList.remove('hidden');
      activeModelTag.textContent = '未配置模型';
      activeModelTag.title = '尚未配置生效模型，点击展开设置';
      return;
    }
    activeModelTag.classList.remove('hidden');
    activeModelTag.textContent = `${cp.name.trim()} / ${cp.selectedModel.trim()}`;
    activeModelTag.title = `当前生效：${cp.name.trim()} / ${cp.selectedModel.trim()}`;
  }

  /**
   * 填充当前供应商的输入框与关联模型
   */
  function populateCurrentProviderFields() {
    const cp = getCurrentProvider();
    if (!cp) {
      providerNameInput.value = '';
      baseUrlInput.value = '';
      apiKeyInput.value = '';
      renderModelControls(null);
      updateHeaderModelBadge();
      return;
    }

    providerNameInput.value = cp.name || '';
    baseUrlInput.value = cp.baseUrl || '';
    apiKeyInput.value = cp.apiKey || '';

    renderModelControls(cp);
    updateHeaderModelBadge();
  }

  // 初始化设置表单展示
  renderProviderOptions();
  populateCurrentProviderFields();

  // 监听切换供应商
  providerSelect.addEventListener('change', (e) => {
    const prev = getCurrentProvider();
    if (prev) {
      prev.name = providerNameInput.value.trim() || '未命名供应商';
      prev.baseUrl = baseUrlInput.value.trim();
      prev.apiKey = apiKeyInput.value.trim();
    }

    activeProviderId = e.target.value;
    populateCurrentProviderFields();
  });

  // 监听供应商名称实时更新
  providerNameInput.addEventListener('input', (e) => {
    const cp = getCurrentProvider();
    if (cp) {
      cp.name = e.target.value;
      const opt = providerSelect.querySelector(`option[value="${cp.id}"]`);
      if (opt) opt.textContent = cp.name || '未命名供应商';
      updateHeaderModelBadge();
    }
  });

  baseUrlInput.addEventListener('input', (e) => {
    const cp = getCurrentProvider();
    if (cp) cp.baseUrl = e.target.value;
  });

  apiKeyInput.addEventListener('input', (e) => {
    const cp = getCurrentProvider();
    if (cp) cp.apiKey = e.target.value;
  });

  // 新建供应商：不预填任何默认配置，完全保持空白让用户自行填写
  addProviderBtn.addEventListener('click', () => {
    const cur = getCurrentProvider();
    if (cur) {
      cur.name = providerNameInput.value.trim();
      cur.baseUrl = baseUrlInput.value.trim();
      cur.apiKey = apiKeyInput.value.trim();
    }

    const newId = `p_${Date.now()}`;
    const newProvider = {
      id: newId,
      name: '',
      baseUrl: '',
      apiKey: '',
      models: [],
      selectedModel: ''
    };

    providers.push(newProvider);
    activeProviderId = newId;

    renderProviderOptions();
    populateCurrentProviderFields();
    providerNameInput.focus();
  });

  // 删除当前供应商
  deleteProviderBtn.addEventListener('click', () => {
    if (!providers || providers.length === 0) {
      return;
    }

    providers = providers.filter((p) => p.id !== activeProviderId);
    activeProviderId = providers.length > 0 ? providers[0].id : null;

    renderProviderOptions();
    populateCurrentProviderFields();
  });

  // 生效模型下拉框变更
  modelSelect.addEventListener('change', (e) => {
    const cp = getCurrentProvider();
    if (cp) {
      cp.selectedModel = e.target.value;
      renderModelControls(cp);
      updateHeaderModelBadge();
    }
  });

  // 添加模型逻辑
  function handleAddNewModel() {
    const modelName = newModelInput.value.trim();
    if (!modelName) return;

    const cp = getCurrentProvider();
    if (!cp) return;

    if (!Array.isArray(cp.models)) {
      cp.models = [];
    }

    if (!cp.models.includes(modelName)) {
      cp.models.push(modelName);
    }
    cp.selectedModel = modelName;

    newModelInput.value = '';
    renderModelControls(cp);
    updateHeaderModelBadge();
  }

  addModelBtn.addEventListener('click', handleAddNewModel);
  newModelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddNewModel();
    }
  });

  // API Key 密码明暗查看
  toggleKeyBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleKeyBtn.textContent = '隐藏';
    } else {
      apiKeyInput.type = 'password';
      toggleKeyBtn.textContent = '查看';
    }
  });

  // 设置面板展开与折叠控制
  settingsToggleBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('collapsed');
  });

  settingsCloseBtn.addEventListener('click', () => {
    settingsPanel.classList.add('collapsed');
  });

  // 保存设置按钮
  saveSettingsBtn.addEventListener('click', async () => {
    const cp = getCurrentProvider();
    if (cp) {
      cp.name = providerNameInput.value.trim() || '未命名供应商';
      cp.baseUrl = baseUrlInput.value.trim();
      cp.apiKey = apiKeyInput.value.trim();
    }

    const maxSteps = parseInt(maxStepsInput.value, 10) || 20;
    const enableVision = visionToggle.checked;
    const enableCdp = cdpToggle.checked;

    await chrome.storage.local.set({
      customProviders: providers,
      activeProviderId: activeProviderId,
      apiConfig: {
        baseUrl: (cp?.baseUrl || '').trim(),
        apiKey: (cp?.apiKey || '').trim(),
        model: (cp?.selectedModel || cp?.models?.[0] || '').trim()
      },
      maxSteps,
      enableVision,
      enableCdp
    });

    renderProviderOptions();
    populateCurrentProviderFields();
    settingsPanel.classList.add('collapsed');
  });

  // 3. 消息流渲染与排版函数
  function scrollToBottom() {
    streamContainer.scrollTop = streamContainer.scrollHeight;
  }

  /**
   * 渲染用户消息
   */
  function appendUserMessage(text) {
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
   * 确保存在当前活动模型响应容器
   */
  function ensureModelResponseNode() {
    if (!currentModelNode) {
      currentModelNode = document.createElement('div');
      currentModelNode.className = 'assistant-response stream-node';
      streamContainer.appendChild(currentModelNode);
      currentThoughtCard = null;
      currentThoughtInner = null;
      currentThoughtStatus = null;
      currentThoughtHint = null;
      currentDirectTextBox = null;
    }
    return currentModelNode;
  }

  /**
   * 更新思考状态标签为已完成
   */
  function finishThinkingState() {
    if (currentThoughtStatus && currentThoughtStatus.classList.contains('thinking')) {
      currentThoughtStatus.classList.remove('thinking');
      currentThoughtStatus.textContent = '已完成思考';
    }
  }

  /**
   * 追加流式模型思考内容至可折叠卡片
   */
  function appendThoughtChunk(text) {
    const parent = ensureModelResponseNode();
    if (!currentThoughtCard) {
      const card = document.createElement('div');
      card.className = 'model-thought-card';

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'thought-card-header';
      header.setAttribute('aria-label', '展开或收起思考过程');

      header.innerHTML = `
        <div class="thought-header-left">
          <svg class="thought-icon" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z"></path>
            <path d="M9 21h6"></path>
          </svg>
          <span class="thought-title">深度思考</span>
          <span class="thought-status-badge thinking">思考中...</span>
        </div>
        <div class="thought-header-right">
          <span class="thought-toggle-hint">收起</span>
          <svg class="thought-chevron" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
      `;

      const body = document.createElement('div');
      body.className = 'thought-card-body';

      const inner = document.createElement('div');
      inner.className = 'thought-content-inner';
      body.appendChild(inner);

      card.appendChild(header);
      card.appendChild(body);

      // 点击头部栏切换展开/收起状态
      header.addEventListener('click', () => {
        const isCollapsed = card.classList.toggle('is-collapsed');
        const hint = header.querySelector('.thought-toggle-hint');
        if (hint) {
          hint.textContent = isCollapsed ? '展开' : '收起';
        }
      });

      parent.appendChild(card);

      currentThoughtCard = card;
      currentThoughtInner = inner;
      currentThoughtStatus = header.querySelector('.thought-status-badge');
      currentThoughtHint = header.querySelector('.thought-toggle-hint');
    }

    currentThoughtInner.textContent += text;
    scrollToBottom();
  }

  /**
   * 追加流式模型正文消息并与思考过程隔开排版
   */
  function appendContentChunk(text) {
    finishThinkingState();
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
   * 渲染工具信息卡片
   */
  function createToolCard({ id, name, args }) {
    finishThinkingState();
    currentModelNode = null;
    currentThoughtCard = null;
    currentThoughtInner = null;
    currentThoughtStatus = null;
    currentThoughtHint = null;
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
   * 更新工具卡片执行状态与结果
   */
  function updateToolCard({ id, success, result }) {
    const entry = activeToolCards.get(id);
    if (!entry) return;

    const { badge, body } = entry;
    badge.className = `tool-indicator-badge ${success ? 'success' : 'error'}`;
    badge.textContent = success ? '已完成' : '失败';

    const resBox = document.createElement('div');
    resBox.className = `tool-result-box ${success ? 'success' : 'error'}`;
    resBox.textContent = result || (success ? '执行完成' : '执行失败');
    body.appendChild(resBox);

    scrollToBottom();
  }

  // 4. 状态同步更新
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
      statusText.textContent = '完成';
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

  // 5. 与后台 Service Worker 保持长连接
  let port = null;

  function connectToBackground() {
    port = chrome.runtime.connect({ name: 'webauto-sidepanel' });

    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'INIT_STATE':
          updateUiStatus(msg.status);
          if (msg.events && msg.events.length > 0) {
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
          finishThinkingState();
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
          currentModelNode = null;
          currentThoughtCard = null;
          currentThoughtInner = null;
          currentThoughtStatus = null;
          currentThoughtHint = null;
          currentDirectTextBox = null;
          activeToolCards.clear();
          streamContainer.innerHTML = '';
          updateUiStatus('idle');
          break;
      }
    });

    port.onDisconnect.addListener(() => {
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
    } else if (ev.type === 'modelThinkingEnd') {
      finishThinkingState();
    } else if (ev.type === 'complete') {
      appendContentChunk(`\n任务总结：${ev.summary}`);
    }
  }

  connectToBackground();

  // 6. 输入框自适应扩展与快捷键
  function autoResizeTextarea() {
    taskInput.style.height = 'auto';
    const nextH = Math.min(taskInput.scrollHeight, 140);
    taskInput.style.height = `${nextH}px`;
    taskInput.style.overflowY = taskInput.scrollHeight > 140 ? 'auto' : 'hidden';
  }

  taskInput.addEventListener('input', autoResizeTextarea);

  taskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      triggerSendTask();
    }
  });

  // 7. 发送任务指令并重置会话节点引用
  async function triggerSendTask() {
    const goal = taskInput.value.trim();
    if (!goal) return;

    currentModelNode = null;
    currentThoughtCard = null;
    currentThoughtInner = null;
    currentThoughtStatus = null;
    currentThoughtHint = null;
    currentDirectTextBox = null;
    activeToolCards.clear();

    appendUserMessage(goal);
    taskInput.value = '';
    taskInput.style.height = 'auto';
    taskInput.style.overflowY = 'hidden';

    const cp = getCurrentProvider();
    const effectiveBaseUrl = (cp?.baseUrl || '').trim();
    const effectiveModel = (cp?.selectedModel || cp?.models?.[0] || '').trim();

    if (!cp || !effectiveBaseUrl || !effectiveModel) {
      settingsPanel.classList.remove('collapsed');
      const tipDiv = document.createElement('div');
      tipDiv.className = 'tool-result-box error stream-node';
      tipDiv.textContent = '提示：尚未配置有效的 API Base URL 或生效模型，请先在上方设置抽屉中填写并保存配置。';
      streamContainer.appendChild(tipDiv);
      scrollToBottom();
      return;
    }

    const currentConfig = {
      apiConfig: {
        baseUrl: effectiveBaseUrl,
        apiKey: (cp.apiKey || '').trim(),
        model: effectiveModel
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

  // 点击顶栏模型标签快速唤起设置抽屉
  activeModelTag.addEventListener('click', () => {
    settingsPanel.classList.toggle('collapsed');
  });

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
    if (!port) return;
    port.postMessage({ action: 'STOP_TASK' });
  });

  // 9. 清空历史
  clearHistoryBtn.addEventListener('click', () => {
    if (port) {
      port.postMessage({ action: 'CLEAR_HISTORY' });
    }
  });
});
