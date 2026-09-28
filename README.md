# WebAuto (WebPilot) - 浏览器智能自动化助手

WebAuto 是一款基于 **Chrome Extension Manifest V3** 与 **OpenAI 兼容接口标准** 开发的网页自动化操作扩展。通过连接大语言模型的推理与工具调用（Tool Calling）能力，在用户真实的浏览器登录环境中，自主完成网页元素识别、文本提取、表单输入、点击交互与多步骤流程执行。

---

## 核心工作原理

```
[侧边栏 UI] <--(chrome.runtime Port 长连接)--> [后台 Service Worker 调度器]
                                                      │
                       ┌──────────────────────────────┴──────────────────────────────┐
                       ▼                                                             ▼
              [兼容 OpenAI 接口大模型]                                       [目标网页 Content Script]
        (流式思考、推理决策、工具下发)                                  (视口扫描、角标标注、动作执行、差分反馈)
```

1. **页面感知**：调度引擎向目标网页发送扫描指令，遍历可见 DOM 树（包含 open 模式 Shadow DOM 与同源 iframe），剔除外层冗余容器后为可交互元素生成唯一数字编号 `[n]` 与稳定语义哈希引用 `ref`。
2. **决策推理**：调度器组装当前页面的标题、URL、视口位置以及候选元素列表（可选附加当帧视口截图），流式请求大模型决定下一步执行动作。
3. **动作执行与校验**：通过原生 DOM 模拟事件或 CDP 硬件级事件触发点击/输入，并在动作执行后观测目标近邻区域的属性更新（如 `aria-expanded`、弹窗增量、输入框实际值及页面跳转），将真实状态反馈给模型。
4. **结果总结**：循环执行直至任务目标达成（模型调用 `finish_task` 输出总结答复），或达到用户设定的步数上限。

---

## 主要技术特性

* **稳定语义指纹引用 (ref)**：为每个交互节点生成基于标签、ID、Role、文本及属性特征的稳定哈希，避免动态页面重渲染或滚动排号漂移导致的误操作。
* **双轨事件派发体系**：
  * **标准原生模拟**：通过 `beforeinput`、原型链 setter 劫持及选区 API 模拟输入，适配 React/Vue 受控组件与现代富文本编辑器；
  * **CDP 物理硬件事件**：支持启用 Chrome DevTools Protocol (`chrome.debugger`) 派发系统级硬件输入事件（`isTrusted === true`），适配严格校验真实鼠标事件的站点。
* **正文提取工具 (`read_page_content`)**：内置免打扰内容提取器，自动剥离全站导航栏、页眉页脚、侧边栏及广告噪声，支持在无需大量视口截图的情况下高效提取页面正文。
* **后台保活与断点恢复**：通过 `chrome.alarms` 定时心跳减少 Service Worker 空闲挂起概率，同时将关键调度状态实时序列化保存至本地存储，支持意外中断后的自动恢复。
* **视觉多模态与历史帧清理**：支持视口截屏辅助推理，并在每轮循环中自动将历史多模态截图降级为文本占位符，避免 Base64 图片堆叠导致上下文膨胀和 Token 浪费。
* **纯原生零构建 (Zero-Build)**：项目采用原生 ES Modules 开发，无需 Webpack、Vite 或 npm 编译打包，直接解压即可在浏览器中加载运行。

---

## 安装与快速上手

### 1. 加载扩展程序
1. 打开 Chrome 浏览器，在地址栏输入并回车：
   ```text
   chrome://extensions
   ```
2. 打开页面右上角的 **“开发者模式” (Developer mode)** 开关。
3. 点击左上角的 **“加载已解压的扩展程序” (Load unpacked)**。
4. 在弹出的文件选择器中，选中本项目根目录：
   ```text
   d:\Projects\WebPilot
   ```
5. 加载完成后，浏览器工具栏将出现 **WebAuto** 图标。

