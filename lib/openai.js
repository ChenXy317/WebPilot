/**
 * OpenAI 规范 API 客户端
 * 支持标准 OpenAI 格式、DeepSeek、SiliconFlow、Ollama 等服务商的流式输出、视觉多模态及工具调用
 */

export class OpenAIClient {
  /**
   * 初始化 API 客户端
   * @param {Object} config - 配置参数
   * @param {string} config.baseUrl - API 基础地址
   * @param {string} config.apiKey - 认证密钥
   * @param {string} config.model - 模型名称
   * @param {number} [config.temperature=0.2] - 采样温度
   */
  constructor({ baseUrl, apiKey, model, temperature = 0.2 }) {
    this.baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.model = model || 'gpt-4o';
    this.temperature = temperature;
  }

  /**
   * 网页自动化操作标准工具定义
   */
  static getToolsSchema() {
    return [
      {
        type: 'function',
        function: {
          name: 'click_element',
          description: '点击页面中带有指定编号的按钮、链接或可交互元素',
          parameters: {
            type: 'object',
            properties: {
              index: {
                type: 'integer',
                description: '目标元素在页面上的编号数字'
              },
              ref: {
                type: 'string',
                description: '可选的目标元素稳定语义指纹引用'
              }
            },
            required: ['index']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'input_text',
          description: '在指定编号的输入框或文本编辑区域中输入文本内容',
          parameters: {
            type: 'object',
            properties: {
              index: {
                type: 'integer',
                description: '目标输入框的编号数字'
              },
              text: {
                type: 'string',
                description: '需要输入的文本内容'
              },
              press_enter: {
                type: 'boolean',
                description: '输入完成后是否自动按下回车键提交'
              },
              ref: {
                type: 'string',
                description: '可选的目标元素稳定语义指纹引用'
              }
            },
            required: ['index', 'text']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'scroll_page',
          description: '上下滚动当前网页视图以查看更多页面内容',
          parameters: {
            type: 'object',
            properties: {
              direction: {
                type: 'string',
                enum: ['up', 'down'],
                description: '滚动方向：向下(down)或向上(up)'
              },
              amount: {
                type: 'integer',
                description: '滚动的像素距离，默认 600'
              }
            },
            required: ['direction']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'navigate_to',
          description: '跳转到指定的网页地址 (URL)',
          parameters: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: '目标网址（必须以 http:// 或 https:// 开头）'
              }
            },
            required: ['url']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'wait_seconds',
          description: '主动等待若干秒以等待异步数据加载',
          parameters: {
            type: 'object',
            properties: {
              seconds: {
                type: 'number',
                description: '等待的秒数（推荐 1 到 5 秒）'
              }
            },
            required: ['seconds']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'read_page_content',
          description: '提取页面或指定区域的文本内容、标题和结构化正文，用于阅读理解、总结或信息抽取',
          parameters: {
            type: 'object',
            properties: {
              selector: {
                type: 'string',
                description: '可选的 CSS 选择器（如 article, main, .content 等），不填则提取当前页面主要可读正文'
              },
              max_length: {
                type: 'integer',
                description: '最大字符数，默认 3000'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'finish_task',
          description: '任务目标成功达成时调用，结束流程并输出最终结果总结',
          parameters: {
            type: 'object',
            properties: {
              summary: {
                type: 'string',
                description: '对整个自动化执行结果的详细总结汇报'
              }
            },
            required: ['summary']
          }
        }
      }
    ];
  }

  /**
   * 发起流式对话补全请求，支持实时思考链与工具调用组装
   * @param {Array<Object>} messages - 上下文消息历史
   * @param {Function} [onChunk] - 接收流式片段的回调 (chunk: { type, text })
   * @returns {Promise<{ content: string, reasoning: string, toolCalls: Array<Object> }>}
   */
  async chatCompletionStream(messages, onChunk = null) {
    if (!this.apiKey && !this.baseUrl.includes('localhost') && !this.baseUrl.includes('127.0.0.1')) {
      throw new Error('未配置 API Key，请在设置中填写您的密钥');
    }

    const endpoint = `${this.baseUrl}/chat/completions`;
    const tools = OpenAIClient.getToolsSchema();

    const requestBody = {
      model: this.model,
      messages: messages,
      temperature: this.temperature,
      tools: tools,
      tool_choice: 'auto',
      stream: true
    };

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(requestBody)
      });
    } catch (netErr) {
      throw new Error(`连接大模型接口失败: ${netErr.message}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      let parsedMsg = errorText;
      try {
        const errorJson = JSON.parse(errorText);
        parsedMsg = errorJson.error?.message || errorJson.message || errorText;
      } catch (_) {}
      throw new Error(`接口响应错误 [HTTP ${response.status}]: ${parsedMsg}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');

    let fullContent = '';
    let fullReasoning = '';
    const toolCallsMap = new Map(); // index -> { id, name, argumentsStr }

    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留尚未结束的行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        if (trimmed === 'data: [DONE]') continue;

        const jsonStr = trimmed.slice(5).trim();
        try {
          const parsed = JSON.parse(jsonStr);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          // 捕获模型思考链路（兼容 DeepSeek R1 / OpenAI / Qwen）
          const reasoningChunk = delta.reasoning_content || delta.reasoning || delta.thought || '';
          if (reasoningChunk) {
            fullReasoning += reasoningChunk;
            if (onChunk) onChunk({ type: 'thought', text: reasoningChunk });
          }

          // 捕获正文生成
          const contentChunk = delta.content || '';
          if (contentChunk) {
            fullContent += contentChunk;
            if (onChunk) onChunk({ type: 'content', text: contentChunk });
          }

          // 拼装流式工具调用参数
          if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const tcIndex = tc.index ?? 0;
              if (!toolCallsMap.has(tcIndex)) {
                toolCallsMap.set(tcIndex, {
                  id: tc.id || `call_${Date.now()}_${tcIndex}`,
                  name: tc.function?.name || '',
                  argumentsStr: tc.function?.arguments || ''
                });
              } else {
                const existing = toolCallsMap.get(tcIndex);
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.argumentsStr += tc.function.arguments;
              }
            }
          }
        } catch (_) {}
      }
    }

    // 格式化解析完成的工具调用
    const parsedToolCalls = [];
    for (const [_, item] of toolCallsMap.entries()) {
      let argsObj = {};
      try {
        const cleaned = item.argumentsStr.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        argsObj = JSON.parse(cleaned);
      } catch (err) {
        console.warn('解析工具参数异常:', item.argumentsStr);
      }
      parsedToolCalls.push({
        id: item.id,
        name: item.name,
        arguments: argsObj
      });
    }

    return {
      content: fullContent,
      reasoning: fullReasoning,
      toolCalls: parsedToolCalls
    };
  }
}
