const { v4: uuidv4 } = require('uuid');
const zlib = require('zlib');
const $root = require('./message.js');

const regex = /<\|BEGIN_SYSTEM\|>.*?<\|END_SYSTEM\|>.*?<\|BEGIN_USER\|>.*?<\|END_USER\|>/s;

async function stringToHex(messages, modelName) {
  if (!Array.isArray(messages)) {
    throw new Error('messages must be an array');
  }

  console.log('Debug [29]: messages:', messages);

  const formattedMessages = messages.map((msg, index) => {
    if (!msg || typeof msg !== 'object') {
      throw new Error(`Invalid message at index ${index}: message must be an object`);
    }
    if (!msg.content && msg.content !== '') {
      throw new Error(`Invalid message at index ${index}: content is required`);
    }
    return {
      ...msg,
      role: msg.role === 'user' ? 1 : 2,
      message_id: msg.message_id || uuidv4(),
      content: String(msg.content), // 强制转换为字符串
    };
  });

  const message = {
    messages: formattedMessages,
    instructions: {
      instruction: 'Always respond in 中文',
    },
    projectPath: '/path/to/project',
    model: {
      name: modelName,
      empty: '',
    },
    requestId: uuidv4(),
    summary: '',
    conversationId: uuidv4(),
  };
  const errMsg = $root.ChatMessage.verify(message);
  if (errMsg) throw Error(errMsg);

  const messageInstance = $root.ChatMessage.create(message);

  const buffer = $root.ChatMessage.encode(messageInstance).finish();
  const hexString = (buffer.length.toString(16).padStart(10, '0') + buffer.toString('hex')).toUpperCase();

  return Buffer.from(hexString, 'hex');
}

async function chunkToUtf8String(chunk) {
  try {
    let hex = Buffer.from(chunk).toString('hex');
    console.log("debug [42] :", hex)
    
    let offset = 0;
    let results = [];

    while (offset < hex.length) {
      if (offset + 10 > hex.length) break;

      const dataLength = parseInt(hex.slice(offset, offset + 10), 16);
      offset += 10;

      if (offset + dataLength * 2 > hex.length) break;

      const messageHex = hex.slice(offset, offset + dataLength * 2);
      offset += dataLength * 2;

      console.log("debug [57] :", messageHex)
      const messageBuffer = Buffer.from(messageHex, 'hex');
      const message = $root.ResMessage.decode(messageBuffer);
      results.push(message.msg);
    }

    if (results.length == 0) {
      console.log("debug [63] :", chunk)
      return gunzip(chunk);
    }
    return results.join('');
  } catch (err) {
    console.log("debug [68] :", chunk)
    return gunzip(chunk);
  }
}

function gunzip(chunk) {
  return new Promise((resolve, reject) => {
    zlib.gunzip(chunk.slice(5), (err, decompressed) => {
      if (err) {
        resolve('');
      } else {
        const text = decompressed.toString('utf-8');
        // 这里只是尝试解析错误数据，如果是包含了全量的返回结果直接忽略
        if (regex.test(text)) {
          resolve('');
        } else {
          resolve(text);
        }
      }
    });
  });
}

function getRandomIDPro({ size, dictType, customDict }) {
  let random = '';
  if (!customDict) {
    switch (dictType) {
      case 'alphabet':
        customDict = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        break;
      case 'max':
        customDict = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-';
        break;
      default:
        customDict = '0123456789';
    }
  }
  for (; size--; ) random += customDict[(Math.random() * customDict.length) | 0];
  return random;
}

module.exports = {
  stringToHex,
  chunkToUtf8String,
  getRandomIDPro,
};
