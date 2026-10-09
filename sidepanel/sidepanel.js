/**
 * 侧边栏用户交互与通信控制器
 * 维护后台长连接会话、供应商与多模型配置管理、明暗主题切换及结构化流式消息渲染
 */

import { OpenAIClient } from '../lib/openai.js';

document.addEventListener('DOMContentLoaded', async () => {
  // DOM 元素引用
  const streamContainer = document.getElementById('conversation-stream');
  const statusBadge = document.getElementById('status-badge');
  const statusText = statusBadge.querySelector('.indicator-text');
  const stepBadge = document.getElementById('step-badge');
  const activeModelTag = document.getElementById('active-model-tag');

  const harness = document.querySelector('.harness-layout');
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const clearHistoryBtn = document.getElementById('clear-history-btn');
  const settingsToggleBtn = document.getElementById('settings-toggle-btn');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const settingsView = document.getElementById('settings-view');
  const saveState = document.getElementById('save-state');
  const settingsAlert = document.getElementById('settings-alert');

  const addProviderBtn = document.getElementById('add-provider-btn');
  const addProviderEmptyBtn = document.getElementById('add-provider-empty');
  const deleteProviderBtn = document.getElementById('delete-provider-btn');
  const providerEmpty = document.getElementById('provider-empty');
  const picker = document.getElementById('picker');
  const providerSelect = document.getElementById('provider-select');
  const providerFields = document.getElementById('provider-fields');
  const providerNameInput = document.getElementById('provider-name-input');
  const baseUrlInput = document.getElementById('base-url-input');
  const apiKeyInput = document.getElementById('api-key-input');
  const toggleKeyBtn = document.getElementById('toggle-key-btn');
  const modelScope = document.getElementById('model-scope');
  const modelSelect = document.getElementById('model-select');
  const testModelBtn = document.getElementById('test-model-btn');
  const modelTestResult = document.getElementById('model-test-result');
  const newModelInput = document.getElementById('new-model-input');
  const addModelBtn = document.getElementById('add-model-btn');
  const removeModelBtn = document.getElementById('remove-model-btn');
  const maxStepsInput = document.getElementById('max-steps-input');
  const visionToggle = document.getElementById('vision-toggle');
  const cdpToggle = document.getElementById('cdp-toggle');

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
  let providerSeq = 0;
  let configReady = false;
  let saveTimer = null;
  let savedHintTimer = null;
  let deleteArmed = false;
  let deleteArmTimer = null;
  let renderingPickers = false;
  let testingModel = false;
  let shownTestKey = '';

  if (providers.length === 0) {
    activeProviderId = null;
  } else if (!activeProviderId || !providers.some((p) => p.id === activeProviderId)) {
    activeProviderId = providers[0].id;
  }

  maxStepsInput.value = stored.maxSteps || 20;
  visionToggle.checked = Boolean(stored.enableVision);
  cdpToggle.checked = Boolean(stored.enableCdp);

  /**
   * 当前选中的供应商
   */
  function getCurrentProvider() {
    if (!providers.length) return null;
    return providers.find((p) => p.id === activeProviderId) || providers[0] || null;
  }

  function nextProviderId() {
    providerSeq += 1;
    return `p_${Date.now().toString(36)}_${providerSeq}`;
  }

  function clampSteps() {
    let steps = parseInt(maxStepsInput.value, 10);
    if (!Number.isFinite(steps)) steps = 20;
    steps = Math.min(50, Math.max(1, steps));
    maxStepsInput.value = String(steps);
    return steps;
  }

  /**
   * 把输入框内容写回当前供应商
   */
  function readFieldsInto(provider) {
    if (!provider) return;
    provider.name = providerNameInput.value.trim();
    provider.baseUrl = baseUrlInput.value.trim();
    provider.apiKey = apiKeyInput.value.trim();
  }

  /**
   * 用供应商数据填充输入框；无供应商时清空
   */
  function writeFields(provider) {
    providerNameInput.value = provider?.name || '';
    baseUrlInput.value = provider?.baseUrl || '';
    apiKeyInput.value = provider?.apiKey || '';
  }

  function resetDeleteArm() {
    deleteArmed = false;
    clearTimeout(deleteArmTimer);
    deleteProviderBtn.textContent = '删除此供应商';
  }

  function showSaved(text) {
    saveState.textContent = text;
    clearTimeout(savedHintTimer);
    if (text === '已保存') {
      savedHintTimer = setTimeout(() => {
        if (saveState.textContent === '已保存') saveState.textContent = '';
      }, 1200);
    }
  }

  /**
   * 将供应商、模型与运行选项写入本地存储
   */
  async function persistNow() {
    if (!configReady) return;
    clearTimeout(saveTimer);
    const provider = getCurrentProvider();
    if (provider) readFieldsInto(provider);
    try {
      await chrome.storage.local.set({
        customProviders: providers,
        activeProviderId,
        apiConfig: {
          baseUrl: (provider?.baseUrl || '').trim(),
          apiKey: (provider?.apiKey || '').trim(),
          model: (provider?.selectedModel || '').trim()
        },
        maxSteps: clampSteps(),
        enableVision: visionToggle.checked,
        enableCdp: cdpToggle.checked
      });
      showSaved('已保存');
      const readyToRun = Boolean((provider?.baseUrl || '').trim() && (provider?.selectedModel || '').trim());
      if (readyToRun) showSettingsAlert('');
    } catch (_) {
      showSaved('未保存');
    }
  }

  function schedulePersist() {
    if (!configReady) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      persistNow();
    }, 250);
  }

  /**
   * 同步顶栏当前供应商与模型
   */
  function updateHeaderModelBadge() {
    const provider = getCurrentProvider();
    activeModelTag.classList.remove('hidden');
    if (!provider) {
      activeModelTag.textContent = '未选择供应商';
      activeModelTag.title = '尚未选择供应商';
      return;
    }
    const name = provider.name.trim() || '未命名';
    if (!provider.selectedModel) {
      activeModelTag.textContent = `${name} / 未选模型`;
      activeModelTag.title = `${name} / 未选模型`;
      return;
    }
    activeModelTag.textContent = `${name} / ${provider.selectedModel}`;
    activeModelTag.title = `${name} / ${provider.selectedModel}`;
  }

  function providerLabel(provider) {
    return provider?.name.trim() || '未命名供应商';
  }

  /**
   * 供应商下拉。模型下拉只列出当前供应商自己的模型。
   */
  function renderPickers() {
    const provider = getCurrentProvider();
    renderingPickers = true;
    providerSelect.replaceChildren();
    for (const item of providers) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = providerLabel(item);
      if (item.id === provider?.id) option.selected = true;
      providerSelect.appendChild(option);
    }

    modelSelect.replaceChildren();
    const models = provider && Array.isArray(provider.models) ? provider.models : [];
    if (provider && (!provider.selectedModel || !models.includes(provider.selectedModel))) {
      provider.selectedModel = models[0] || '';
    }
    if (!models.length) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '此供应商还没有模型';
      empty.selected = true;
      modelSelect.appendChild(empty);
      modelSelect.disabled = true;
      removeModelBtn.hidden = true;
    } else {
      modelSelect.disabled = false;
      for (const name of models) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        if (name === provider.selectedModel) option.selected = true;
        modelSelect.appendChild(option);
      }
      removeModelBtn.hidden = false;
    }
    modelScope.textContent = provider ? `属于「${providerLabel(provider)}」` : '';
    renderingPickers = false;
    syncModelTestState(provider);
  }

  function modelTestKey(provider) {
    return provider ? `${provider.id}\n${provider.selectedModel || ''}` : '';
  }

  function clearTestResult() {
    modelTestResult.hidden = true;
    modelTestResult.textContent = '';
    modelTestResult.classList.remove('is-ok', 'is-error');
  }

  function showTestResult(text, state) {
    modelTestResult.hidden = false;
    modelTestResult.textContent = text;
    modelTestResult.classList.toggle('is-ok', state === 'ok');
    modelTestResult.classList.toggle('is-error', state === 'error');
  }

  /**
   * 供应商或模型变化后，清掉上一次的测试结果
   */
  function syncModelTestState(provider) {
    const nextKey = modelTestKey(provider);
    if (nextKey !== shownTestKey) {
      clearTestResult();
      shownTestKey = nextKey;
    }
    if (!testingModel) {
      testModelBtn.disabled = !provider?.selectedModel;
    }
  }

  /**
   * 先写入当前配置，再请求该供应商下选中的模型
   */
  async function testCurrentModel() {
    const provider = getCurrentProvider();
    if (!provider?.selectedModel || testingModel) return;
    readFieldsInto(provider);
    if (!provider.baseUrl.trim()) {
      showTestResult('请先填写 API Base URL', 'error');
      return;
    }
    await persistNow();
    const testedId = provider.id;
    const testedModel = provider.selectedModel;
    testingModel = true;
    testModelBtn.disabled = true;
    testModelBtn.textContent = '测试中';
    showTestResult('正在测试当前模型…', '');

    const client = new OpenAIClient({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: testedModel
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const stillCurrent = () => {
      const current = getCurrentProvider();
      return current?.id === testedId && current?.selectedModel === testedModel;
    };
    try {
      const summary = await client.probeModel(controller.signal);
      if (stillCurrent()) showTestResult(summary, 'ok');
    } catch (err) {
      if (!stillCurrent()) return;
      const message = err?.name === 'AbortError' ? '测试超时，未收到模型响应' : (err.message || '测试失败');
      showTestResult(message, 'error');
    } finally {
      clearTimeout(timer);
      testingModel = false;
      testModelBtn.textContent = '测试';
      testModelBtn.disabled = !getCurrentProvider()?.selectedModel;
    }
  }

  /**
   * 未选择供应商时只保留新建入口，模型选择不单独出现
   */
  function paint() {
    const hasProvider = Boolean(getCurrentProvider());
    providerEmpty.hidden = hasProvider;
    addProviderBtn.hidden = !hasProvider;
    picker.hidden = !hasProvider;
    providerFields.hidden = !hasProvider;
    if (hasProvider) renderPickers();
    updateHeaderModelBadge();
  }

  function selectProvider(id) {
    if (id === activeProviderId) return;
    readFieldsInto(getCurrentProvider());
    activeProviderId = id;
    writeFields(getCurrentProvider());
    resetDeleteArm();
    paint();
    persistNow();
  }

  function selectModel(name) {
    const provider = getCurrentProvider();
    if (!provider || provider.selectedModel === name) return;
    provider.selectedModel = name;
    renderPickers();
    updateHeaderModelBadge();
    persistNow();
  }

  function removeModel(name) {
    const provider = getCurrentProvider();
    if (!provider) return;
    provider.models = (provider.models || []).filter((item) => item !== name);
    if (provider.selectedModel === name) {
      provider.selectedModel = provider.models[0] || '';
    }
    renderPickers();
    updateHeaderModelBadge();
    persistNow();
  }

  /**
   * 新建空白供应商。已有完全空白的供应商时改为选中它。
   */
  function createProvider() {
    readFieldsInto(getCurrentProvider());
    const blank = providers.find((provider) => (
      !provider.name.trim()
      && !provider.baseUrl.trim()
      && !provider.apiKey.trim()
      && (!provider.models || provider.models.length === 0)
    ));
    if (blank) {
      activeProviderId = blank.id;
      writeFields(blank);
    } else {
      const created = {
        id: nextProviderId(),
        name: '',
        baseUrl: '',
        apiKey: '',
        models: [],
        selectedModel: ''
      };
      providers.push(created);
      activeProviderId = created.id;
      writeFields(created);
    }
    resetDeleteArm();
    paint();
    persistNow();
    providerNameInput.focus();
  }

  function addModel() {
    const provider = getCurrentProvider();
    const modelName = newModelInput.value.trim();
    if (!provider || !modelName) {
      if (provider) newModelInput.focus();
      return;
    }
    readFieldsInto(provider);
    if (!Array.isArray(provider.models)) provider.models = [];
    if (!provider.models.includes(modelName)) provider.models.push(modelName);
    provider.selectedModel = modelName;
    newModelInput.value = '';
    renderPickers();
    updateHeaderModelBadge();
    persistNow();
    newModelInput.focus();
  }

  function removeCurrentProvider() {
    if (!getCurrentProvider()) return;
    providers = providers.filter((provider) => provider.id !== activeProviderId);
    activeProviderId = providers[0]?.id || null;
    writeFields(getCurrentProvider());
    resetDeleteArm();
    paint();
    persistNow();
  }

  function showSettingsAlert(text) {
    if (!text) {
      settingsAlert.hidden = true;
      settingsAlert.textContent = '';
      return;
    }
    settingsAlert.hidden = false;
    settingsAlert.textContent = text;
    const scroller = settingsView.querySelector('.settings-scroll');
    if (scroller) scroller.scrollTop = 0;
  }

  function setSettingsOpen(open) {
    harness.classList.toggle('is-settings', open);
    settingsView.hidden = !open;
    settingsToggleBtn.classList.toggle('is-active', open);
    settingsToggleBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (!open) persistNow();
  }

  writeFields(getCurrentProvider());
  paint();
  configReady = true;

  addProviderBtn.addEventListener('click', createProvider);
  addProviderEmptyBtn.addEventListener('click', createProvider);

  providerNameInput.addEventListener('input', () => {
    const provider = getCurrentProvider();
    if (!provider) return;
    readFieldsInto(provider);
    renderPickers();
    updateHeaderModelBadge();
    schedulePersist();
  });

  baseUrlInput.addEventListener('input', () => {
    const provider = getCurrentProvider();
    if (!provider) return;
    readFieldsInto(provider);
    schedulePersist();
  });

  apiKeyInput.addEventListener('input', () => {
    const provider = getCurrentProvider();
    if (!provider) return;
    readFieldsInto(provider);
    schedulePersist();
  });

  deleteProviderBtn.addEventListener('click', () => {
    if (!getCurrentProvider()) return;
    if (!deleteArmed) {
      deleteArmed = true;
      deleteProviderBtn.textContent = '确认删除';
      deleteArmTimer = setTimeout(resetDeleteArm, 2500);
      return;
    }
    removeCurrentProvider();
  });

  providerSelect.addEventListener('change', () => {
    if (renderingPickers) return;
    selectProvider(providerSelect.value);
  });

  modelSelect.addEventListener('change', () => {
    if (renderingPickers) return;
    selectModel(modelSelect.value);
  });

  removeModelBtn.addEventListener('click', () => {
    const provider = getCurrentProvider();
    if (!provider?.selectedModel) return;
    removeModel(provider.selectedModel);
  });

  testModelBtn.addEventListener('click', () => {
    testCurrentModel();
  });

  addModelBtn.addEventListener('click', addModel);
  newModelInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addModel();
    }
  });

  toggleKeyBtn.addEventListener('click', () => {
    const visible = apiKeyInput.type === 'text';
    apiKeyInput.type = visible ? 'password' : 'text';
    toggleKeyBtn.textContent = visible ? '显示' : '隐藏';
  });

  function onRuntimeChange() {
    clampSteps();
    persistNow();
  }

  maxStepsInput.addEventListener('change', onRuntimeChange);
  visionToggle.addEventListener('change', onRuntimeChange);
  cdpToggle.addEventListener('change', onRuntimeChange);

  settingsToggleBtn.addEventListener('click', () => {
    setSettingsOpen(settingsView.hidden);
  });

  settingsCloseBtn.addEventListener('click', () => {
    setSettingsOpen(false);
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
      const tip = '请先选择供应商，再选择该供应商下的模型，并填写 API Base URL。';
      setSettingsOpen(true);
      showSettingsAlert(tip);
      const tipDiv = document.createElement('div');
      tipDiv.className = 'tool-result-box error stream-node';
      tipDiv.textContent = tip;
      streamContainer.appendChild(tipDiv);
      scrollToBottom();
      return;
    }
    showSettingsAlert('');

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
    setSettingsOpen(settingsView.hidden);
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
