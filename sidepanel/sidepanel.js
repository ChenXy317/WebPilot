/**
 * 侧边栏用户交互控制器
 * 处理视图事件、配置存储持久化以及与 Agent 核心的通信联动
 */

import { BrowserAgent } from './agent.js';

// 常见 API 服务商预设参数
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

let currentAgent = null;

document.addEventListener('DOMContentLoaded', async () => {
  // DOM 元素引用
  const statusBadge = document.getElementById('status-badge');
  const toggleSettingsBtn = document.getElementById('toggle-settings-btn');
  const closeSettingsBtn = document.getElementById('close-settings-btn');
  const settingsPanel = document.getElementById('settings-panel');
  const providerSelect = document.getElementById('provider-select');
  const baseUrlInput = document.getElementById('base-url-input');
  const apiKeyInput = document.getElementById('api-key-input');
  const toggleKeyVisibilityBtn = document.getElementById('toggle-key-visibility');
  const modelInput = document.getElementById('model-input');
  const maxStepsInput = document.getElementById('max-steps-input');
  const saveSettingsBtn = document.getElementById('save-settings-btn');

  const taskGoalInput = document.getElementById('task-goal-input');
  const startTaskBtn = document.getElementById('start-task-btn');
  const stopTaskBtn = document.getElementById('stop-task-btn');
  const stepCounter = document.getElementById('step-counter');
  const logsContainer = document.getElementById('logs-container');
  const promptChips = document.querySelectorAll('.prompt-chip');

  // 读取已保存的配置
  const stored = await chrome.storage.local.get(['apiConfig', 'maxSteps']);
  const savedConfig = stored.apiConfig || {
    provider: 'deepseek',
    baseUrl: PROVIDER_PRESETS.deepseek.baseUrl,
    apiKey: '',
    model: PROVIDER_PRESETS.deepseek.model
  };
  const savedMaxSteps = stored.maxSteps || 15;

  // 初始化设置表单视图
  providerSelect.value = savedConfig.provider || 'deepseek';
  baseUrlInput.value = savedConfig.baseUrl || '';
  apiKeyInput.value = savedConfig.apiKey || '';
  modelInput.value = savedConfig.model || '';
  maxStepsInput.value = savedMaxSteps;

  // 展开/折叠设置面板
  toggleSettingsBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('collapsed');
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsPanel.classList.add('collapsed');
  });

  // 服务商预设切换联动
  providerSelect.addEventListener('change', (e) => {
    const preset = PROVIDER_PRESETS[e.target.value];
    if (preset) {
      if (preset.baseUrl) baseUrlInput.value = preset.baseUrl;
      if (preset.model) modelInput.value = preset.model;
    }
  });

  // 密码显示/隐藏切换
  toggleKeyVisibilityBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleKeyVisibilityBtn.textContent = '隐藏';
    } else {
      apiKeyInput.type = 'password';
      toggleKeyVisibilityBtn.textContent = '显示';
    }
  });

  // 保存设置到 Chrome 本地存储
  saveSettingsBtn.addEventListener('click', async () => {
    const config = {
      provider: providerSelect.value,
      baseUrl: baseUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value.trim()
    };
    const maxSteps = parseInt(maxStepsInput.value, 10) || 15;

    await chrome.storage.local.set({ apiConfig: config, maxSteps });

    if (currentAgent) {
      currentAgent.updateConfig(config);
      currentAgent.maxSteps = maxSteps;
    }

    settingsPanel.classList.add('collapsed');
    appendLog({ type: 'success', message: 'API 配置已成功保存' });
  });

  // 快捷 Prompt 标签填充
  promptChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      taskGoalInput.value = chip.dataset.prompt;
      taskGoalInput.focus();
    });
  });

  /**
   * 刷新界面状态徽章
   */
  function setStatus(statusText, type = 'idle') {
    statusBadge.className = `status-pill status-${type}`;
    statusBadge.querySelector('.text').textContent = statusText;
  }

  /**
   * 追加日志卡片
   */
  function appendLog({ type, message, data }) {
    // 移除空状态占位
    const emptyState = logsContainer.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const item = document.createElement('div');
    item.className = 'log-item';

    if (type === 'step') {
      const tag = document.createElement('span');
      tag.className = 'log-step-tag';
      tag.textContent = `第 ${data.step} 步 / 共 ${data.maxSteps} 步`;
      item.appendChild(tag);
    } else if (type === 'thought') {
      const thoughtEl = document.createElement('div');
      thoughtEl.className = 'log-thought';
      thoughtEl.textContent = `💭 ${message}`;
      item.appendChild(thoughtEl);
    } else if (type === 'action') {
      const actionEl = document.createElement('div');
      actionEl.className = 'log-action';
      actionEl.textContent = `⚡ ${message} ${data ? JSON.stringify(data) : ''}`;
      item.appendChild(actionEl);
    } else if (type === 'success') {
      const successEl = document.createElement('div');
      successEl.className = 'log-success';
      successEl.textContent = `✓ ${message}`;
      item.appendChild(successEl);
    } else if (type === 'error') {
      const errEl = document.createElement('div');
      errEl.className = 'log-error';
      errEl.textContent = `✗ 错误: ${message}`;
      item.appendChild(errEl);
    } else if (type === 'warn') {
      const warnEl = document.createElement('div');
      warnEl.className = 'log-warn';
      warnEl.textContent = `! ${message}`;
      item.appendChild(warnEl);
    } else {
      const textEl = document.createElement('div');
      textEl.textContent = message;
      item.appendChild(textEl);
    }

    logsContainer.appendChild(item);
    logsContainer.scrollTop = logsContainer.scrollHeight;
  }

  // 启动任务处理
  startTaskBtn.addEventListener('click', async () => {
    const goal = taskGoalInput.value.trim();
    if (!goal) {
      alert('请先输入要自动执行的目标任务！');
      return;
    }

    const currentConfig = {
      baseUrl: baseUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value.trim()
    };
    const maxSteps = parseInt(maxStepsInput.value, 10) || 15;

    // 清空历史日志容器
    logsContainer.innerHTML = '';
    startTaskBtn.disabled = true;
    stopTaskBtn.disabled = false;
    setStatus('执行中', 'running');

    currentAgent = new BrowserAgent({
      apiConfig: currentConfig,
      maxSteps: maxSteps,
      listeners: {
        statusChange: (status) => {
          if (status === 'running') setStatus('运行中', 'running');
          if (status === 'completed') setStatus('已达成', 'completed');
          if (status === 'stopped') setStatus('已停止', 'idle');
          if (status === 'error') setStatus('发生异常', 'error');
        },
        stepStart: ({ step, maxSteps }) => {
          stepCounter.textContent = `第 ${step} / ${maxSteps} 步`;
          appendLog({ type: 'step', data: { step, maxSteps } });
        },
        log: (logItem) => {
          appendLog(logItem);
        },
        complete: ({ summary }) => {
          appendLog({ type: 'success', message: `🎉 任务圆满完成！\n总结：${summary}` });
          startTaskBtn.disabled = false;
          stopTaskBtn.disabled = true;
        },
        error: (errMessage) => {
          appendLog({ type: 'error', message: errMessage });
          startTaskBtn.disabled = false;
          stopTaskBtn.disabled = true;
        }
      }
    });

    try {
      await currentAgent.start(goal);
    } catch (e) {
      appendLog({ type: 'error', message: e.message });
    } finally {
      startTaskBtn.disabled = false;
      stopTaskBtn.disabled = true;
    }
  });

  // 停止任务处理
  stopTaskBtn.addEventListener('click', async () => {
    if (currentAgent) {
      await currentAgent.stop();
      startTaskBtn.disabled = false;
      stopTaskBtn.disabled = true;
      setStatus('已停止', 'idle');
    }
  });
});
