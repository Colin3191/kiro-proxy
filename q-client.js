import { CodeWhispererStreaming, GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client';
import crypto from 'crypto';
import pkg from 'node-machine-id';
const { machineIdSync } = pkg;

// region → endpoint 映射
const REGION_ENDPOINTS = {
  'us-east-1': 'https://q.us-east-1.amazonaws.com',
  'eu-west-1': 'https://q.eu-west-1.amazonaws.com',
  'ap-southeast-1': 'https://q.ap-southeast-1.amazonaws.com',
  'ap-northeast-1': 'https://q.ap-northeast-1.amazonaws.com',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com',
  'ap-south-1': 'https://q.ap-south-1.amazonaws.com',
  'ca-central-1': 'https://q.ca-central-1.amazonaws.com',
};
const DEFAULT_REGION = 'us-east-1';
const KIRO_VERSION = process.env.KIRO_VERSION || '0.11.107';
const MACHINE_ID = machineIdSync();

function buildUserAgent(machineId) {
  return `KiroIDE ${KIRO_VERSION} ${machineId || MACHINE_ID}`;
}

function regionFromArn(arn) {
  if (!arn) return null;
  const parts = arn.split(':');
  return parts.length >= 4 ? parts[3] : null;
}

function endpointForRegion(region) {
  return REGION_ENDPOINTS[region] || `https://q.${region}.amazonaws.com`;
}

function addRequiredHeaders(client, { agentMode = 'vibe', optOut = true, authMethod, provider } = {}) {
  if (optOut) {
    client.middlewareStack.add(
      (next) => async (args) => {
        args.request.headers = { ...args.request.headers, 'x-amzn-codewhisperer-optout': 'true' };
        return next(args);
      },
      { step: 'build', name: 'optOutHeader' }
    );
  }
  client.middlewareStack.add(
    (next) => async (args) => {
      args.request.headers = { ...args.request.headers, 'x-amzn-kiro-agent-mode': agentMode };
      return next(args);
    },
    { step: 'build', name: 'agentModeHeader' }
  );
  if (authMethod === 'external_idp') {
    client.middlewareStack.add(
      (next) => async (args) => {
        args.request.headers = { ...args.request.headers, TokenType: 'EXTERNAL_IDP' };
        return next(args);
      },
      { step: 'build', name: 'tokenTypeHeader' }
    );
  }
  if (provider === 'Internal') {
    client.middlewareStack.add(
      (next) => async (args) => {
        args.request.headers = { ...args.request.headers, 'redirect-for-internal': 'true' };
        return next(args);
      },
      { step: 'build', name: 'redirectForInternal' }
    );
  }
}

export function createClient(accessToken, { endpoint, region, authMethod, profileArn, provider, machineId } = {}) {
  const arnRegion = regionFromArn(profileArn);
  const finalRegion = region || arnRegion || DEFAULT_REGION;
  const finalEndpoint = endpoint || endpointForRegion(finalRegion);

  const client = new CodeWhispererStreaming({
    region: finalRegion,
    endpoint: finalEndpoint,
    token: { token: accessToken },
    customUserAgent: buildUserAgent(machineId),
  });
  addRequiredHeaders(client, { authMethod, provider });
  return client;
}

// ============================================================
// Anthropic tools → CodeWhisperer toolSpecification
// ============================================================
function convertTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter(t => t.name !== 'web_search' && t.name !== 'websearch')
    .map(t => ({
      toolSpecification: {
        name: t.name,
        description: (t.description || '').slice(0, 10000),
        inputSchema: { json: t.input_schema || t.parameters || {} },
      },
    }));
}

// ============================================================
// Anthropic messages → CodeWhisperer conversationState
// ============================================================

/**
 * 从 Anthropic content blocks 中提取图片，转换为 CodeWhisperer 格式
 * Anthropic 格式: { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
 * CodeWhisperer 格式: { format: "png", source: { bytes: Buffer } }
 */
