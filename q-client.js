import { GenerateAssistantResponseCommand, KiroRuntimeClient } from './kiro-runtime-client.js';
import crypto from 'crypto';
import os from 'os';

// region → endpoint 映射
const REGION_ENDPOINTS = {
  'us-east-1': 'https://runtime.us-east-1.kiro.dev',
  'eu-central-1': 'https://runtime.eu-central-1.kiro.dev',
  'us-gov-west-1': 'https://runtime.us-gov-west-1.kiro.dev',
};
const DEFAULT_REGION = 'us-east-1';
const KIRO_VERSION = process.env.KIRO_VERSION || '1.0.231';

function buildUserAgent(machineId) {
  return `kiro-ide/${KIRO_VERSION} md/machineId-${machineId || os.hostname()}`;
}

function regionFromArn(arn) {
  if (!arn) return null;
  const parts = arn.split(':');
  return parts.length >= 4 ? parts[3] : null;
}

function endpointForRegion(region) {
  return process.env.KIRO_RUNTIME_ENDPOINT || REGION_ENDPOINTS[region] || `https://runtime.${region}.kiro.dev`;
}

export function createClient(accessToken, { endpoint, region, authMethod, profileArn, provider, machineId } = {}) {
  const arnRegion = regionFromArn(profileArn);
  const finalRegion = region || arnRegion || DEFAULT_REGION;
  const finalEndpoint = endpoint || endpointForRegion(finalRegion);

  return new KiroRuntimeClient({
    region: finalRegion,
    endpoint: finalEndpoint,
    token: { token: accessToken },
    customUserAgent: buildUserAgent(machineId),
    authMethod,
    provider,
  });
}

// ============================================================
// Anthropic tools → Kiro Runtime toolSpecification
// ============================================================
function convertTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter(t => t.name !== 'web_search' && t.name !== 'websearch')
    .map(t => ({
      toolSpecification: {
        name: t.name,
        description: (t.description?.trim() || t.name || 'tool').slice(0, 10000),
        inputSchema: { json: normalizeJsonSchema(t.input_schema || t.parameters || {}) },
      },
    }));
}

function normalizeJsonSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const normalized = structuredClone(schema);
  for (const key of ['title', 'default', 'examples', '$id', '$schema']) delete normalized[key];
  if (normalized.required == null || !Array.isArray(normalized.required)) delete normalized.required;
  if (!normalized.type) normalized.type = 'object';
  if (normalized.type === 'object' && !normalized.properties) normalized.properties = {};
  return normalized;
}

// ============================================================
// Anthropic messages → Kiro Runtime conversationState
// ============================================================

/**
 * 从 Anthropic content blocks 中提取图片，转换为 Kiro Runtime 格式
 * Anthropic 格式: { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
 * Kiro Runtime 格式: { format: "png", source: { bytes: base64 } }
 */
