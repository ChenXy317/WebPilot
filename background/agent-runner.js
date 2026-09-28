/**
 * 智能体后台自动化调度引擎
 * 在后台 Service Worker 中编排感知、推理、执行与校验，确保脱离界面常驻运行
 */

import { OpenAIClient } from '../lib/openai.js';

export class AgentRunner {
  /**
   * 初始化调度引擎
   * @param {Object} options - 参数选项
   * @param {Object} options.apiConfig - OpenAI 接口配置项
   * @param {number} [options.maxSteps=20] - 单任务最大步数上限
   * @param {boolean} [options.enableVision=false] - 是否启用视口截图多模态辅助
   * @param {boolean} [options.enableCdp=false] - 是否使用真实 CDP 硬件事件
   * @param {Function} [options.onEvent] - 统一事件广播回调
   */
  constructor({ apiConfig, maxSteps = 20, enableVision = false, enableCdp = false, onEvent = () => {} }) {
    this.apiClient = new OpenAIClient(apiConfig);
    this.maxSteps = maxSteps;
    this.enableVision = enableVision;
    this.enableCdp = enableCdp;
    this.onEvent = onEvent;

    this.status = 'idle'; // idle | running | paused | stopped | completed | error
    this.currentStep = 0;
    this.history = [];
    this.currentGoal = '';
    this.targetTabId = null;

    this.pausePromiseResolve = null;
    this.cdpAttached = false;

    // 监听 CDP 外部断开事件
    this.onDebuggerDetach = (source, reason) => {
      if (source && source.tabId === this.targetTabId) {
        this.cdpAttached = false;
        this.emit('log', {
          logType: 'warn',
          text: `CDP 调试器已断开 (${reason || '外部断开'})，已自动切换至原生 DOM 模拟事件`
        });
      }
    };
    chrome.debugger.onDetach.addListener(this.onDebuggerDetach);
  }

  /**
   * 更新 API 与运行配置
   */
  updateConfig(config) {
    if (config.apiConfig) {
      this.apiClient = new OpenAIClient(config.apiConfig);
    }
    if (typeof config.maxSteps === 'number') this.maxSteps = config.maxSteps;
    if (typeof config.enableVision === 'boolean') this.enableVision = config.enableVision;
    if (typeof config.enableCdp === 'boolean') this.enableCdp = config.enableCdp;
  }

  /**
   * 广播事件
   */
  emit(type, payload = {}) {
    this.onEvent({ type, status: this.status, step: this.currentStep, maxSteps: this.maxSteps, ...payload });
  }

  /**
   * 挂起检测与等待恢复
   */
  async checkPauseState() {
    if (this.status === 'paused') {
      await new Promise((resolve) => {
        this.pausePromiseResolve = resolve;
      });
    }
  }

  /**
   * 暂停任务
   */
  /**
   * 序列化当前调度器状态
   */
  serializeState() {
    return {
      status: this.status,
      currentStep: this.currentStep,
      maxSteps: this.maxSteps,
      history: this.history,
      currentGoal: this.currentGoal,
      targetTabId: this.targetTabId,
      enableVision: this.enableVision,
      enableCdp: this.enableCdp
    };
  }

  /**
   * 将当前调度器状态持久化到本地存储
   */
  async saveState() {
    try {
      await chrome.storage.local.set({
        agentRunnerState: this.serializeState()
      });
    } catch (_) {}
  }

  /**
   * 清理本地持久化的调度器状态
   */
  async clearState() {
    try {
      await chrome.storage.local.remove(['agentRunnerState']);
    } catch (_) {}
  }

  /**
   * 暂停任务
   */
  async pause() {
    if (this.status === 'running') {
      this.status = 'paused';
      this.emit('statusChange', { status: this.status });
      this.emit('log', { logType: 'info', text: '任务已挂起暂停' });
      await this.saveState();
    }
  }

  /**
   * 恢复执行
   */
  async resume() {
    if (this.status === 'paused') {
      this.status = 'running';
      this.emit('statusChange', { status: this.status });
      this.emit('log', { logType: 'info', text: '任务已恢复执行' });
      if (this.pausePromiseResolve) {
        this.pausePromiseResolve();
        this.pausePromiseResolve = null;
      }
      await this.saveState();
    }
  }