function extractImages(content) {
  if (!Array.isArray(content)) return [];
  const formatMap = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const images = [];

  for (const block of content) {
    if (block.type === 'image' && block.source) {
      if (block.source.type === 'base64' && block.source.data) {
        const format = formatMap[block.source.media_type] || 'jpeg';
        images.push({ format, source: { bytes: Buffer.from(block.source.data, 'base64') } });
      } else if (block.source.type === 'url' && block.source.url) {
        // data URL: data:image/png;base64,iVBOR...
        const url = block.source.url;
        if (url.startsWith('data:')) {
          const parts = url.split(',');
          if (parts.length >= 2) {
            const mimeMatch = parts[0].match(/data:(image\/\w+)/);
            const format = mimeMatch ? (formatMap[mimeMatch[1]] || 'jpeg') : 'jpeg';
            images.push({ format, source: { bytes: Buffer.from(parts[1], 'base64') } });
          }
        }
      }
    }
    // LangChain/OpenAI 格式: { type: "image_url", image_url: { url: "data:..." } }
    if (block.type === 'image_url' && block.image_url) {
      const url = typeof block.image_url === 'string' ? block.image_url : block.image_url.url;
      if (url?.startsWith('data:')) {
        const parts = url.split(',');
        if (parts.length >= 2) {
          const mimeMatch = parts[0].match(/data:(image\/\w+)/);
          const format = mimeMatch ? (formatMap[mimeMatch[1]] || 'jpeg') : 'jpeg';
          images.push({ format, source: { bytes: Buffer.from(parts[1], 'base64') } });
        }
      }
    }
  }
  return images;
}

/**
 * 从 Anthropic content blocks 中提取文本
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

/**
 * 从 assistant content blocks 中提取 tool_use 调用
 */
function extractToolUses(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b.type === 'tool_use')
    .map(b => ({ toolUseId: b.id, name: b.name, input: b.input || {} }));
}

/**
 * 从 user content blocks 中提取 tool_result
 */
function extractToolResults(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b.type === 'tool_result')
    .map(b => {
      let resultContent;
      if (typeof b.content === 'string') {
        resultContent = [{ text: b.content }];
      } else if (Array.isArray(b.content)) {
        resultContent = b.content.map(c => {
          if (typeof c === 'string') return { text: c };
          if (c.type === 'text') return { text: c.text };
          return { text: JSON.stringify(c) };
        });
      } else {
        resultContent = [{ text: '' }];
      }
      return {
        toolUseId: b.tool_use_id,
        content: resultContent,
        status: b.is_error ? 'error' : 'success',
      };
    });
}

/**
 * 将 Anthropic 格式的 messages + tools + system 转换为 CodeWhisperer conversationState
 * 支持完整的工具调用循环
 */
export function convertMessages(messages, { modelId, system, tools } = {}) {
  const validModelId = modelId || undefined;
  const cwTools = convertTools(tools);
  const history = [];

  // system → 注入为第一轮 user/assistant 对
  if (system) {
    const sysText = typeof system === 'string' ? system : system.map(b => b.text || '').join('\n');
    if (sysText) {
      history.push({
        userInputMessage: {
          content: sysText, modelId: validModelId, origin: 'AI_EDITOR',
        },
      });
      history.push({ assistantResponseMessage: { content: 'OK' } });
    }
  }

  // 遍历 messages，构建 history
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractText(msg.content);
      const toolResults = extractToolResults(msg.content);
      const images = extractImages(msg.content);

      if (toolResults.length > 0) {
        // tool_result 消息：content 为空，结果放在 userInputMessageContext.toolResults
        history.push({
          userInputMessage: {
            content: '',
            modelId: validModelId,
            origin: 'AI_EDITOR',
            userInputMessageContext: { toolResults },
            ...(images.length > 0 && { images }),
          },
        });
      } else {
        history.push({
          userInputMessage: {
            content: text, modelId: validModelId, origin: 'AI_EDITOR',
            ...(images.length > 0 && { images }),
          },
        });
      }
    } else if (msg.role === 'assistant') {
      const text = extractText(msg.content);
      const toolUses = extractToolUses(msg.content);
      history.push({
        assistantResponseMessage: {
          content: text,
          toolUses: toolUses.length > 0 ? toolUses : undefined,
        },
      });
    }
    // system 已在上面处理
  }

  // 确保 history 以 user→assistant 交替，末尾是 user
  // 如果末尾是 assistant（不应该发生），追加空 user
  const last = history.at(-1);
  if (last?.assistantResponseMessage) {
    history.push({
      userInputMessage: { content: 'Continue.', modelId: validModelId, origin: 'AI_EDITOR' },
    });
  }

  const currentMessage = history.at(-1);
  // 将 tools 注入到 currentMessage
  if (cwTools && currentMessage?.userInputMessage) {
    currentMessage.userInputMessage.userInputMessageContext = {
      ...currentMessage.userInputMessage.userInputMessageContext,
      tools: cwTools,
    };
  }

  return {
    conversationId: crypto.randomUUID(),
    currentMessage,
    history: history.slice(0, -1),
    chatTriggerType: 'MANUAL',
  };
}

