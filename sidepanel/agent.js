/**
 * 浏览器智能体核心调度器 (Browser Agent)
 * 编排感知（Observe）、推理（Reason）、执行（Act）及状态验证的闭环流程
 */

import { OpenAIClient } from '../lib/openai.js';

export class BrowserAgent {
  /**
   * 初始化智能体
   * @param {Object} options - 参数选项
   * @param {Object} options.apiConfig - OpenAI 接口配置项
   * @param {number} [options.maxSteps=15] - 单个任务的最大执行步数上限
   * @param {Object} [options.listeners={}] - 事件回调钩子
   */
  constructor({ apiConfig, maxSteps = 15, listeners = {} }) {
    this.apiClient = new OpenAIClient(apiConfig);
    this.maxSteps = maxSteps;
    this.listeners = listeners;

    this.status = 'idle'; // idle | running | paused | stopped | completed | error
    this.currentStep = 0;
    this.history = [];
    this.currentGoal = '';
    this.targetTabId = null;
  }

  /**
   * 更新 API 配置
   */
  updateConfig(apiConfig) {
    this.apiClient = new OpenAIClient(apiConfig);
  }

  /**
   * 触发事件通知
   */
  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event](data);
    }
  }

  /**
   * 获取当前聚焦的网页标签页
   */
  async getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error('未检测到活跃的网页标签页，请先在前台打开一个网页');
    }
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      throw new Error('浏览器内置页面受安全策略限制，无法注入脚本。请先打开普通的 http/https 网页');
    }
    return tab;
  }

  /**
   * 确保目标标签页已注入内容脚本（免去手动刷新网页的繁琐操作）
   */
  async ensureContentScriptInjected(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: 'PING' });
      if (response && response.status === 'PONG') {
        return;
      }
    } catch (_) {}

    // 未响应则主动动态注入脚本与样式
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/overlay.css']
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content-script.js']
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  /**
   * 格式化页面元素列表为结构化提示词
   */
  formatElementsPrompt(scanData) {
    const lines = [];
    lines.push(`【当前网页信息】`);
    lines.push(`页面标题: "${scanData.title}"`);
    lines.push(`当前地址: ${scanData.url}`);
    lines.push(`视口滚动: ${scanData.scrollY}px / 总高度: ${scanData.pageHeight}px\n`);
    lines.push(`【当前视口内可见的交互元素列表 (编号及描述)】`);

    if (!scanData.elements || scanData.elements.length === 0) {
      lines.push('(视口内未检测到可交互的按钮或表单元素，请考虑使用 scroll_page 向下滚动以寻找目标)');
    } else {
      for (const el of scanData.elements) {
        const parts = [`[${el.index}] <${el.tag}>`];
        if (el.type) parts.push(`type="${el.type}"`);
        if (el.role) parts.push(`role="${el.role}"`);
        if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
        if (el.text) parts.push(`text="${el.text}"`);
        if (el.href) parts.push(`href="${el.href.slice(0, 50)}"`);
        lines.push(parts.join(' '));
      }
    }

    return lines.join('\n');
  }

  /**
   * 等待标签页加载完毕
   */
  waitForTabLoad(tabId, timeoutMs = 12000) {
    return new Promise((resolve) => {
      let isResolved = false;
      const done = () => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };

      const timer = setTimeout(done, timeoutMs);

      function listener(updatedTabId, changeInfo) {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          done();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);

      // 快速检查标签页当前是否已经处于就绪状态
      chrome.tabs.get(tabId).then((tab) => {
        if (tab && tab.status === 'complete') {
          setTimeout(done, 400);
        }
      }).catch(() => done());
    });
  }

  /**
   * 执行大模型决策的具体操作
   */
  async executeToolCall(tabId, toolCall) {
    const { name, arguments: args } = toolCall;

    switch (name) {
      case 'click_element': {
        const res = await chrome.tabs.sendMessage(tabId, {
          action: 'CLICK',
          index: args.index
        });
        if (!res.success) throw new Error(res.error || '点击失败');

        // 检测操作后是否触发页面跳转或重载
        await new Promise((r) => setTimeout(r, 600));
        try {
          const tabInfo = await chrome.tabs.get(tabId);
          if (tabInfo.status === 'loading') {
            await this.waitForTabLoad(tabId);
            await new Promise((r) => setTimeout(r, 800));
          }
        } catch (_) {}

        return res.data.message;
      }

      case 'input_text': {
        const res = await chrome.tabs.sendMessage(tabId, {
          action: 'INPUT',
          index: args.index,
          text: args.text,
          pressEnter: Boolean(args.press_enter)
        });
        if (!res.success) throw new Error(res.error || '输入失败');

        // 若回车提交触发表单跳转则等待页面就绪
        if (args.press_enter) {
          await new Promise((r) => setTimeout(r, 600));
          try {
            const tabInfo = await chrome.tabs.get(tabId);
            if (tabInfo.status === 'loading') {
              await this.waitForTabLoad(tabId);
              await new Promise((r) => setTimeout(r, 800));
            }
          } catch (_) {}
        }

        return res.data.message;
      }

      case 'scroll_page': {
        const res = await chrome.tabs.sendMessage(tabId, {
          action: 'SCROLL',
          direction: args.direction || 'down',
          amount: args.amount || 600
        });
        if (!res.success) throw new Error(res.error || '滚动失败');
        return res.data.message;
      }

      case 'navigate_to': {
        await chrome.tabs.update(tabId, { url: args.url });
        await this.waitForTabLoad(tabId);
        await new Promise((r) => setTimeout(r, 1000));
        return `已跳转至: ${args.url}`;
      }

      case 'wait_seconds': {
        const waitSec = Math.max(1, Math.min(10, args.seconds || 2));
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        return `已等待 ${waitSec} 秒`;
      }

      case 'finish_task': {
        return args.summary || '任务已成功完成';
      }

      default:
        throw new Error(`未定义的工具函数: ${name}`);
    }
  }

  /**
   * 启动自动化执行任务主循环
   * @param {string} goal - 用户的自然语言目标
   */
  async start(goal) {
    this.status = 'running';
    this.currentStep = 0;
    this.currentGoal = goal;
    this.history = [];
    this.emit('statusChange', this.status);

    // 绑定初始目标标签页，避免在多标签页切换时产生漂移
    const initialTab = await this.getActiveTab();
    this.targetTabId = initialTab.id;

    const systemPrompt = `你是一个专业的浏览器网页自动化操作助理。
你的目标是根据用户提出的需求，自主通过对当前网页的元素识别、点击、输入与导航，一步步完成该任务。

【操作原则】
1. 每次循环，你都会收到当前页面的标题、地址以及可见的元素列表（每个元素带有唯一数字方括号编号，如 [1] <button> 搜索）。
2. 你需要分析当前页面的状态，推导出达成目标需要的下一个动作，并调用预设工具执行它。
3. 每次回复必须且仅能调用一个最关键的工具函数，严禁单次返回多个工具调用。
4. 如果需要搜索内容，先找到输入框调用 input_text，将 press_enter 设为 true 或接着点击搜索按钮。
5. 如果所需信息或按钮不在当前视口内，可以调用 scroll_page 向下滚动浏览。
6. 当你确认用户的目标已经完成，必须调用 finish_task 工具并提供完整的总结答复。
7. 一次只执行一个最符合当前决策的关键动作，不要盲目重复已经失败的操作。`;

    this.history.push({ role: 'system', content: systemPrompt });

    try {
      while (this.status === 'running' && this.currentStep < this.maxSteps) {
        this.currentStep++;
        this.emit('stepStart', { step: this.currentStep, maxSteps: this.maxSteps });

        // 1. 验证目标标签页存活与就绪状态
        let tab;
        try {
          tab = await chrome.tabs.get(this.targetTabId);
        } catch (err) {
          throw new Error('目标网页标签页已被关闭，自动化任务终止');
        }

        if (tab.status === 'loading') {
          await this.waitForTabLoad(this.targetTabId);
        }

        await this.ensureContentScriptInjected(this.targetTabId);

        // 2. 感知：扫描当前页面及元素
        this.emit('log', { type: 'info', message: '正在感知并分析当前网页结构...' });
        const scanResponse = await chrome.tabs.sendMessage(this.targetTabId, { action: 'SCAN' });
        if (!scanResponse || !scanResponse.success) {
          throw new Error(scanResponse?.error || '网页扫描失败');
        }

        // 3. 压缩过往轮次中的旧 DOM 快照，控制上下文长度并避免元素序号混淆
        for (let i = 0; i < this.history.length; i++) {
          const msg = this.history[i];
          if (msg.role === 'user' && msg.content.includes('【当前视口内可见的交互元素列表')) {
            msg.content = `用户任务目标: "${this.currentGoal}"\n(此历史步骤页面快照已归档)`;
          }
        }

        const pageSnapshotPrompt = this.formatElementsPrompt(scanResponse.data);
        const userPrompt = `用户任务目标: "${this.currentGoal}"\n\n${pageSnapshotPrompt}\n\n请分析当前页面状态，决定下一步执行的操作。`;

        this.history.push({ role: 'user', content: userPrompt });

        // 4. 推理：调用大模型决策
        this.emit('log', { type: 'thinking', message: '大模型正在思考下一步操作...' });
        const completion = await this.apiClient.chatCompletion(this.history);

        if (completion.content) {
          this.emit('log', { type: 'thought', message: completion.content });
        }

        // 检查是否有工具调用
        if (!completion.toolCalls || completion.toolCalls.length === 0) {
          this.emit('log', { type: 'warn', message: '大模型未返回具体操作，尝试继续推进...' });
          continue;
        }

        const primaryTool = completion.toolCalls[0];
        this.emit('log', {
          type: 'action',
          message: `执行动作: ${primaryTool.name}`,
          data: primaryTool.arguments
        });

        // 5. 执行：向页面执行器派发动作
        const execResult = await this.executeToolCall(this.targetTabId, primaryTool);
        this.emit('log', { type: 'success', message: execResult });

        // 统一 Tool Call ID 标识
        const callId = primaryTool.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        // 记录历史
        this.history.push({
          role: 'assistant',
          content: completion.content,
          tool_calls: [
            {
              id: callId,
              type: 'function',
              function: {
                name: primaryTool.name,
                arguments: JSON.stringify(primaryTool.arguments)
              }
            }
          ]
        });

        this.history.push({
          role: 'tool',
          tool_call_id: callId,
          content: execResult
        });

        // 判断是否完成
        if (primaryTool.name === 'finish_task') {
          this.status = 'completed';
          this.emit('statusChange', this.status);
          this.emit('complete', { summary: execResult });
          await this.cleanupPageMarkers(this.targetTabId);
          return;
        }

        // 动作间隔缓冲
        await new Promise((r) => setTimeout(r, 1200));
      }

      if (this.currentStep >= this.maxSteps && this.status === 'running') {
        this.status = 'stopped';
        this.emit('statusChange', this.status);
        this.emit('error', `已达到最大步数限制 (${this.maxSteps} 步)，任务暂停`);
      }
    } catch (err) {
      if (this.status !== 'stopped') {
        this.status = 'error';
        this.emit('statusChange', this.status);
        this.emit('error', err.message || String(err));
      }
    } finally {
      if (this.targetTabId) {
        await this.cleanupPageMarkers(this.targetTabId);
      }
    }
  }

  /**
   * 清除页面角标
   */
  async cleanupPageMarkers(tabId) {
    if (!tabId) return;
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'CLEAR_MARKERS' });
    } catch (_) {}
  }

  /**
   * 停止当前任务
   */
  async stop() {
    this.status = 'stopped';
    this.emit('statusChange', this.status);
    this.emit('log', { type: 'warn', message: '用户已手动中止任务' });
    if (this.targetTabId) {
      await this.cleanupPageMarkers(this.targetTabId);
    }
  }
}
