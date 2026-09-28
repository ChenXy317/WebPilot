# WebAuto Agent - 浏览器智能自动化助手

一款基于 **OpenAI 兼容接口规范** 的 Chrome 自动化扩展程序（Browser AI Agent）。
它将大模型的推理决策与浏览器内部原生 DOM 深度结合，在用户日常浏览的真实网页环境中自主完成**元素识别、点击、文本输入、滚动浏览与流程编排**。

---

## 🌟 核心特性与工程优势

1. **原生扩展驱动（无需 Playwright / Python 复杂依赖）**
   * 直接运行在用户真实的 Chrome 浏览器内部。
   * **完美复用当前登录态**：知乎、GitHub、淘宝、企业内网系统等无需重新扫码或导出 Cookie，直接以当前账号身份自动化操作。
   * **天然反爬虫防御**：使用真实浏览器的环境指纹与网络上下文，避免被识别为无头机器人。

2. **标准化 OpenAI 接口兼容**
   * 支持通过标准 `tools` (Function Calling) 驱动决策。
   * 原生内置服务商预设：
     * **DeepSeek 官方**（超高性价比推荐）
     * **OpenAI 官方**（GPT-4o / GPT-4o-mini）
     * **硅基流动 (SiliconFlow)**（Qwen2.5 / DeepSeek 等开源大模型）
     * **Ollama 本地大模型**（无需联网，隐私优先）
     * **自定义 API 代理 / 中转站**

3. **智能闭环感知系统（Set-of-Marks 视觉角标）**
   * 自动遍历当前视口内可见的可交互元素（按钮、链接、输入框、下拉框等）。
   * 实时为元素叠加高对比度数字方括号角标（如 `[1]`, `[2]`），便于模型精确指向，杜绝误触。

4. **深度兼容现代前端响应式框架**
   * 针对 React、Vue、Angular 的受控组件，通过重写原生原型链属性描述符派发合成事件，确保输入内容能够 100% 触发前端状态更新与表单提交。

5. **常驻 Side Panel（侧边栏）沉浸式交互**
   * 不会因为网页切换或失焦而中断关闭。
   * 实时展示模型**思考链路（Chain of Thought）**、**执行动作参数**及**每一步的耗时与状态**。

---

## 🚀 极速安装与使用指南

整个插件采用零编译（Zero-Build）架构，无需运行 `npm build`，即下即用：

### 第一步：在 Chrome 中加载插件
1. 打开 Chrome 浏览器，在地址栏输入并回车：
   ```text
   chrome://extensions
   ```
2. 在页面右上角打开 **“开发者模式” (Developer mode)** 开关。
3. 点击左上角出现的 **“加载已解压的扩展程序” (Load unpacked)** 按钮。
4. 在弹出的文件选择器中，选中本项目根目录：
   ```text
   d:\Projects\Web
   ```
5. 加载完成后，工具栏中将出现 **WebAuto Agent** 图标。

---

### 第二步：配置 API 与启动任务
1. 在浏览器右上角的扩展程序列表中，点击固定（Pin）**WebAuto Agent**。
2. 打开任意你想要操作的网页（例如百度、知乎、GitHub 等）。
3. 点击插件图标，浏览器右侧将滑出 **WebAuto Agent 侧边栏**。
4. 点击侧边栏右上角的 **⚙️ (设置)** 图标：
   * 选择你使用的服务商（如 DeepSeek）。
   * 填入你的 **API Key**（如 `sk-...`）。
   * 点击 **“保存配置”**。
5. 在输入框中输入你想要执行的任务，例如：
   * *“在当前搜索框中输入 Python 并点击搜索”*
   * *“向下滚动浏览页面，找到关于我们并点击”*
6. 点击 **🚀 开始执行**，即可实时观看 Agent 自动分析与操作网页！

---

## 🛠️ 项目目录结构

```text
d:\Projects\Web\
├── manifest.json              # Chrome Manifest V3 扩展配置文件
├── icons/                     # 插件各分辨率图标资源 (16x16, 48x48, 128x128)
├── background/
│   └── service-worker.js      # 扩展后台服务（负责侧边栏呼出与扩展生命周期）
├── sidepanel/
│   ├── index.html             # 侧边栏控制面板主结构
│   ├── style.css              # 现代科技感深色主题样式与时间轴
│   ├── sidepanel.js           # 侧边栏交互逻辑与配置持久化
│   └── agent.js               # 核心控制闭环（感知 -> 推理 -> 执行 -> 验证）
├── content/
│   ├── content-script.js      # 网页注入脚本（DOM 遍历提取、角标标注与动作模拟）
│   └── overlay.css            # 网页角标高亮样式
└── lib/
    └── openai.js              # OpenAI 兼容客户端与自动化工具集定义 (Function Calling)
```

---

## 📋 自动化工具定义 (Function Calling Schema)

Agent 支持下发以下标准工具与网页交互：

| 工具名称 | 关键参数 | 功能说明 |
| :--- | :--- | :--- |
| `click_element` | `index: number` | 点击对应编号的按钮、链接或交互元素 |
| `input_text` | `index: number, text: string, press_enter?: boolean` | 在输入框中填写文本，并可选择是否自动回车提交 |
| `scroll_page` | `direction: "up" \| "down", amount?: number` | 控制页面上下平滑滚动以获取视口外的内容 |
| `navigate_to` | `url: string` | 跳转至指定网址并等待加载完成 |
| `wait_seconds` | `seconds: number` | 等待动态渲染或数据加载 |
| `finish_task` | `summary: string` | 任务成功完成，输出执行结果总结 |
