const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { stringToHex, chunkToUtf8String, getRandomIDPro } = require('./utils.js');
const app = express();

// 中间件配置
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/v1/chat/completions', async (req, res) => {
  // o1开头的模型，不支持流式输出
  if (req.body.model?.startsWith('o1-') && req.body.stream) {
    return res.status(400).json({
      error: 'Model not supported stream',
    });
  }

  let currentKeyIndex = 0;
  try {
    const { model, messages, stream = false } = req.body;
    
    // 验证必需的请求参数
    if (!model) {
      return res.status(400).json({
        error: 'Model is required'
      });
    }

    let authToken = req.headers.authorization?.replace('Bearer ', '');
    
    // 验证认证token
    if (!authToken) {
      return res.status(401).json({
        error: 'Authentication token is required'
      });
    }

    // 处理逗号分隔的密钥
    const keys = authToken.split(',').map((key) => key.trim());
    if (keys.length > 0) {
      // 确保 currentKeyIndex 不会越界
      if (currentKeyIndex >= keys.length) {
        currentKeyIndex = 0;
      }
      // 使用当前索引获取密钥
      authToken = keys[currentKeyIndex];
    }

    if (authToken && authToken.includes('%3A%3A')) {
      authToken = authToken.split('%3A%3A')[1];
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: 'Messages should be a non-empty array'
      });
    }

    // 确保 messages 数组中的每个对象都有必要的字段
    const formattedMessages = messages.map((msg, index) => {
      if (!msg || typeof msg !== 'object') {
        throw new Error(`Message at index ${index} must be an object`);
      }
      
      if (!msg.role || typeof msg.role !== 'string') {
        throw new Error(`Message at index ${index}: role is required and must be a string`);
      }

      // 处理content字段
      let content = '';
      if (msg.content === undefined || msg.content === null) {
        if (msg.role === 'system') {
          // 系统消息需要content
          throw new Error(`System message at index ${index} requires content`);
        }
        // 其他角色可以有空content
        content = '';
      } else if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (typeof msg.content === 'object') {
        // 如果content是对象,尝试转换为字符串
        try {
          content = JSON.stringify(msg.content);
        } catch (err) {
          throw new Error(`Message at index ${index}: failed to stringify content object`);
        }
      } else {
        // 其他类型尝试转换为字符串
        try {
          content = String(msg.content);
        } catch (err) {
          throw new Error(`Message at index ${index}: failed to convert content to string`);
        }
      }

      return {
        role: msg.role,
        content: content,
        type: msg.type || 'text'
      };
    });

    console.log('Debug [41]: Received messages:', JSON.stringify(formattedMessages, null, 2));

    const hexData = await stringToHex(formattedMessages, model);

    // 获取checksum，req header中传递优先，环境变量中的等级第二，最后随机生成
    const checksum =
      req.headers['x-cursor-checksum'] ??
      process.env['x-cursor-checksum'] ??
      `zo${getRandomIDPro({ dictType: 'max', size: 6 })}${getRandomIDPro({ dictType: 'max', size: 64 })}/${getRandomIDPro({ dictType: 'max', size: 64 })}`;

    const response = await fetch('https://api2.cursor.sh/aiserver.v1.AiService/StreamChat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/connect+proto',
        authorization: `Bearer ${authToken}`,
        'connect-accept-encoding': 'gzip,br',
        'connect-protocol-version': '1',
        'user-agent': 'connect-es/1.4.0',
        'x-amzn-trace-id': `Root=${uuidv4()}`,
        'x-cursor-checksum': checksum,
        'x-cursor-client-version': '0.42.3',
        'x-cursor-timezone': 'Asia/Shanghai',
        'x-ghost-mode': 'false',
        'x-request-id': uuidv4(),
        Host: 'api2.cursor.sh',
      },
      body: hexData,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`API request failed with status ${response.status}: ${JSON.stringify(errorData)}`);
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const responseId = `chatcmpl-${uuidv4()}`;

      // 使用封装的函数处理 chunk
      for await (const chunk of response.body) {
        try {
          const text = await chunkToUtf8String(chunk);

          if (text.length > 0) {
            res.write(
              `data: ${JSON.stringify({
                id: responseId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: text,
                    },
                  },
                ],
              })}\n\n`,
            );
          }
        } catch (error) {
          console.error('Error processing chunk:', error);
          continue;
        }
      }

      res.write('data: [DONE]\n\n');
      return res.end();
    } else {
      let text = '';
      // 在非流模式下也使用封装的函数
      for await (const chunk of response.body) {
        try {
          text += await chunkToUtf8String(chunk);
        } catch (error) {
          console.error('Error processing chunk:', error);
          continue;
        }
      }
      // 对解析后的字符串进行进一步处理
      text = text.replace(/^.*<\|END_USER\|>/s, '');
      text = text.replace(/^\n[a-zA-Z]?/, '').trim();

      return res.json({
        id: `chatcmpl-${uuidv4()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });
    }
  } catch (error) {
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    
    if (!res.headersSent) {
      const statusCode = error.message.includes('Authentication') ? 401 : 400;
      const errorResponse = {
        error: statusCode === 401 ? 'Unauthorized' : 'Bad Request',
        details: error.message
      };

      if (req.body.stream) {
        res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
        return res.end();
      } else {
        return res.status(statusCode).json(errorResponse);
      }
    }
  }
});

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
