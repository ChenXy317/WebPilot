/**
 * 网页内容脚本 (Content Script)
 * 负责页面元素感知（提取与视觉角标标注）及模拟执行用户动作
 */

(() => {
  // 维护当前屏幕上已标注的元素映射表
  let elementRegistry = new Map();
  let markersContainer = null;

  /**
   * 初始化角标容器
   */
  function ensureMarkerContainer() {
    if (!markersContainer || !document.contains(markersContainer)) {
      markersContainer = document.createElement('div');
      markersContainer.id = 'webauto-markers-container';
      document.body.appendChild(markersContainer);
    }
    return markersContainer;
  }

  /**
   * 清除页面上所有的标注角标与高亮框
   */
  function clearAllMarkers() {
    if (markersContainer && markersContainer.parentNode) {
      markersContainer.innerHTML = '';
    }
    document.querySelectorAll('.webauto-highlight-active').forEach((el) => {
      el.classList.remove('webauto-highlight-active');
    });
    elementRegistry.clear();
  }

  /**
   * 判断元素在视口中是否可见
   */
  function isElementVisible(el) {
    if (!el || !(el instanceof Element)) return false;

    // 过滤自身或父级隐藏属性
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      el.hasAttribute('hidden') ||
      el.getAttribute('aria-hidden') === 'true'
    ) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    // 视口相交判定
    const inViewport = (
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.left <= (window.innerWidth || document.documentElement.clientWidth)
    );

    return inViewport;
  }

  /**
   * 获取元素的描述文本
   */
  function extractElementText(el) {
    const tagName = el.tagName.toLowerCase();
    
    // 输入框取 placeholder 或当前值
    if (tagName === 'input' || tagName === 'textarea') {
      const inputEl = el;
      return inputEl.placeholder || inputEl.value || inputEl.getAttribute('aria-label') || '';
    }

    // 优先读取显式无障碍标签与提示
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();

    // 提取图像媒体替代文本
    const alt = el.getAttribute('alt') || el.querySelector('img')?.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();

    // 读取文本内容
    const text = el.innerText || el.textContent || '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  /**
   * 扫描页面中所有可交互元素并为其打上数字角标
   */
  function scanAndMarkElements() {
    clearAllMarkers();
    const container = ensureMarkerContainer();

    // 候选选择器列表
    const selector = [
      'a[href]',
      'button',
      'input',
      'select',
      'textarea',
      '[role="button"]',
      '[role="link"]',
      '[role="textbox"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[tabindex]:not([tabindex="-1"])',
      '[onclick]'
    ].join(',');

    const candidateSet = new Set(document.querySelectorAll(selector));

    // 补充带有手型指针的交互元素，并过滤已被包含在父交互节点内的冗余子元素
    const pointerNodes = document.querySelectorAll('div, span, li, p');
    for (const node of pointerNodes) {
      if (candidateSet.size >= 250) break;
      if (candidateSet.has(node)) continue;

      if (node.closest('button, a, select, textarea, [role="button"]')) continue;

      const style = window.getComputedStyle(node);
      if (style.cursor === 'pointer') {
        candidateSet.add(node);
      }
    }

    let nextIndex = 1;
    const elementsData = [];

    for (const el of candidateSet) {
      // 避免标记角标自身或容器内部
      if (container.contains(el)) continue;

      if (!isElementVisible(el)) continue;

      const rect = el.getBoundingClientRect();
      const tagName = el.tagName.toLowerCase();
      const text = extractElementText(el);

      const itemIndex = nextIndex++;
      elementRegistry.set(itemIndex, el);

      // 创建并放置浮动角标
      const badge = document.createElement('div');
      badge.className = 'webauto-highlight-badge';
      badge.textContent = `${itemIndex}`;
      badge.style.left = `${Math.max(0, rect.left + window.scrollX)}px`;
      badge.style.top = `${Math.max(0, rect.top + window.scrollY)}px`;
      container.appendChild(badge);

      elementsData.push({
        index: itemIndex,
        tag: tagName,
        type: el.getAttribute('type') || '',
        text: text,
        role: el.getAttribute('role') || '',
        placeholder: el.getAttribute('placeholder') || '',
        href: el.getAttribute('href') || ''
      });
    }

    return {
      title: document.title,
      url: window.location.href,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      pageHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      elements: elementsData
    };
  }

  /**
   * 触发点击操作
   */
  async function performClick(index) {
    const el = elementRegistry.get(Number(index));
    if (!el) {
      throw new Error(`未找到编号为 [${index}] 的页面元素，请确认该元素是否依然在当前视图内`);
    }

    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    el.classList.add('webauto-highlight-active');
    
    await new Promise((r) => setTimeout(r, 200));

    // 派发原生指针与鼠标事件
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
    } catch (_) {}

    const mouseEvents = ['mouseover', 'mousedown', 'mouseup', 'click'];
    for (const eventName of mouseEvents) {
      el.dispatchEvent(
        new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window
        })
      );
    }

    try {
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
    } catch (_) {}

    if (typeof el.click === 'function') {
      el.click();
    }

    if (typeof el.focus === 'function') {
      el.focus();
    }

    await new Promise((r) => setTimeout(r, 300));
    return { success: true, message: `成功点击元素 [${index}]` };
  }

  /**
   * 触发文本输入操作（深度兼容 React/Vue 等响应式框架数据绑定）
   */
  async function performInput(index, text, pressEnter = false) {
    const el = elementRegistry.get(Number(index));
    if (!el) {
      throw new Error(`未找到编号为 [${index}] 的输入元素`);
    }

    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    el.classList.add('webauto-highlight-active');
    if (typeof el.focus === 'function') {
      el.focus();
    }

    await new Promise((r) => setTimeout(r, 150));

    // 针对响应式框架（React/Vue）触发 setter 代理拦截
    const isTextArea = el instanceof HTMLTextAreaElement;
    const isInput = el instanceof HTMLInputElement;

    if (isInput || isTextArea) {
      const proto = isTextArea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

      if (nativeSetter) {
        nativeSetter.call(el, text);
      } else {
        el.value = text;
      }
    } else if (el.isContentEditable) {
      el.textContent = text;
    } else {
      el.value = text;
    }

    // 触发事件通知框架状态更新
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

    // 回车键支持
    if (pressEnter) {
      await new Promise((r) => setTimeout(r, 100));
      const enterKeyEvents = ['keydown', 'keypress', 'keyup'];
      let enterPrevented = false;
      for (const ev of enterKeyEvents) {
        const keyEv = new KeyboardEvent(ev, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          charCode: 13,
          bubbles: true,
          cancelable: true
        });
        const dispatched = el.dispatchEvent(keyEv);
        if (!dispatched) enterPrevented = true;
      }

      // 若未被前端逻辑拦截且存在关联表单，则触发表单提交
      if (el.form && !enterPrevented) {
        el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    }

    return { success: true, message: `成功在元素 [${index}] 中输入内容: "${text}"` };
  }

  /**
   * 触发滚动操作
   */
  async function performScroll(direction = 'down', amount = 500) {
    const distance = direction === 'up' ? -Math.abs(amount) : Math.abs(amount);
    window.scrollBy({ top: distance, behavior: 'smooth' });
    await new Promise((r) => setTimeout(r, 400));
    return {
      success: true,
      message: `向${direction === 'up' ? '上' : '下'}滚动 ${amount} 像素`
    };
  }

  /**
   * 触发全局键盘按键
   */
  async function performKeyPress(key = 'Enter') {
    const target = document.activeElement || document.body;
    const events = ['keydown', 'keyup'];
    for (const ev of events) {
      target.dispatchEvent(
        new KeyboardEvent(ev, {
          key: key,
          code: key,
          bubbles: true,
          cancelable: true
        })
      );
    }
    return { success: true, message: `已触发键盘按键: ${key}` };
  }

  // 消息监听分发
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
      try {
        switch (request.action) {
          case 'PING':
            sendResponse({ status: 'PONG' });
            break;

          case 'SCAN':
            const scanResult = scanAndMarkElements();
            sendResponse({ success: true, data: scanResult });
            break;

          case 'CLICK':
            const clickRes = await performClick(request.index);
            sendResponse({ success: true, data: clickRes });
            break;

          case 'INPUT':
            const inputRes = await performInput(request.index, request.text, request.pressEnter);
            sendResponse({ success: true, data: inputRes });
            break;

          case 'SCROLL':
            const scrollRes = await performScroll(request.direction, request.amount);
            sendResponse({ success: true, data: scrollRes });
            break;

          case 'PRESS_KEY':
            const keyRes = await performKeyPress(request.key);
            sendResponse({ success: true, data: keyRes });
            break;

          case 'CLEAR_MARKERS':
            clearAllMarkers();
            sendResponse({ success: true });
            break;

          default:
            sendResponse({ success: false, error: `未知指令: ${request.action}` });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message || String(err) });
      }
    })();

    // 返回 true 支持异步响应
    return true;
  });
})();
