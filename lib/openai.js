/**
 * OpenAI 兼容接口请求客户端
 * 支持标准 OpenAI 格式、DeepSeek、通义千问、Ollama 以及各大第三方 API 代理服务
 */

export class OpenAIClient {
  /**
   * 初始化 API 客户端
   * @param {Object} config - 配置参数
   * @param {string} config.baseUrl - API 基础地址（如 https://api.openai.com/v1）
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
   * 浏览器自动化操作标准工具定义集合
   */
  static getToolsSchema() {
    return [
      {
        type: 'function',
        function: {
          name: 'click_element',
          description: '点击页面中带有指定编号的按钮、链接或可点击元素',
          parameters: {
            type: 'object',
            properties: {
              index: {
                type: 'integer',
                description: '目标元素在页面上的编号索引数字'
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
          description: '在指定编号的输入框或文本域中输入指定文本内容',
          parameters: {
            type: 'object',
            properties: {
              index: {
                type: 'integer',
                description: '目标输入框的编号索引数字'
              },
              text: {
                type: 'string',
                description: '需要键入的文本内容'
              },
              press_enter: {
                type: 'boolean',
                description: '输入完成后是否自动按下回车键（常用于搜索框提交）'
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
          description: '上下滚动当前网页视图，以查看更多页面内容',
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
          description: '在当前标签页中跳转到指定的网页地址 (URL)',
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
          description: '暂停等待若干秒，用于等待页面动态数据加载或弹窗呈现',
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
          name: 'finish_task',
          description: '当用户提出的任务目标已经成功达成时调用此函数，结束流程并输出最终结果总结',
          parameters: {
            type: 'object',
            properties: {
              summary: {
                type: 'string',
                description: '对整个自动化执行结果的总结汇报内容'
              }
            },
            required: ['summary']
          }
        }
      }
    ];
  }

  /**
   * 发起对话补全请求（支持 Function Calling 工具调用与自适应回退）
   * @param {Array<Object>} messages - 上下文消息历史
   * @returns {Promise<{ content: string, toolCalls: Array<Object> }>}
   */
  async chatCompletion(messages) {
    if (!this.apiKey && !this.baseUrl.includes('localhost') && !this.baseUrl.includes('127.0.0.1')) {
      throw new Error('未配置 API Key，请在侧边栏右上角设置中填写您的密钥');
    }

    const endpoint = `${this.baseUrl}/chat/completions`;
    const tools = OpenAIClient.getToolsSchema();

    const requestBody = {
      model: this.model,
      messages: messages,
      temperature: this.temperature,
      tools: tools,
      tool_choice: 'auto'
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
      throw new Error(`连接大模型接口失败: ${netErr.message}（请检查网络连接或 Base URL）`);
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

    const data = await response.json();
    const choice = data.choices && data.choices[0];
    if (!choice || !choice.message) {
      throw new Error('模型返回了空数据或格式异常');
    }

    const message = choice.message;
    const content = message.content || '';
    const rawToolCalls = message.tool_calls || [];

    const toolCalls = rawToolCalls.map((tc) => {
      let parsedArgs = {};
      try {
        parsedArgs = typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments;
      } catch (e) {
        console.warn('解析函数调用参数异常:', tc.function.arguments);
      }
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: parsedArgs
      };
    });

    return {
      content,
      toolCalls
    };
  }
}