  /**
   * 终止任务
   */
  async stop() {
    this.status = 'stopped';
    if (this.pausePromiseResolve) {
      this.pausePromiseResolve();
      this.pausePromiseResolve = null;
    }
    this.emit('statusChange', { status: this.status });
    this.emit('log', { logType: 'warn', text: '任务已由用户手动停止' });
    await this.clearState();
    await this.cleanup();
  }

  /**
   * 获取当前聚焦的可用标签页
   */
  async getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error('未检测到前台活跃网页标签页，请先打开一个网页');
    }
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      throw new Error('浏览器内置页面受安全策略限制，无法注入脚本。请先打开普通的 http/https 网页');
    }
    return tab;
  }

  /**
   * 确保目标标签页已加载内容脚本
   */
  async ensureContentScriptInjected(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: 'PING' });
      if (response && response.status === 'PONG') {
        return;
      }
    } catch (_) {}

    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/overlay.css']
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content-script.js']
    });

    await new Promise((r) => setTimeout(r, 200));
  }

  /**
   * 连接 Chrome DevTools Protocol 调试器以支持硬件级输入
   */
  async attachCdp(tabId) {
    if (!this.enableCdp || this.cdpAttached) return;
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      this.cdpAttached = true;
    } catch (e) {
      console.warn('附加 CDP 失败，将平滑降级至原生 DOM 模拟事件:', e.message);
      this.cdpAttached = false;
    }
  }

  /**
   * 断开 CDP 调试器连接
   */
  async detachCdp(tabId) {
    if (this.cdpAttached && tabId) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch (_) {}
      this.cdpAttached = false;
    }
  }

  /**
   * 格式化扫描数据为结构化描述提示
   */
  formatElementsPrompt(scanData) {
    const lines = [];
    lines.push(`【当前网页信息】`);
    lines.push(`标题: "${scanData.title}"`);
    lines.push(`URL: ${scanData.url}`);
    lines.push(`视口位置: ${scanData.scrollY}px / 页面总高: ${scanData.pageHeight}px\n`);
    lines.push(`【当前视口内可见交互元素列表】`);

    if (!scanData.elements || scanData.elements.length === 0) {
      lines.push('(当前视口内未检测到可交互元素，若需寻找内容请调用 scroll_page 向下滚动)');
    } else {
      for (const el of scanData.elements) {
        const parts = [`[${el.index}] <${el.tag}>`];
        if (el.ref) parts.push(`ref="${el.ref}"`);
        if (el.type) parts.push(`type="${el.type}"`);
        if (el.role) parts.push(`role="${el.role}"`);
        if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
        if (el.text) parts.push(`text="${el.text}"`);
        if (el.href) parts.push(`href="${el.href.slice(0, 60)}"`);
        lines.push(parts.join(' '));
      }
    }

    return lines.join('\n');
  }

  /**
   * 等待页面加载完成或网络空闲
   */
  waitForPageReady(tabId, timeoutMs = 12000) {
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };

      const timer = setTimeout(done, timeoutMs);

      function listener(updatedTabId, changeInfo) {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          setTimeout(done, 600);
        }
      }
      chrome.tabs.onUpdated.addListener(listener);

      chrome.tabs.get(tabId).then((tab) => {
        if (tab && tab.status === 'complete') {
          setTimeout(done, 500);
        }
      }).catch(() => done());
    });
  }

  /**
   * 执行动作工具并获取变动反馈
   */
  async executeToolCall(tabId, toolCall) {
    const { name, arguments: args } = toolCall;

    switch (name) {
      case 'click_element': {
        const useCdp = this.cdpAttached;
        let res;
        try {
          res = await chrome.tabs.sendMessage(tabId, {
            action: 'CLICK',
            index: args.index,
            ref: args.ref,
            skipDomClick: useCdp
          });
        } catch (sendErr) {
          if (sendErr.message?.includes('message channel closed') || sendErr.message?.includes('Could not establish connection')) {
            await this.waitForPageReady(tabId);
            return `已触发点击元素 (ref: "${args.ref}")，检测到页面已完成导航跳转`;
          }
          throw sendErr;
        }

        if (!res?.success) throw new Error(res?.error || '点击元素失败');

        // 若启用且附着 CDP，仅由 CDP 派发系统级硬件单击
        if (useCdp && res.data?.center) {
          const { x, y } = res.data.center;
          try {
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x,
              y,
              button: 'left',
              clickCount: 1
            });
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x,
              y,
              button: 'left',
              clickCount: 1
            });
          } catch (cdpErr) {
            console.warn('CDP 物理点击派发异常:', cdpErr.message);
          }
        }

        // 检测页面重载或导航
        await new Promise((r) => setTimeout(r, 600));
        try {
          const tabInfo = await chrome.tabs.get(tabId);
          if (tabInfo.status === 'loading') {
            await this.waitForPageReady(tabId);
            if (this.enableCdp && !this.cdpAttached) {
              await this.attachCdp(tabId);
            }
          }
        } catch (_) {}

        const summary = res.data?.statusSummary ? `（${res.data.statusSummary}）` : '';
        return `${res.data?.message || `已点击元素 [${args.index}]`}${summary}`;
      }

      case 'input_text': {
        const res = await chrome.tabs.sendMessage(tabId, {
          action: 'INPUT',
          index: args.index,
          ref: args.ref,
          text: args.text,
          pressEnter: Boolean(args.press_enter)
        });
        if (!res.success) throw new Error(res.error || '输入文本失败');

        if (args.press_enter) {
          await new Promise((r) => setTimeout(r, 600));
          try {
            const tabInfo = await chrome.tabs.get(tabId);
            if (tabInfo.status === 'loading') {
              await this.waitForPageReady(tabId);
              if (this.enableCdp && !this.cdpAttached) {
                await this.attachCdp(tabId);
              }
            }
          } catch (_) {}
        }

        const summary = res.data?.statusSummary ? `（${res.data.statusSummary}）` : '';
        return `${res.data?.message || `已在元素 [${args.index}] 中键入文本`}${summary}`;
      }

      case 'read_page_content': {
        const res = await chrome.tabs.sendMessage(tabId, {
          action: 'EXTRACT_CONTENT',
          selector: args.selector,
          maxLength: args.max_length || 3000
        });
        if (!res.success) throw new Error(res.error || '提取页面文本失败');
        const data = res.data;
        return `【页面文本内容 (来源: "${data.title || '当前网页'}")】\n${data.content}`;
      }

      case 'scroll_page': {
        const res = await chrome.tabs.sendMessage(tabId, {
          action: 'SCROLL',
          direction: args.direction || 'down',
          amount: args.amount || 600
        });
        if (!res.success) throw new Error(res.error || '页面滚动失败');
        return res.data?.message || `已向${args.direction === 'up' ? '上' : '下'}滚动`;
      }

      case 'navigate_to': {
        const targetUrl = args.url ? args.url.trim() : '';
        if (!/^https?:\/\//i.test(targetUrl)) {
          throw new Error(`安全限制：拒绝跳转至不安全的非 HTTP/HTTPS 协议 (${targetUrl})`);
        }
        await chrome.tabs.update(tabId, { url: targetUrl });
        await this.waitForPageReady(tabId);
        if (this.enableCdp) {
          await this.attachCdp(tabId);
        }
        return `已跳转至: ${targetUrl}`;
      }

      case 'wait_seconds': {
        const sec = Math.max(1, Math.min(8, args.seconds || 2));
        await new Promise((r) => setTimeout(r, sec * 1000));
        return `已等待 ${sec} 秒`;
      }

      case 'finish_task': {
        return args.summary || '任务已成功达成';
      }

      default:
        throw new Error(`未知操作指令: ${name}`);
    }
  }

  /**
   * 启动任务主调度循环
   */
  async start(goal) {
    this.status = 'running';
    this.currentStep = 0;
    this.currentGoal = goal;
    this.history = [];
    this.emit('statusChange', { status: this.status });

    const activeTab = await this.getActiveTab();
    this.targetTabId = activeTab.id;

    if (this.enableCdp) {
      await this.attachCdp(this.targetTabId);
    }

    const systemPrompt = `你是一个专业的浏览器网页自动化操作助理。
你的目标是根据用户提出的需求，自主通过对当前网页的元素识别、点击、输入与导航，一步步完成该任务。

【操作原则】
1. 每次循环，你都会收到当前页面的标题、地址以及可见的元素列表。每个元素都具备唯一的稳定语义指纹引用 ref（如 ref="button_3a1f4b"）以及当前帧编号 [1]。
2. 调用 click_element 和 input_text 工具时，必须提供目标元素的 ref 属性（ref 是唯一持久主键，index 为辅助别名）。
3. 如果任务目标涉及阅读文章、获取商品信息、提取页面数据或总结内容，请优先调用 read_page_content 工具提取结构化正文，避免在按钮间无序探索。
4. 每次动作执行后，工具反馈中会包含真实的局部变动或属性变化（如展开状态变化、局部更新、页面跳转等），请根据实际反馈评估上一步是否真正生效。
5. 每次回复必须且仅能调用一个最关键的工具函数，严禁单次返回多个工具调用。
6. 如果需要搜索内容，先找到输入框调用 input_text，将 press_enter 设为 true 或接着点击搜索按钮。
7. 如果所需信息或按钮不在当前视口内，可以调用 scroll_page 向下滚动浏览。
8. 当你确认用户的目标已经完成，必须调用 finish_task 工具并提供完整的总结答复。`;

    this.history.push({ role: 'system', content: systemPrompt });
    await this.saveState();

    return this.runLoop();
  }

  /**
   * 从已保存的状态中反序列化恢复执行
   */
  async resumeExecution(savedState) {
    this.status = 'running';
    this.currentStep = savedState.currentStep || 0;
    this.maxSteps = savedState.maxSteps || this.maxSteps;
    this.currentGoal = savedState.currentGoal || '';
    this.history = savedState.history || [];
    this.targetTabId = savedState.targetTabId;
    this.enableVision = savedState.enableVision ?? this.enableVision;
    this.enableCdp = savedState.enableCdp ?? this.enableCdp;

    this.emit('statusChange', { status: this.status });
    this.emit('log', { logType: 'info', text: `已从断点恢复任务调度 (第 ${this.currentStep} 步)` });

    if (this.enableCdp && this.targetTabId) {
      await this.attachCdp(this.targetTabId);
    }

    return this.runLoop();
  }

  /**
   * 调度引擎主循环
   */
  async runLoop() {
    let consecutiveNoToolCount = 0;

    try {
      while (this.status === 'running' && this.currentStep < this.maxSteps) {
        await this.checkPauseState();
        if (this.status !== 'running') break;

        this.currentStep++;
        this.emit('stepStart', { step: this.currentStep, maxSteps: this.maxSteps });
        await this.saveState();

        // 标签页就绪校验
        let tab;
        try {
          tab = await chrome.tabs.get(this.targetTabId);
        } catch (_) {
          throw new Error('目标网页标签页已失效或被关闭，任务终止');
        }

        if (tab.status === 'loading') {
          await this.waitForPageReady(this.targetTabId);
        }

        await this.ensureContentScriptInjected(this.targetTabId);

        // 页面感知
        this.emit('log', { logType: 'scan', text: '正在感知分析当前网页结构...' });
        const scanResponse = await chrome.tabs.sendMessage(this.targetTabId, { action: 'SCAN' });
        if (!scanResponse || !scanResponse.success) {
          throw new Error(scanResponse?.error || '网页 DOM 结构提取失败');
        }

        // 历史快照归档，避免 Context 爆炸（兼顾纯文本与多模态数组格式）
        for (let i = 0; i < this.history.length; i++) {
          const item = this.history[i];
          if (item.role === 'user') {
            if (typeof item.content === 'string' && item.content.includes('【当前视口内可见交互元素列表】')) {
              item.content = `用户目标: "${this.currentGoal}" (历史快照已归档)`;
            } else if (Array.isArray(item.content)) {
              item.content = item.content.map((part) => {
                if (part.type === 'text' && part.text && part.text.includes('【当前视口内可见交互元素列表】')) {
                  return { type: 'text', text: `用户目标: "${this.currentGoal}" (历史快照已归档)` };
                }
                return part;
              });
            }
          }
        }

        const pagePrompt = this.formatElementsPrompt(scanResponse.data);
        const userPrompt = `用户目标: "${this.currentGoal}"\n\n${pagePrompt}\n\n请观察分析当前页面，决定下一步操作。`;

        // 视觉多模态支持（仅保留最新视口单帧截图，历史旧图降级为占位符）
        let messagePayload;
        if (this.enableVision) {
          for (const item of this.history) {
            if (Array.isArray(item.content)) {
              item.content = item.content.map((part) => {
                if (part && part.type === 'image_url') {
                  return { type: 'text', text: '[历史视口截图已归档释放]' };
                }
                return part;
              });
              if (item.content.every((p) => p.type === 'text')) {
                item.content = item.content.map((p) => p.text).join('\n');
              }
            }
          }

          let dataUrl = null;
          if (this.cdpAttached) {
            try {
              const res = await chrome.debugger.sendCommand({ tabId: this.targetTabId }, 'Page.captureScreenshot', {
                format: 'jpeg',
                quality: 65
              });
              if (res?.data) {
                dataUrl = `data:image/jpeg;base64,${res.data}`;
              }
            } catch (_) {}
          }

          if (!dataUrl) {
            try {
              const [activeInWindow] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
              if (!activeInWindow || activeInWindow.id !== this.targetTabId) {
                await chrome.tabs.update(this.targetTabId, { active: true });
                await new Promise((r) => setTimeout(r, 150));
              }
              dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 65 });
            } catch (_) {}
          }

          if (dataUrl) {
            messagePayload = [
              { type: 'text', text: userPrompt },
              { type: 'image_url', image_url: { url: dataUrl } }
            ];
          } else {
            messagePayload = userPrompt;
          }
        } else {
          messagePayload = userPrompt;
        }

        this.history.push({ role: 'user', content: messagePayload });

        // 推理：流式请求大模型
        this.emit('modelThinkingStart');

        const completion = await this.apiClient.chatCompletionStream(this.history, (chunk) => {
          if (chunk.type === 'thought') {
            this.emit('thoughtChunk', { text: chunk.text });
          } else if (chunk.type === 'content') {
            this.emit('contentChunk', { text: chunk.text });
          }
        });

        this.emit('modelThinkingEnd', {
          content: completion.content,
          reasoning: completion.reasoning
        });

        // 空转防死循环保护
        if (!completion.toolCalls || completion.toolCalls.length === 0) {
          consecutiveNoToolCount++;
          if (consecutiveNoToolCount >= 3) {
            throw new Error('模型连续多次未下发具体操作指令，任务自动中止');
          }
          this.emit('log', {
            logType: 'warn',
            text: '模型未触发工具调用，正在引导其输出操作...'
          });
          this.history.push({
            role: 'assistant',
            content: completion.content || '我正在思考如何推进...'
          });
          this.history.push({
            role: 'user',
            content: '提示：请必须且仅能调用一个工具函数（如 click_element, input_text, scroll_page 等）来继续执行任务。'
          });
          this.currentStep--;
          continue;
        }

        // 成功获取工具调用后清理临时重试消息以保持历史整洁
        if (consecutiveNoToolCount > 0) {
          this.history.splice(-consecutiveNoToolCount * 2);
        }
        consecutiveNoToolCount = 0;

        const primaryTool = completion.toolCalls[0];
        this.emit('toolCallStart', {
          id: primaryTool.id,
          name: primaryTool.name,
          args: primaryTool.arguments
        });

        // 执行动作
        let execResult;
        try {
          execResult = await this.executeToolCall(this.targetTabId, primaryTool);
          this.emit('toolCallEnd', {
            id: primaryTool.id,
            name: primaryTool.name,
            success: true,
            result: execResult
          });
        } catch (execErr) {
          this.emit('toolCallEnd', {
            id: primaryTool.id,
            name: primaryTool.name,
            success: false,
            result: execErr.message
          });
          throw execErr;
        }

        const callId = primaryTool.id || `call_${Date.now()}`;
        this.history.push({
          role: 'assistant',
          content: completion.content || null,
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

        await this.saveState();

        if (primaryTool.name === 'finish_task') {
          this.status = 'completed';
          this.emit('statusChange', { status: this.status });
          this.emit('complete', { summary: execResult });
          await this.clearState();
          await this.cleanup();
          return;
        }

        await new Promise((r) => setTimeout(r, 600));
      }

      if (this.currentStep >= this.maxSteps && this.status === 'running') {
        this.status = 'stopped';
        this.emit('statusChange', { status: this.status });
        this.emit('error', { message: `已达到最大执行步数限制 (${this.maxSteps} 步)` });
        await this.clearState();
      }
    } catch (err) {
      if (this.status !== 'stopped') {
        this.status = 'error';
        this.emit('statusChange', { status: this.status });
        this.emit('error', { message: err.message || String(err) });
        await this.clearState();
      }
    } finally {
      await this.cleanup();
    }
  }

  /**
   * 清理角标与调试状态
   */
  async cleanup() {
    if (this.onDebuggerDetach) {
      chrome.debugger.onDetach.removeListener(this.onDebuggerDetach);
      this.onDebuggerDetach = null;
    }
    if (this.targetTabId) {
      try {
        await chrome.tabs.sendMessage(this.targetTabId, { action: 'CLEAR_MARKERS' });
      } catch (_) {}
      if (this.cdpAttached) {
        await this.detachCdp(this.targetTabId);
      }
    }
  }
}