// ============================================================
// 流式调用，返回 text + tool_use 事件
// ============================================================

/**
 * 流式调用 Q Developer，yield text 和 tool_use 事件
 * Claude Code 需要完整的 tool_use 块来驱动工具循环
 */
export async function* chatStream(client, { messages, system, tools, profileArn, modelId } = {}) {
  const conversationState = convertMessages(messages, { modelId, system, tools });
  const command = new GenerateAssistantResponseCommand({
    conversationState,
    profileArn,
  });

  const response = await client.send(command);
  if (!response.generateAssistantResponseResponse) {
    throw new Error('Empty response from Q Developer');
  }

  // 跟踪当前的 tool_use 状态
  const activeTools = new Map(); // toolUseId → { name, inputChunks }
  // 收集统计信息，流结束后汇总输出
  const stats = {};

  for await (const event of response.generateAssistantResponseResponse) {
    // 文本内容
    if (event.assistantResponseEvent?.content) {
      yield {
        type: 'content',
        content: event.assistantResponseEvent.content,
        modelId: event.assistantResponseEvent.modelId,
      };
    }

    // thinking/reasoning 内容
    if (event.reasoningContentEvent) {
      if (event.reasoningContentEvent.text) {
        yield { type: 'thinking', text: event.reasoningContentEvent.text };
      }
      if (event.reasoningContentEvent.signature) {
        yield { type: 'thinking_signature', signature: event.reasoningContentEvent.signature };
      }
    }

    // 计费/用量事件
    if (event.meteringEvent) {
      const m = event.meteringEvent;
      stats.metering = `${m.usage?.toFixed(4) ?? '?'} ${m.unitPlural || m.unit || 'units'}`;
    }

    // 代码引用/许可证事件
    if (event.codeReferenceEvent) {
      stats.codeRef = event.codeReferenceEvent;
    }

    // 上下文使用率事件
    if (event.contextUsageEvent) {
      stats.context = `${(event.contextUsageEvent.contextUsagePercentage ?? 0).toFixed(2)}%`;
    }

    // token 用量事件
    if (event.metadataEvent?.tokenUsage) {
      const t = event.metadataEvent.tokenUsage;
      const parts = [`in=${t.uncachedInputTokens ?? 0}`, `out=${t.outputTokens ?? 0}`];
      if (t.cacheReadInputTokens) parts.push(`cache_read=${t.cacheReadInputTokens}`);
      if (t.cacheWriteInputTokens) parts.push(`cache_write=${t.cacheWriteInputTokens}`);
      parts.push(`total=${t.totalTokens ?? 0}`);
      stats.tokens = parts.join(' ');
    }

    // 无效状态事件（错误）
    if (event.invalidStateEvent) {
      stats.invalid = `${event.invalidStateEvent.reason}: ${event.invalidStateEvent.message}`;
    }

    // 补充链接事件
    if (event.supplementaryWebLinksEvent?.supplementaryWebLinks?.length) {
      const links = event.supplementaryWebLinksEvent.supplementaryWebLinks;
      stats.links = `${links.length} ref(s): ${links.map(l => l.url || l.title).join(', ')}`;
    }

    // 工具调用事件
    if (event.toolUseEvent) {
      const { toolUseId, name, input, stop } = event.toolUseEvent;

      if (toolUseId && name && !activeTools.has(toolUseId)) {
        // 新工具调用开始
        activeTools.set(toolUseId, { name, inputChunks: [] });
        yield { type: 'tool_use_start', toolUseId, name };
      }

      // 累积 input 片段
      if (toolUseId && input) {
        const tool = activeTools.get(toolUseId);
        if (tool) tool.inputChunks.push(input);
      }

      // 工具调用结束
      if (stop) {
        for (const [id, tool] of activeTools) {
          // 合并 input 片段并解析
          let parsedInput = {};
          const raw = tool.inputChunks.join('');
          if (raw) {
            try { parsedInput = JSON.parse(raw); } catch { parsedInput = { raw }; }
          }
          yield { type: 'tool_use_end', toolUseId: id, name: tool.name, input: parsedInput };
        }
        activeTools.clear();
      }
    }
  }

  // 如果流结束时还有未关闭的工具调用，强制关闭
  for (const [id, tool] of activeTools) {
    let parsedInput = {};
    const raw = tool.inputChunks.join('');
    if (raw) {
      try { parsedInput = JSON.parse(raw); } catch { parsedInput = { raw }; }
    }
    yield { type: 'tool_use_end', toolUseId: id, name: tool.name, input: parsedInput };
  }

  // 汇总统计信息
  yield { type: 'summary', stats };
}