function extractImages(content) {
  if (!Array.isArray(content)) return [];
  const formatMap = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const images = [];

  for (const block of content) {
    if (block.type === 'image' && block.source) {
      if (block.source.type === 'base64' && block.source.data) {
        const format = formatMap[block.source.media_type];
        if (!format) throw new Error(`Unsupported image format: ${block.source.media_type || 'unknown'}`);
        images.push({ format, source: { bytes: normalizeBase64(block.source.data) } });
      } else if (block.source.type === 'url' && block.source.url) {
        // data URL: data:image/png;base64,iVBOR...
        const url = block.source.url;
        if (url.startsWith('data:')) {
          const parts = url.split(',');
          if (parts.length >= 2) {
            const mimeMatch = parts[0].match(/data:(image\/\w+)/);
            const format = mimeMatch && formatMap[mimeMatch[1]];
            if (!format) throw new Error(`Unsupported image format: ${mimeMatch?.[1] || 'unknown'}`);
            images.push({ format, source: { bytes: normalizeBase64(parts[1]) } });
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
          const format = mimeMatch && formatMap[mimeMatch[1]];
          if (!format) throw new Error(`Unsupported image format: ${mimeMatch?.[1] || 'unknown'}`);
          images.push({ format, source: { bytes: normalizeBase64(parts[1]) } });
        }
      }
    }
  }
  return images;
}

function normalizeBase64(value) {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0) throw new Error('Image contains invalid or empty base64 data');
  return bytes.toString('base64');
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
 * 从 assistant content blocks 中提取 thinking → Kiro Runtime reasoningContent
 * Anthropic 格式: { type: "thinking", thinking: "...", signature: "..." }
 * Kiro Runtime 格式: { reasoningText: { text, signature } } 或 { redactedContent }
 */
function extractReasoning(content) {
  if (!Array.isArray(content)) return undefined;
  const redacted = content.find(b => b.type === 'redacted_thinking' && typeof b.data === 'string' && b.data.length > 0);
  if (redacted) return { redactedContent: redacted.data };

  const thinkingBlocks = content.filter(b => b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 0);
  if (thinkingBlocks.length === 0) return undefined;
  const text = thinkingBlocks.map(b => b.thinking).join('');
  const sig = thinkingBlocks.map(b => b.signature).find(s => typeof s === 'string' && s.length > 0);
  // Kiro Runtime only accepts replayed reasoning when it carries the model's
  // signature. Unsigned thinking is display-only and must not enter history.
  if (!sig) return undefined;
  return {
    reasoningText: {
      text,
      signature: sig,
    },
  };
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
 * 将 Anthropic 格式的 messages + tools + system 转换为 Kiro Runtime 请求
 * 支持完整的工具调用循环
 */
function isUserMessage(message) {
  return !!message?.userInputMessage;
}

function isAssistantMessage(message) {
  return !!message?.assistantResponseMessage;
}

function toolResultsOf(message) {
  return message?.userInputMessage?.userInputMessageContext?.toolResults || [];
}

function hasUserText(message) {
  return !!message?.userInputMessage?.content?.trim();
}

function toolUsesOf(message) {
  return message?.assistantResponseMessage?.toolUses || [];
}

function failureResult(toolUseId) {
  return {
    toolUseId,
    content: [{ text: 'Tool execution failed' }],
    status: 'error',
  };
}

/** Bring arbitrary OpenAI/Anthropic history into Kiro Runtime's strict shape. */
export function normalizeConversation(messages, modelId) {
  let result = [...messages];

  if (!isUserMessage(result[0])) {
    result.unshift({ userInputMessage: { content: 'Hello', modelId, origin: 'AI_EDITOR' } });
  }

  result = result.filter((message, index) => {
    if (!isUserMessage(message)) return true;
    return index === 0 || hasUserText(message) || toolResultsOf(message).length > 0;
  });

  // Tool results can arrive as multiple adjacent user messages when tools run
  // concurrently. Kiro expects one user message containing the whole batch.
  const mergedResults = [];
  for (let index = 0; index < result.length;) {
    const message = result[index];
    if (!isUserMessage(message) || hasUserText(message) || toolResultsOf(message).length === 0) {
      mergedResults.push(message);
      index++;
      continue;
    }
    const batch = [];
    const seen = new Set();
    while (index < result.length && isUserMessage(result[index]) && !hasUserText(result[index]) && toolResultsOf(result[index]).length > 0) {
      for (const toolResult of toolResultsOf(result[index])) {
        if (!toolResult.toolUseId || !seen.has(toolResult.toolUseId)) {
          if (toolResult.toolUseId) seen.add(toolResult.toolUseId);
          batch.push(toolResult);
        }
      }
      index++;
    }
    mergedResults.push({
      userInputMessage: {
        content: '',
        modelId,
        origin: 'AI_EDITOR',
        userInputMessageContext: { toolResults: batch },
      },
    });
  }
  result = mergedResults;

  // Remove duplicate tool-use IDs before matching results.
  result = result.map(message => {
    if (!isAssistantMessage(message)) return message;
    const seen = new Set();
    const toolUses = toolUsesOf(message).filter(toolUse => {
      if (!toolUse.toolUseId || !seen.has(toolUse.toolUseId)) {
        if (toolUse.toolUseId) seen.add(toolUse.toolUseId);
        return true;
      }
      return false;
    });
    return {
      assistantResponseMessage: {
        ...message.assistantResponseMessage,
        ...(toolUses.length > 0 ? { toolUses } : { toolUses: undefined }),
      },
    };
  });

  // Every assistant tool-use batch must be followed by exactly matching
  // results. Preserve real results and synthesize failures only for gaps.
  const paired = [];
  for (let index = 0; index < result.length; index++) {
    const message = result[index];
    paired.push(message);
    const toolUses = toolUsesOf(message);
    if (toolUses.length === 0) continue;

    const next = result[index + 1];
    const existing = isUserMessage(next) ? toolResultsOf(next) : [];
    const expectedIds = new Set(toolUses.map((toolUse, toolIndex) => toolUse.toolUseId || `toolUse_${toolIndex + 1}`));
    const seen = new Set();
    const matching = existing.filter(toolResult => toolResult.toolUseId && expectedIds.has(toolResult.toolUseId) && !seen.has(toolResult.toolUseId) && seen.add(toolResult.toolUseId));
    const missing = [...expectedIds].filter(id => !seen.has(id)).map(failureResult);
    const toolResults = [...matching, ...missing];

    if (isUserMessage(next)) {
      paired.push({
        userInputMessage: {
          ...next.userInputMessage,
          userInputMessageContext: {
            ...next.userInputMessage.userInputMessageContext,
            toolResults,
          },
        },
      });
      index++;
    } else {
      paired.push({
        userInputMessage: {
          content: '',
          modelId,
          origin: 'AI_EDITOR',
          userInputMessageContext: { toolResults },
        },
      });
    }
  }
  result = paired;

  // Strip orphan results that do not directly answer the preceding assistant.
  result = result.map((message, index) => {
    if (!isUserMessage(message) || toolResultsOf(message).length === 0) return message;
    const previousIds = new Set(toolUsesOf(result[index - 1]).map(toolUse => toolUse.toolUseId).filter(Boolean));
    const filtered = toolResultsOf(message).filter(toolResult => toolResult.toolUseId && previousIds.has(toolResult.toolUseId));
    if (filtered.length > 0) {
      return {
        userInputMessage: {
          ...message.userInputMessage,
          userInputMessageContext: {
            ...message.userInputMessage.userInputMessageContext,
            toolResults: filtered,
          },
        },
      };
    }
    if (hasUserText(message)) {
      const { userInputMessageContext, ...userInputMessage } = message.userInputMessage;
      return { userInputMessage };
    }
    return null;
  }).filter(Boolean);

  const alternating = [result[0]];
  for (const message of result.slice(1)) {
    const previous = alternating.at(-1);
    if (isUserMessage(previous) && isUserMessage(message)) {
      alternating.push({ assistantResponseMessage: { content: 'understood' } });
    } else if (isAssistantMessage(previous) && isAssistantMessage(message)) {
      alternating.push({ userInputMessage: { content: 'Continue', modelId, origin: 'AI_EDITOR' } });
    }
    alternating.push(message);
  }

  if (!isUserMessage(alternating.at(-1))) {
    alternating.push({ userInputMessage: { content: 'Continue', modelId, origin: 'AI_EDITOR' } });
  }
  return alternating;
}

function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return undefined;
  const text = system.filter(block => block?.type === 'text' || typeof block?.text === 'string').map(block => block.text || '').join('\n');
  return text || undefined;
}

export function buildConversationRequest(messages, {
  modelId,
  system,
  tools,
  conversationId,
  agentMode = 'vibe',
  systemPromptMode = process.env.KIRO_SYSTEM_PROMPT_MODE || 'legacy',
} = {}) {
  const validModelId = modelId || undefined;
  const cwTools = convertTools(tools);
  const history = [];
  const prompt = systemText(system);

  // Kiro 1.0.231 has a top-level systemPrompt field, but it is guarded by
  // system_field_injection and defaults to disabled. Mirror that default.
  if (prompt && systemPromptMode !== 'field') {
    history.push({
      userInputMessage: { content: prompt, modelId: validModelId, origin: 'AI_EDITOR' },
    });
    history.push({ assistantResponseMessage: { content: 'I will follow these instructions.' } });
  }

  // 遍历 messages，构建 history
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractText(msg.content);
      const toolResults = extractToolResults(msg.content);
      const images = extractImages(msg.content);

      if (toolResults.length > 0) {
        // tool_result 消息：text block 作为 content，tool_result 放在 userInputMessageContext
        // 关键：Claude Code 的 ESC 中断会把 tool_result + [Request interrupted] + 新 prompt 打包成同一条 user message 的多个 content block，
        // 如果这里把 content 写死成 ''，中断标记和新 prompt 会被静默丢弃，模型无法感知中断
        history.push({
          userInputMessage: {
            content: text,
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
      const reasoningContent = extractReasoning(msg.content);
      history.push({
        assistantResponseMessage: {
          content: text,
          toolUses: toolUses.length > 0 ? toolUses : undefined,
          ...(reasoningContent && { reasoningContent }),
        },
      });
    }
    // system 已在上面处理
  }

  const normalized = normalizeConversation(history, validModelId);

  const currentMessage = normalized.at(-1);
  // 将 tools 注入到 currentMessage
  // 当没有传 tools 但 history 中有 toolUses 时，自动生成最小 tools 定义
  // Kiro Runtime 要求 history 中引用的工具必须在 tools 中有定义
  let finalTools = cwTools;
  if (!finalTools && currentMessage?.userInputMessage) {
    const toolNames = new Set();
    for (const h of normalized) {
      if (h.assistantResponseMessage?.toolUses) {
        for (const tu of h.assistantResponseMessage.toolUses) {
          if (tu.name) toolNames.add(tu.name);
        }
      }
    }
    if (toolNames.size > 0) {
      finalTools = [...toolNames].map(name => ({
        toolSpecification: {
          name,
          description: name,
          inputSchema: { json: { type: 'object' } },
        },
      }));
    }
  }
  if (finalTools && currentMessage?.userInputMessage) {
    currentMessage.userInputMessage.userInputMessageContext = {
      ...currentMessage.userInputMessage.userInputMessageContext,
      tools: finalTools,
    };
  }

  return {
    systemPrompt: prompt && systemPromptMode === 'field' ? prompt : undefined,
    agentMode,
    conversationState: {
      conversationId: conversationId || crypto.randomUUID(),
      currentMessage,
      history: normalized.slice(0, -1),
      chatTriggerType: 'MANUAL',
    },
  };
}

// Kept as a public helper for callers that only need conversationState.
export function convertMessages(messages, options = {}) {
  return buildConversationRequest(messages, options).conversationState;
}

function stripReasoningFromHistory(conversationState) {
  return {
    ...conversationState,
    history: conversationState.history?.map(message => {
      if (!message.assistantResponseMessage?.reasoningContent) return message;
      const { reasoningContent, ...assistantResponseMessage } = message.assistantResponseMessage;
      return { assistantResponseMessage };
    }),
  };
}

async function* sendRuntimeRequest(client, input) {
  let receivedEvent = false;
  try {
    const response = await client.send(new GenerateAssistantResponseCommand(input));
    if (!response.generateAssistantResponseResponse) throw new Error('Empty response from Kiro Runtime');
    for await (const event of response.generateAssistantResponseResponse) {
      receivedEvent = true;
      yield event;
    }
  } catch (error) {
    if (receivedEvent) throw error;
    let retryInput;
    if (error.reason === 'THINKING_SIGNATURE_INVALID') {
      retryInput = {
        ...input,
        conversationState: stripReasoningFromHistory(input.conversationState),
      };
    } else if (input.systemPrompt && error.message === 'Improperly formed request.') {
      const { systemPrompt, ...rest } = input;
      retryInput = {
        ...rest,
        conversationState: {
          ...input.conversationState,
          history: [
            { userInputMessage: { content: systemPrompt, origin: 'AI_EDITOR' } },
            { assistantResponseMessage: { content: 'I will follow these instructions.' } },
            ...input.conversationState.history,
          ],
        },
      };
    } else {
      throw error;
    }
    const response = await client.send(new GenerateAssistantResponseCommand(retryInput));
    if (!response.generateAssistantResponseResponse) throw new Error('Empty response from Kiro Runtime');
    yield* response.generateAssistantResponseResponse;
  }
}

// ============================================================
// 流式调用，返回 text + tool_use 事件
// ============================================================

/**
 * 流式调用 Kiro Runtime，yield text 和 tool_use 事件
 * Claude Code 需要完整的 tool_use 块来驱动工具循环
 */
export async function* chatStream(client, { messages, system, tools, profileArn, modelId, agentMode = 'vibe', additionalModelRequestFields, systemPromptMode } = {}) {
  const request = buildConversationRequest(messages, { modelId, system, tools, agentMode, systemPromptMode });
  const commandInput = {
    conversationState: request.conversationState,
    profileArn,
    agentMode: request.agentMode,
    ...(request.systemPrompt && { systemPrompt: request.systemPrompt }),
    ...(additionalModelRequestFields && { additionalModelRequestFields }),
  };

  // 跟踪当前的 tool_use 状态
  const activeTools = new Map(); // toolUseId → { name, inputChunks }
  // 收集统计信息，流结束后汇总输出
  const stats = {};
  let meteringUsage = 0;

  for await (const event of sendRuntimeRequest(client, commandInput)) {
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
      if (event.reasoningContentEvent.redactedContent) {
        const value = event.reasoningContentEvent.redactedContent;
        const data = typeof value === 'string' ? value : Buffer.from(value).toString('base64');
        yield { type: 'redacted_thinking', data };
      }
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
      if (typeof m.usage === 'number') meteringUsage = m.usage;
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
    if (event.metadataEvent?.stopReason) {
      yield {
        type: 'stop_reason',
        stopReason: normalizeStopReason(event.metadataEvent.stopReason),
        stopDetails: event.metadataEvent.stopDetails,
      };
    }

    // 无效状态事件（错误）
    if (event.invalidStateEvent) {
      stats.invalid = `${event.invalidStateEvent.reason}: ${event.invalidStateEvent.message}`;
      // 将 invalidStateEvent 作为错误抛出，让调用方感知
      throw new Error(`Kiro Runtime invalidState: ${event.invalidStateEvent.reason} - ${event.invalidStateEvent.message}`);
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
  yield { type: 'summary', stats, meteringUsage };
}

/**
 * 非流式调用
 */
export async function chat(client, { messages, system, tools, profileArn, modelId, agentMode, additionalModelRequestFields, systemPromptMode } = {}) {
  const content = [];
  let usedModelId;
  let thinkingText = '';
  let thinkingSignature;
  let stats;
  let meteringUsage = 0;
  let upstreamStopReason;
  let stopDetails;

  for await (const event of chatStream(client, { messages, system, tools, profileArn, modelId, agentMode, additionalModelRequestFields, systemPromptMode })) {
    if (event.type === 'thinking') {
      thinkingText += event.text;
    } else if (event.type === 'redacted_thinking') {
      content.push({ type: 'redacted_thinking', data: event.data });
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
      meteringUsage = event.meteringUsage;
    } else if (event.type === 'stop_reason') {
      upstreamStopReason = event.stopReason;
      stopDetails = event.stopDetails;
    }
  }

  // 如果只有 thinking 没有其他内容
  if (thinkingText && !content.some(b => b.type === 'thinking')) {
    content.unshift({ type: 'thinking', thinking: thinkingText, signature: thinkingSignature || '' });
  }

  const hasToolUse = content.some(b => b.type === 'tool_use');
  return {
    content,
    stopReason: hasToolUse ? 'tool_use' : normalizeStopReason(upstreamStopReason),
    stopDetails,
    modelId: usedModelId,
    stats,
    meteringUsage,
  };
}

function normalizeStopReason(reason) {
  if (!reason) return 'end_turn';
  const normalized = String(reason).toLowerCase();
  if (normalized.includes('tool')) return 'tool_use';
  if (normalized.includes('max') || normalized.includes('length')) return 'max_tokens';
  if (normalized.includes('stop_sequence')) return 'stop_sequence';
  if (normalized.includes('refusal')) return 'refusal';
  return 'end_turn';
}

// ============================================================
// ListAvailableModels
// ============================================================

export async function listAvailableModels(accessToken, { profileArn, authMethod, provider, machineId } = {}) {
  const arnRegion = regionFromArn(profileArn);
  const region = arnRegion || DEFAULT_REGION;
  const endpoint = (process.env.KIRO_CONTROL_PLANE_ENDPOINT || `https://management.${region}.kiro.dev`).replace(/\/$/, '');

  const params = new URLSearchParams({ origin: 'AI_EDITOR' });
  if (profileArn) params.set('profileArn', profileArn);

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': buildUserAgent(machineId),
    'Content-Type': 'application/x-amz-json-1.0',
    'x-amz-target': 'KiroControlPlaneBearerService.ListAvailableModels',
    'x-amzn-codewhisperer-optout': 'true',
  };
  const tokenTypes = {
    external_idp: 'EXTERNAL_IDP',
    machine_token: 'KIRO_MACHINE_TOKEN',
    api_key: 'API_KEY',
    IdC: 'SSO_OIDC',
    idc: 'SSO_OIDC',
  };
  if (tokenTypes[authMethod]) headers.TokenType = tokenTypes[authMethod];
  if (provider === 'Internal') headers['redirect-for-internal'] = 'true';

  const allModels = [];
  let defaultModel = null;
  let nextToken;
  let pages = 0;

  do {
    if (nextToken) params.set('nextToken', nextToken);
    const url = `${endpoint}/List-Available-Models/?${params}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ListAvailableModels failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    allModels.push(...(data.models || []));
    if (data.defaultModel && !defaultModel) defaultModel = data.defaultModel;
    nextToken = data.nextToken;
    pages++;
  } while (nextToken && pages < 10);

  return { models: allModels, defaultModel };
}
