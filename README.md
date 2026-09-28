# WebAuto Agent - 浏览器智能自动化助手

WebAuto Agent 是一款基于 **Chrome Extension Manifest V3** 与 **OpenAI 兼容接口标准** 的现代化浏览器自动化扩展（Browser Agent Harness）。它将大语言模型的推理决策能力与真实的浏览器环境相结合，在当前登录会话中自主完成元素感知、推理决策、拟人交互与长流程任务编排。

---

## 架构特性与工程实现

1. **后台独立常驻引擎 (Background Service Worker Runner)**
   * 核心调度状态机与自动化执行循环全面下沉至后台 Service Worker，与侧边栏 UI 完全解耦。
   * 支持任务断线重连：在任务运行期间，用户即便关闭侧边栏或切换窗口，自动化流程依然在后台平稳推进，重新打开侧边栏即可即时恢复现场日志流。
   * 支持完整的任务暂停（Pause）、恢复（Resume）与强行终止（Stop）生命周期控制。

2. **高精度视口感知与 Set-of-Marks 视觉角标**
   * **深度 DOM 穿透**：递归穿透 open 模式的 Shadow DOM 与同源 iframe，识别现代前端自定义组件与微前端应用中的交互元素。
   * **真实视口可见性计算**：结合 `isClippedByOverflow` 检测父级滚动容器裁剪，并通过 `elementFromPoint` 采样中心与边缘点判定层级遮挡，过滤被弹窗与浮动遮罩挡住的无效元素。
   * **防脱节固定角标**：标注层采用固定视口层并在页面滚动与尺寸变化时通过 `requestAnimationFrame` 动态重贴合，杜绝角标错位与漂移。
   * **可选多模态增强 (Vision)**：支持在生成文本 DOM 列表的同时捕获视口实时截图并以 Base64 传递给支持多模态的大模型，形成真正的图文双重视觉感知闭环。

3. **双重事件派发体系与受控组件适配**
   * **CDP 物理级事件支持**：支持启用 Chrome DevTools Protocol (`chrome.debugger`) 派发系统级硬件输入事件（`isTrusted === true`），适配对安全性与真实用户事件有严格校验的站点。
   * **标准原生降级与富文本支持**：在未开启 CDP 时，自动通过标准的 `beforeinput`（`InputEvent`）、原型链 setter 描述符劫持及选区 API 模拟输入，适配 React/Vue 受控表单与现代富文本编辑器（如 Slate, Draft.js, Quill）。

4. **简约现代 Harness 交互界面**
   * **双色主题系统**：原生支持明亮（Light）与深色（Dark）主题平滑切换，默认跟随系统偏好并自动持久化。
   * **流式直接排版**：模型思考链（Reasoning）与回复正文采用直接输出流式排版，拒绝笨重的大外框；用户消息独立气泡框显，工具调用以结构化卡片（展示参数与执行结果反馈）框入时间流。
   * **置底自适应输入栏**：输入框固定置底，支持高度自适应扩展与快捷键操作（Enter 直接发送，Shift+Enter 换行）。

5. **全流程流式输出与防空转机制**
   * 基于 Server-Sent Events (SSE) 流式解析服务端数据，实时呈现模型的深度思考（Thinking/Reasoning）与执行动作。
   * 内置空转阻断保护：当模型未下发有效工具指令时，自动插入系统强化提示并重试，不扣减用户执行步数。

---

## 极速安装与使用指南

本项目采用原生零构建（Zero-Build）架构，无需运行编译命令即可直接运行：

### 1. 在 Chrome 中加载扩展
1. 打开 Chrome 浏览器，在地址栏输入：
   ```text
   chrome://extensions
   ```
2. 开启右上角的 **“开发者模式” (Developer mode)** 开关。
3. 点击左上角的 **“加载已解压的扩展程序” (Load unpacked)**。
4. 在文件选择器中选中本项目根目录：
   ```text
   d:\Projects\WebPilot
   ```
5. 加载完成后，浏览器工具栏将出现 **WebAuto** 图标。

### 2. 配置与启动自动化
1. 在浏览器右上角的扩展列表中，将 **WebAuto** 固定到工具栏。
2. 打开需要执行自动化操作的网页（如知乎、GitHub、管理后台等）。
3. 点击扩展图标唤出常驻侧边栏。
4. 点击顶栏右上角设置图标展开配置抽屉：
   * 选择模型服务商（预设支持 DeepSeek、OpenAI、SiliconFlow、Ollama 或自定义代理）。
   * 填写相应的 **API Key** 与模型名称。
   * 根据需求勾选“启用视口截图多模态辅助”或“启用 CDP 硬件真实事件输入”。
   * 点击 **保存设置**。
5. 在底部输入栏中输入任务目标（如：“在搜索框中输入关键字并点击搜索”），按回车或点击发送按钮即可启动任务。

---

## 项目工程结构

```text
d:\Projects\WebPilot\
├── manifest.json              # Chrome Extension Manifest V3 配置文件
├── icons/                     # 扩展 16/48/128 图标资源
├── background/
│   ├── service-worker.js      # 后台服务常驻线程（长连接会话与单例生命周期管理）
│   └── agent-runner.js        # 自动化引擎调度核心（感知、推理、执行、状态校验与暂停恢复）
├── sidepanel/
│   ├── index.html             # 简约 Harness 侧边栏界面结构
│   ├── style.css              # 明暗主题、Harness 消息流与动效样式
│   └── sidepanel.js           # 侧边栏交互逻辑、主题切换与后台通信控制器
├── content/
│   ├── content-script.js      # 页面注入脚本（单例防重、ShadowDOM 穿透、遮挡判定与输入模拟）
│   └── overlay.css            # 固定视口高亮标注层样式
└── lib/
    └── openai.js              # OpenAI 规范客户端（流式 SSE、思考链解析与多模态组装）
```

---

## 自动化工具定义 (Tool Calling Schema)

| 工具名称 | 关键参数 | 功能说明 |
| :--- | :--- | :--- |
| `click_element` | `index: number` | 点击对应编号的按钮、链接或交互元素，支持同步 CDP 物理点击 |
| `input_text` | `index: number, text: string, press_enter?: boolean` | 在目标输入框中填写文本，并可选择是否自动提交回车 |
| `scroll_page` | `direction: "up" \| "down", amount?: number` | 控制页面视口上下平滑滚动以感知更多内容 |
| `navigate_to` | `url: string` | 跳转至指定 HTTP/HTTPS 网址并等待页面就绪 |
| `wait_seconds` | `seconds: number` | 等待动态页面数据加载 |
| `finish_task` | `summary: string` | 任务目标达成时由模型主动调用，输出完整结果总结 |