/**
 * 非流式调用
 */
export async function chat(client, { messages, system, tools, profileArn, modelId } = {}) {
  const content = [];
  let usedModelId;
  let thinkingText = '';
  let thinkingSignature;
  let stats;

  for await (const event of chatStream(client, { messages, system, tools, profileArn, modelId })) {
    if (event.type === 'thinking') {
      thinkingText += event.text;
    } else if (event.type === 'thinking_signature') {
      thinkingSignature = event.signature;
    } else if (event.type === 'content') {
      // 如果有累积的 thinking，先输出 thinking block
      if (thinkingText && !content.some(b => b.type === 'thinking')) {
        content.push({ type: 'thinking', thinking: thinkingText, signature: thinkingSignature || '' });
      }
      if (!content.length || content.at(-1).type !== 'text') {
        content.push({ type: 'text', text: '' });
      }
      content.at(-1).text += event.content;
      usedModelId = event.modelId;
    } else if (event.type === 'tool_use_end') {
      // 如果有累积的 thinking，先输出
      if (thinkingText && !content.some(b => b.type === 'thinking')) {
        content.push({ type: 'thinking', thinking: thinkingText, signature: thinkingSignature || '' });
      }
      content.push({ type: 'tool_use', id: event.toolUseId, name: event.name, input: event.input });
    } else if (event.type === 'summary') {
      stats = event.stats;
    }
  }

  // 如果只有 thinking 没有其他内容
  if (thinkingText && !content.some(b => b.type === 'thinking')) {
    content.unshift({ type: 'thinking', thinking: thinkingText, signature: thinkingSignature || '' });
  }

  const hasToolUse = content.some(b => b.type === 'tool_use');
  return { content, stopReason: hasToolUse ? 'tool_use' : 'end_turn', modelId: usedModelId, stats };
}

// ============================================================
// ListAvailableModels
// ============================================================

export async function listAvailableModels(accessToken, { profileArn, authMethod, provider, machineId } = {}) {
  const arnRegion = regionFromArn(profileArn);
  const region = arnRegion || DEFAULT_REGION;
  const endpoint = endpointForRegion(region);

  const params = new URLSearchParams({ origin: 'AI_EDITOR' });
  if (profileArn) params.set('profileArn', profileArn);

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': buildUserAgent(machineId),
    'x-amzn-codewhisperer-optout': 'true',
  };
  if (authMethod === 'external_idp') headers['TokenType'] = 'EXTERNAL_IDP';
  if (provider === 'Internal') headers['redirect-for-internal'] = 'true';

  const allModels = [];
  let defaultModel = null;
  let nextToken;

  do {
    if (nextToken) params.set('nextToken', nextToken);
    const url = `${endpoint}/ListAvailableModels?${params}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ListAvailableModels failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    allModels.push(...(data.models || []));
    if (data.defaultModel && !defaultModel) defaultModel = data.defaultModel;
    nextToken = data.nextToken;
  } while (nextToken);

  return { models: allModels, defaultModel };
}
