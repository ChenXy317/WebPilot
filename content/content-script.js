/**
 * 网页内容感知与动作模拟执行脚本
 * 负责 DOM 结构扫描、穿透 Shadow DOM、真实视口遮挡判定、角标渲染及拟人化操作模拟
 */

(() => {
  // 单例防重复注入守卫，防止多次注入导致消息监听器重复注册
  if (window.__WEBAUTO_CONTENT_SCRIPT_INITIALIZED__) {
    return;
  }
  window.__WEBAUTO_CONTENT_SCRIPT_INITIALIZED__ = true;

  // 维护当前活跃的元素与角标映射
  let elementRegistry = new Map();
  let refRegistry = new Map();
  let markersContainer = null;
  let activeScrollListener = null;

  /**
   * 初始化固定视口角标容器
   */
  function ensureMarkerContainer() {
    if (!markersContainer || !document.contains(markersContainer)) {
      markersContainer = document.getElementById('webauto-markers-container');
      if (!markersContainer) {
        markersContainer = document.createElement('div');
        markersContainer.id = 'webauto-markers-container';
        (document.fullscreenElement || document.body || document.documentElement).appendChild(markersContainer);
      }
    }
    return markersContainer;
  }

  /**
   * 清除所有角标与高亮状态
   */
  function clearAllMarkers() {
    if (markersContainer && markersContainer.parentNode) {
      markersContainer.innerHTML = '';
    }
    document.querySelectorAll('.webauto-highlight-active').forEach((el) => {
      el.classList.remove('webauto-highlight-active');
    });
    elementRegistry.clear();
    refRegistry.clear();

    if (activeScrollListener) {
      window.removeEventListener('scroll', activeScrollListener, true);
      window.removeEventListener('resize', activeScrollListener, true);
      activeScrollListener = null;
    }
  }

  /**
   * 判断元素是否被祖先滚动容器裁剪隐藏
   */
  function isClippedByOverflow(el, rect) {
    let parent = el.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const style = window.getComputedStyle(parent);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const isScrollable = (
        overflowY === 'hidden' || overflowY === 'auto' || overflowY === 'scroll' ||
        overflowX === 'hidden' || overflowX === 'auto' || overflowX === 'scroll'
      );

      if (isScrollable) {
        const parentRect = parent.getBoundingClientRect();
        if (
          rect.bottom < parentRect.top ||
          rect.top > parentRect.bottom ||
          rect.right < parentRect.left ||
          rect.left > parentRect.right
        ) {
          return true;
        }
      }
      parent = parent.parentElement;
    }
    return false;
  }

  /**
   * 严格检测元素在当前视口中的可见性与遮挡状态
   */
  function isElementVisible(el) {
    if (!el || !(el instanceof Element)) return false;

    // 基础样式检测
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      parseFloat(style.opacity || '1') <= 0.05 ||
      el.hasAttribute('hidden') ||
      el.getAttribute('aria-hidden') === 'true'
    ) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

    // 视口相交判定
    const inViewport = (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < viewportHeight &&
      rect.left < viewportWidth
    );
    if (!inViewport) return false;

    // 检查祖先滚动容器裁剪
    if (isClippedByOverflow(el, rect)) return false;

    // 真实层级遮挡判定（采样中心点与边界点检测是否被遮罩或浮层阻挡）
    const sampleX = Math.min(Math.max(rect.left + rect.width / 2, 0), viewportWidth - 1);
    const sampleY = Math.min(Math.max(rect.top + rect.height / 2, 0), viewportHeight - 1);

    const hitEl = document.elementFromPoint(sampleX, sampleY);
    if (hitEl && !el.contains(hitEl) && !hitEl.contains(el)) {
      // 若采样的中心点被非自身及子孙元素遮挡，再采样四角作为后备
      const corners = [
        [rect.left + 2, rect.top + 2],
        [rect.right - 2, rect.top + 2],
        [rect.left + 2, rect.bottom - 2],
        [rect.right - 2, rect.bottom - 2]
      ];
      let visibleCorner = false;
      for (const [cx, cy] of corners) {
        if (cx >= 0 && cx < viewportWidth && cy >= 0 && cy < viewportHeight) {
          const cornerHit = document.elementFromPoint(cx, cy);
          if (cornerHit && (el.contains(cornerHit) || cornerHit.contains(el))) {
            visibleCorner = true;
            break;
          }
        }
      }
      if (!visibleCorner) return false;
    }

    return true;
  }

  /**
   * 递归遍历包括 Shadow DOM 在内的所有子节点
   */
  function collectAllElements(root = document, results = new Set()) {
    const walker = document.createTreeWalker(
      root instanceof Document ? root.body || root.documentElement : root,
      NodeFilter.SHOW_ELEMENT,
      null
    );

    let currentNode = walker.currentNode;
    while (currentNode) {
      if (currentNode instanceof Element) {
        results.add(currentNode);

        // 穿透 open 模式的 Shadow DOM
        if (currentNode.shadowRoot) {
          collectAllElements(currentNode.shadowRoot, results);
        }
      }
      currentNode = walker.nextNode();
    }

    // 穿透同源 iframe
    const iframes = (root.querySelectorAll ? root.querySelectorAll('iframe') : []);
    for (const iframe of iframes) {
      try {
        if (iframe.contentDocument) {
          collectAllElements(iframe.contentDocument, results);
        }
      } catch (_) {}
    }

    return results;
  }

  /**
   * 提取元素的可读语义文本
   */
  function extractElementText(el) {
    const tagName = el.tagName.toLowerCase();

    if (tagName === 'input' || tagName === 'textarea') {
      const inputEl = el;
      return inputEl.placeholder || inputEl.value || inputEl.getAttribute('aria-label') || '';
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();

    const alt = el.getAttribute('alt') || el.querySelector('img')?.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();

    const text = el.innerText || el.textContent || '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  /**
   * 生成元素的稳定语义指纹引用
   */
  function computeElementRef(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id.trim()}` : '';
    const role = el.getAttribute('role') || '';
    const name = el.getAttribute('name') || '';
    const type = el.getAttribute('type') || '';
    const textSample = (extractElementText(el) || '').slice(0, 15).replace(/\s+/g, '_');
    const rawSig = `${tag}${id}${role ? `[role=${role}]` : ''}${name ? `[name=${name}]` : ''}${type ? `[type=${type}]` : ''}:${textSample}`;
    let hash = 5381;
    for (let i = 0; i < rawSig.length; i++) {
      hash = ((hash << 5) + hash) + rawSig.charCodeAt(i);
      hash |= 0;
    }
    const hexHash = Math.abs(hash).toString(16).slice(0, 6);
    return `${tag}_${hexHash}`;
  }

  /**
   * 优先通过稳定语义指纹检索目标元素，并以编号作为辅助降级
   */
  function findRegisteredElement(index, ref) {
    if (ref && refRegistry.has(ref)) {
      const entry = refRegistry.get(ref);
      if (document.contains(entry.element)) {
        return entry;
      }
    }

    if (ref) {
      const allCandidates = collectAllElements(document);
      for (const el of allCandidates) {
        if (computeElementRef(el) === ref && isElementVisible(el)) {
          return { element: el, ref };
        }
      }
    }

    if (typeof index !== 'undefined' && index !== null && elementRegistry.has(Number(index))) {
      const entry = elementRegistry.get(Number(index));
      if (document.contains(entry.element)) {
        return entry;
      }
    }
    return null;
  }

  /**
   * 观察动作执行后的目标局部上下文与关键属性变动
   */
  async function observeActionResult(targetEl, actionFn) {
    const beforeUrl = window.location.href;
    const beforeTitle = document.title;

    const proximityContainer = targetEl.closest(
      'form, dialog, [role="dialog"], [role="menu"], [role="listbox"], .dropdown, .modal, details'
    ) || targetEl.parentElement || targetEl;

    const beforeAria = targetEl.getAttribute('aria-expanded');
    const beforeOpen = targetEl.hasAttribute('open');
    const beforeClass = targetEl.className;
    const beforeValue = ('value' in targetEl ? targetEl.value : null);
    const beforeModals = document.querySelectorAll('dialog[open], [role="dialog"]:not([aria-hidden="true"]), .modal.show, .modal.active').length;

    let localMutationCount = 0;
    const observer = new MutationObserver((mutations) => {
      localMutationCount += mutations.length;
    });

    try {
      observer.observe(proximityContainer, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    } catch (_) {}

    const actionOutput = await actionFn();

    // 等待渲染或微任务完成
    await new Promise((r) => setTimeout(r, 350));
    observer.disconnect();

    const afterUrl = window.location.href;
    const afterTitle = document.title;
    const afterAria = targetEl.getAttribute('aria-expanded');
    const afterOpen = targetEl.hasAttribute('open');
    const afterClass = targetEl.className;
    const afterValue = ('value' in targetEl ? targetEl.value : null);
    const afterModals = document.querySelectorAll('dialog[open], [role="dialog"]:not([aria-hidden="true"]), .modal.show, .modal.active').length;

    const details = [];

    if (afterUrl !== beforeUrl) {
      details.push(`页面跳转至: ${afterUrl}`);
    }
    if (afterTitle !== beforeTitle) {
      details.push(`标题更新为: "${afterTitle}"`);
    }
    if (beforeAria !== afterAria) {
      details.push(`状态更新为 aria-expanded="${afterAria}"`);
    }
    if (beforeOpen !== afterOpen) {
      details.push(`开启状态更新为 open=${afterOpen}`);
    }
    if (afterModals > beforeModals) {
      details.push('检测到新弹窗/对话框出现');
    }
    if (beforeValue !== null && afterValue !== beforeValue) {
      details.push(`输入值更新为: "${afterValue}"`);
    }
    if (beforeClass !== afterClass && details.length === 0) {
      details.push('元素样式类名发生更新');
    }
    if (localMutationCount > 0 && details.length === 0) {
      details.push(`目标局部区域更新 (${localMutationCount} 处)`);
    }

    const hasChanged = details.length > 0;
    return {
      ...actionOutput,
      hasMutations: hasChanged,
      statusSummary: hasChanged ? details.join('；') : '未检测到目标区域状态或页面发生变化'
    };
  }

  /**
   * 同步更新已存在角标的视口坐标，防止滚动漂移
   */
  function updateBadgePositions() {
    for (const [index, { element, badge }] of elementRegistry.entries()) {
      if (!document.contains(element)) {
        badge.style.display = 'none';
        continue;
      }
      const rect = element.getBoundingClientRect();
      const inView = (
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
      if (inView) {
        badge.style.display = 'block';
        badge.style.left = `${Math.round(rect.left)}px`;
        badge.style.top = `${Math.round(rect.top)}px`;
      } else {
        badge.style.display = 'none';
      }
    }
  }

  /**
   * 扫描全页面并打上视口高对比度角标
   */
  function scanAndMarkElements() {
    clearAllMarkers();
    const container = ensureMarkerContainer();

    const allNodes = collectAllElements(document);
    const candidateSet = new Set();

    const interactiveSelectors = [
      'a[href]',
      'button',
      'input',
      'select',
      'textarea',
      '[role="button"]',
      '[role="link"]',
      '[role="textbox"]',
      '[role="searchbox"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="combobox"]',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])',
      '[onclick]'
    ];

    for (const node of allNodes) {
      if (container.contains(node)) continue;

      let isCandidate = false;
      for (const sel of interactiveSelectors) {
        if (node.matches && node.matches(sel)) {
          isCandidate = true;
          break;
        }
      }

      if (!isCandidate) {
        const style = window.getComputedStyle(node);
        if (style.cursor === 'pointer') {
          // 避免包含在父级可点击元素内的冗余子元素
          if (!node.closest('button, a, select, textarea, [role="button"]')) {
            isCandidate = true;
          }
        }
      }

      if (isCandidate && isElementVisible(node)) {
        candidateSet.add(node);
      }

      if (candidateSet.size >= 300) break;
    }

    let nextIndex = 1;
    const elementsData = [];

    for (const el of candidateSet) {
      const rect = el.getBoundingClientRect();
      const tagName = el.tagName.toLowerCase();
      const text = extractElementText(el);

      const itemIndex = nextIndex++;
      const itemRef = computeElementRef(el);

      // 创建固定视口浮动角标
      const badge = document.createElement('div');
      badge.className = 'webauto-highlight-badge';
      badge.textContent = `${itemIndex}`;
      badge.style.left = `${Math.round(rect.left)}px`;
      badge.style.top = `${Math.round(rect.top)}px`;
      container.appendChild(badge);

      // 计算元素视口中心坐标（供 CDP 硬件级事件或视口定位）
      const centerX = Math.round(rect.left + rect.width / 2);
      const centerY = Math.round(rect.top + rect.height / 2);

      const registryItem = {
        element: el,
        badge: badge,
        centerX: centerX,
        centerY: centerY,
        ref: itemRef
      };

      elementRegistry.set(itemIndex, registryItem);
      refRegistry.set(itemRef, registryItem);

      elementsData.push({
        index: itemIndex,
        ref: itemRef,
        tag: tagName,
        type: el.getAttribute('type') || '',
        text: text,
        role: el.getAttribute('role') || '',
        placeholder: el.getAttribute('placeholder') || '',
        href: el.getAttribute('href') || '',
        center: { x: centerX, y: centerY }
      });
    }

    // 绑定视口滚动与尺寸监听以保持角标贴合
    activeScrollListener = () => {
      requestAnimationFrame(updateBadgePositions);
    };
    window.addEventListener('scroll', activeScrollListener, { passive: true, capture: true });
    window.addEventListener('resize', activeScrollListener, { passive: true });

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
   * 执行拟人化点击操作
   */
  async function performClick(index, ref, skipDomClick = false) {
    const entry = findRegisteredElement(index, ref);
    if (!entry || !entry.element) {
      throw new Error(`未找到编号为 [${index}] (ref: ${ref || '无'}) 的元素，请确认该元素是否依然在当前视图内`);
    }

    const el = entry.element;
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    el.classList.add('webauto-highlight-active');
    await new Promise((r) => setTimeout(r, 150));

    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    if (skipDomClick) {
      if (typeof el.focus === 'function') {
        el.focus();
      }
      return {
        success: true,
        message: `已聚焦元素 [${index}] 并计算物理中心坐标`,
        center: { x: Math.round(cx), y: Math.round(cy) }
      };
    }

    return await observeActionResult(el, async () => {
      const eventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: cx,
        clientY: cy
      };

      try {
        el.dispatchEvent(new PointerEvent('pointerover', eventInit));
        el.dispatchEvent(new PointerEvent('pointerenter', eventInit));
        el.dispatchEvent(new PointerEvent('pointerdown', eventInit));
      } catch (_) {}

      el.dispatchEvent(new MouseEvent('mouseover', eventInit));
      el.dispatchEvent(new MouseEvent('mousedown', eventInit));

      if (typeof el.focus === 'function') {
        el.focus();
      }

      try {
        el.dispatchEvent(new PointerEvent('pointerup', eventInit));
      } catch (_) {}

      el.dispatchEvent(new MouseEvent('mouseup', eventInit));
      el.dispatchEvent(new MouseEvent('click', eventInit));

      if (typeof el.click === 'function') {
        el.click();
      }

      await new Promise((r) => setTimeout(r, 100));
      return {
        success: true,
        message: `已点击元素 [${index}]`,
        center: { x: Math.round(cx), y: Math.round(cy) }
      };
    });
  }

  /**
   * 执行文本输入操作（深度兼容 React/Vue 受控组件及 contenteditable 现代富文本）
   */
  async function performInput(index, text, pressEnter = false, ref = null) {
    const entry = findRegisteredElement(index, ref);
    if (!entry || !entry.element) {
      throw new Error(`未找到编号为 [${index}] (ref: ${ref || '无'}) 的输入元素`);
    }

    const el = entry.element;
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    el.classList.add('webauto-highlight-active');

    if (typeof el.focus === 'function') {
      el.focus();
    }
    await new Promise((r) => setTimeout(r, 100));

    return await observeActionResult(el, async () => {
      const isTextArea = el instanceof HTMLTextAreaElement;
      const isInput = el instanceof HTMLInputElement;
      const isContentEditable = el.isContentEditable || el.getAttribute('contenteditable') === 'true';

      if (isInput || isTextArea) {
        try {
          el.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: text
          }));
        } catch (_) {}

        const proto = isTextArea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, text);
        } else {
          el.value = text;
        }

        try {
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: text
          }));
        } catch (_) {
          el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

      } else if (isContentEditable) {
        try {
          el.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: text
          }));
        } catch (_) {}

        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
        } else {
          el.textContent = text;
        }

        try {
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: text
          }));
        } catch (_) {
          el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        }
      } else {
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      }

      if (pressEnter) {
        await new Promise((r) => setTimeout(r, 100));
        const enterEvents = ['keydown', 'keypress', 'keyup'];
        let enterPrevented = false;
        for (const ev of enterEvents) {
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

        if (el.form && !enterPrevented) {
          el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      }

      return {
        success: true,
        message: `已在元素 [${index}] 中输入文本`
      };
    });
  }

  /**
   * 提取页面主要结构化文本正文，主动过滤导航栏与周边噪声
   */
  function extractPageContent(selector, maxLength = 4000) {
    const noiseSelectors = [
      'header', 'footer', 'nav', 'aside',
      '.header', '.footer', '.nav', '.navbar', '.navigation', '.sidebar',
      '.menu', '.breadcrumb', '.toolbar', '.advertisement', '.ad',
      '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
      '[role="complementary"]', 'script', 'style', 'noscript', 'svg',
      'iframe', '#webauto-markers-container', '.webauto-highlight-badge'
    ];

    if (selector) {
      const target = document.querySelector(selector);
      if (!target) {
        throw new Error(`未匹配到指定选择器的页面元素: ${selector}`);
      }
      const clone = target.cloneNode(true);
      for (const sel of noiseSelectors) {
        clone.querySelectorAll(sel).forEach((n) => n.remove());
      }
      const text = (clone.innerText || clone.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
      return {
        title: document.title,
        url: window.location.href,
        content: text.slice(0, maxLength),
        totalLength: text.length
      };
    }

    const candidateSelectors = [
      'article', 'main', '[role="main"]', '.post-content', '.article-content',
      '.article-body', '.entry-content', '.main-content', '#content', '#main'
    ];

    let bestContainer = null;
    let maxTextLen = 0;

    for (const sel of candidateSelectors) {
      const matches = document.querySelectorAll(sel);
      for (const el of matches) {
        const testClone = el.cloneNode(true);
        for (const noise of noiseSelectors) {
          testClone.querySelectorAll(noise).forEach((n) => n.remove());
        }
        const len = (testClone.innerText || testClone.textContent || '').trim().length;
        if (len > maxTextLen && len > 80) {
          maxTextLen = len;
          bestContainer = testClone;
        }
      }
    }

    const container = bestContainer || document.body.cloneNode(true);
    if (!bestContainer) {
      for (const sel of noiseSelectors) {
        container.querySelectorAll(sel).forEach((n) => n.remove());
      }
    }

    const rawText = (container.innerText || container.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    return {
      title: document.title,
      url: window.location.href,
      content: rawText.slice(0, maxLength),
      totalLength: rawText.length
    };
  }

  /**
   * 执行平滑滚动操作
   */
  async function performScroll(direction = 'down', amount = 600) {
    const distance = direction === 'up' ? -Math.abs(amount) : Math.abs(amount);
    window.scrollBy({ top: distance, behavior: 'smooth' });
    await new Promise((r) => setTimeout(r, 350));
    return {
      success: true,
      message: `向${direction === 'up' ? '上' : '下'}滚动 ${amount} 像素`
    };
  }

  /**
   * 消息监听与指令分发
   */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
      try {
        switch (request.action) {
          case 'PING':
            sendResponse({ status: 'PONG' });
            break;

          case 'SCAN':
            const scanData = scanAndMarkElements();
            sendResponse({ success: true, data: scanData });
            break;

          case 'CLICK':
            const clickRes = await performClick(request.index, request.ref, Boolean(request.skipDomClick));
            sendResponse({ success: true, data: clickRes });
            break;

          case 'INPUT':
            const inputRes = await performInput(request.index, request.text, request.pressEnter, request.ref);
            sendResponse({ success: true, data: inputRes });
            break;

          case 'EXTRACT_CONTENT':
            const contentRes = extractPageContent(request.selector, request.maxLength);
            sendResponse({ success: true, data: contentRes });
            break;

          case 'SCROLL':
            const scrollRes = await performScroll(request.direction, request.amount);
            sendResponse({ success: true, data: scrollRes });
            break;

          case 'CLEAR_MARKERS':
            clearAllMarkers();
            sendResponse({ success: true });
            break;

          default:
            sendResponse({ success: false, error: `未知操作指令: ${request.action}` });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message || String(err) });
      }
    })();

    return true;
  });
})();