### 2. 配置与开始使用
1. 在浏览器右上角的扩展列表中，建议将 **WebAuto** 固定到工具栏。
2. 打开任意需要执行操作的网页（如商品页面、搜索网站、管理后台等）。
3. 点击工具栏图标展开右侧常驻侧边栏。
4. 点击侧边栏顶部的 **设置** 图标展开配置抽屉：
   * **服务商预设**：支持快速选择 DeepSeek、OpenAI、硅基流动 (SiliconFlow)、Ollama（本地运行）或自定义接口；
   * **API Base URL & Key**：填写您的大模型服务地址与 API 密钥；
   * **模型名称**：填写支持 Function Calling 的模型（如 `deepseek-chat`、`gpt-4o`、`qwen2.5:latest` 等）；
   * **功能选项**：根据需要勾选“启用视口截图多模态辅助”或“启用 CDP 硬件真实事件输入”；
   * 点击 **保存设置**。
5. 在底部输入栏输入您的具体目标（如：“搜索人工智能最新新闻并总结前两篇文章的主要内容”），按回车即可启动自动化执行。

---

## 自动化工具定义 (Tool Schema)

| 工具名称 | 关键参数 | 功能说明 |
| :--- | :--- | :--- |
| `click_element` | `ref: string, index?: number` | 点击具有指定稳定语义指纹引用 (`ref`) 的元素，CDP 模式下派发硬件级物理点击 |
| `input_text` | `ref: string, text: string, press_enter?: boolean, index?: number` | 在指定输入框中键入文本，支持回车触发表单提交 |
| `read_page_content` | `selector?: string, max_length?: number` | 提取当前页面或指定 CSS 容器的纯文本正文，自动过滤顶栏、导航与页脚广告 |
| `scroll_page` | `direction: "up" \| "down", amount?: number` | 平滑上下滚动当前视口，以便感知更多页面内容 |
| `navigate_to` | `url: string` | 跳转至指定的 HTTP/HTTPS 目标网址并等待页面就绪 |
| `wait_seconds` | `seconds: number` | 等待指定秒数（1~8秒），便于异步加载或动画渲染完成 |
| `finish_task` | `summary: string` | 任务达成时由模型主动调用，输出完整的过程与结果汇报 |

---

## 工程文件结构

```text
d:\Projects\WebPilot\
├── manifest.json              # Chrome Extension MV3 配置文件
├── icons/                     # 扩展图标 (16/48/128)
├── background/
│   ├── service-worker.js      # 后台服务常驻线程（长连接会话、心跳保活与状态自愈恢复）
│   └── agent-runner.js        # 自动化调度状态机（感知、推理、动作执行与上下文管理）
├── sidepanel/
│   ├── index.html             # 侧边栏界面结构
│   ├── style.css              # 明暗主题、消息气泡与工具卡片排版样式
│   └── sidepanel.js           # 侧边栏通信、主题持久化与流式内容渲染
├── content/
│   ├── content-script.js      # 页面注入脚本（DOM 遍历、语义指纹生成、真实属性差分与输入模拟）
│   └── overlay.css            # 固定视口数字角标样式（Set-of-Marks）
└── lib/
    └── openai.js              # 兼容 OpenAI 规范的客户端（SSE 流式思考链解析与多模态组装）
```

---

## 局限性与使用须知

1. **受限页面**：受 Chrome 安全策略限制，扩展无法向浏览器内置页面（如 `chrome://`、`chrome-extension://`）注入脚本执行操作。
2. **跨域 iframe**：受同源策略（Same-Origin Policy）限制，页面内嵌入的跨域第三方 iframe 无法直接穿透读取其内部 DOM。
3. **Canvas / WebGL**：纯 Canvas 或 WebGL 绘制的无障碍元素（非原生 DOM 节点）无法被文本扫描器识别，此类界面建议开启多模态（Vision）配合使用。
4. **模型要求**：自动化执行的准确率依赖大模型的指令遵循与工具调用能力，推荐使用推理能力较强、支持 Function Call 的主流模型。
5. **API 与网络开销**：视口截图为多模态功能，开启时单步 Token 消耗高于纯文本模式；请注意合理控制最大执行步数。
6. **本地安全**：API Key 等配置直接存储在浏览器的本地存储（`chrome.storage.local`）中，不会上传至第三方服务器。
