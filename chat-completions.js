import crypto from 'node:crypto';

export class ChatCompletionsValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChatCompletionsValidationError';
    this.status = 400;
  }
}

function completionId() {
  return `chatcmpl-${crypto.randomUUID().replaceAll('-', '')}`;
}

function toolCallId() {
  return `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

/** Flatten OpenAI content (string | part[]) into plain text. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    return '';
  }).join('');
}

function parseArguments(argumentsText) {
  if (argumentsText && typeof argumentsText === 'object') return argumentsText;
  if (typeof argumentsText !== 'string' || argumentsText.length === 0) return {};
  try {
    return JSON.parse(argumentsText);
  } catch {
    return { raw: argumentsText };
  }
}

function appendMessage(messages, role, content) {
  if (!content?.length) return;
  const previous = messages.at(-1);
  if (previous?.role === role && Array.isArray(previous.content)) {
    if (previous.content.at(-1)?.type === 'text' && content[0]?.type === 'text') {
      previous.content.push({ type: 'text', text: '\n\n' });
    }
    previous.content.push(...content);
  } else {
    messages.push({ role, content: [...content] });
  }
}

/** OpenAI content parts → Anthropic content blocks. */
function contentToAnthropic(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part });
      continue;
    }
    if ((part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') && typeof part.text === 'string') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part?.type === 'refusal' && typeof part.refusal === 'string') {
      if (part.refusal) blocks.push({ type: 'text', text: part.refusal });
      continue;
    }
    if (part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url !== 'string' || !url.startsWith('data:')) {
        throw new ChatCompletionsValidationError('Only data URL image_url values are supported');
      }
      blocks.push({ type: 'image', source: { type: 'url', url } });
    }
  }
  return blocks;
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const seen = new Set();
  const converted = [];
  for (const tool of tools) {
    // OpenAI nests function tools under `function`; accept the flat form too.
    const fn = tool?.function && typeof tool.function === 'object' ? tool.function : tool;
    const name = typeof fn?.name === 'string' ? fn.name : undefined;
    if (!name || (tool?.type && tool.type !== 'function')) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    converted.push({
      name,
      description: fn.description?.trim() || name,
      input_schema: fn.parameters || { type: 'object', properties: {} },
    });
  }
  return converted.length > 0 ? converted : undefined;
}

/** Only `tool_choice: "none"` is expressible upstream — drop tools entirely. */
function toolChoiceDropsTools(toolChoice) {
  return toolChoice === 'none';
}

export function convertChatCompletionsRequest(body = {}) {
  const input = body.messages;
  if (!Array.isArray(input) || input.length === 0) {
    throw new ChatCompletionsValidationError('messages must be a non-empty array');
  }

  const messages = [];
  const systemParts = [];

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role;

    if (role === 'system' || role === 'developer') {
      const text = contentText(item.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === 'user') {
      appendMessage(messages, 'user', contentToAnthropic(item.content));
      continue;
    }

    if (role === 'assistant') {
      appendMessage(messages, 'assistant', contentToAnthropic(item.content));
      const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
      const blocks = [];
      for (const call of toolCalls) {
        const fn = call?.function || {};
        if (typeof fn.name !== 'string' || fn.name.length === 0) continue;
        blocks.push({
          type: 'tool_use',
          id: call.id || toolCallId(),
          name: fn.name,
          input: parseArguments(fn.arguments),
        });
      }
      appendMessage(messages, 'assistant', blocks);
      continue;
    }

    if (role === 'tool' || role === 'function') {
      const id = item.tool_call_id || item.id;
      if (!id) throw new ChatCompletionsValidationError('tool message requires tool_call_id');
      appendMessage(messages, 'user', [{
        type: 'tool_result',
        tool_use_id: id,
        content: contentText(item.content),
        is_error: false,
      }]);
      continue;
    }
  }

  if (messages.length === 0) {
    throw new ChatCompletionsValidationError('messages must contain at least one user or assistant message');
  }

  return {
    messages,
    system: systemParts.join('\n\n') || undefined,
    tools: toolChoiceDropsTools(body.tool_choice) ? undefined : convertTools(body.tools),
    modelId: body.model,
  };
}

export function finishReason(stopReason, hasToolCalls) {
  if (hasToolCalls || stopReason === 'tool_use') return 'tool_calls';
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'refusal') return 'content_filter';
  return 'stop';
}

function usage(inputTokens, outputTokens) {
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  };
}

/** Anthropic content blocks → OpenAI assistant message. */
function assistantMessage(content = []) {
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  for (const block of content) {
    if (block?.type === 'text') text += block.text || '';
    else if (block?.type === 'thinking') reasoning += block.thinking || '';
    else if (block?.type === 'tool_use') {
      toolCalls.push({
        id: block.id || toolCallId(),
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
      });
    }
  }
  const message = { role: 'assistant', content: text || null, refusal: null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return { message, hasToolCalls: toolCalls.length > 0 };
}

export function buildChatCompletion({ request = {}, result, inputTokens, outputTokens, id, createdAt }) {
  const { message, hasToolCalls } = assistantMessage(result?.content);
  return {
    id: id || completionId(),
    object: 'chat.completion',
    created: createdAt || Math.floor(Date.now() / 1000),
    model: request.model || 'q-developer',
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: finishReason(result?.stopReason, hasToolCalls),
    }],
    usage: usage(inputTokens, outputTokens),
    system_fingerprint: null,
  };
}

export class ChatCompletionsStreamAdapter {
  constructor(request = {}, options = {}) {
    this.id = options.id || completionId();
    this.created = options.createdAt || Math.floor(Date.now() / 1000);
    this.model = request.model || 'q-developer';
    this.includeUsage = request.stream_options?.include_usage === true;
    this.toolCallIndex = 0;
    this.hasToolCalls = false;
    this.stopReason = undefined;
    this.summary = undefined;
    this.meteringUsage = undefined;
  }

  chunk(delta, { finish_reason = null } = {}) {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason }],
      ...(this.includeUsage ? { usage: null } : {}),
    };
  }

  start() {
    return [this.chunk({ role: 'assistant', content: '' })];
  }

  push(chunk) {
    if (chunk.type === 'content') {
      return chunk.content ? [this.chunk({ content: chunk.content })] : [];
    }
    if (chunk.type === 'thinking') {
      return chunk.text ? [this.chunk({ reasoning_content: chunk.text })] : [];
    }
    if (chunk.type === 'tool_use_end') {
      this.hasToolCalls = true;
      const index = this.toolCallIndex++;
      return [this.chunk({
        tool_calls: [{
          index,
          id: chunk.toolUseId || toolCallId(),
          type: 'function',
          function: { name: chunk.name, arguments: JSON.stringify(chunk.input || {}) },
        }],
      })];
    }
    if (chunk.type === 'stop_reason') {
      this.stopReason = chunk.stopReason;
      return [];
    }
    if (chunk.type === 'summary') {
      this.summary = chunk.stats;
      this.meteringUsage = chunk.meteringUsage;
    }
    return [];
  }

  complete({ inputTokens, outputTokens }) {
    const events = [this.chunk({}, { finish_reason: finishReason(this.stopReason, this.hasToolCalls) })];
    if (this.includeUsage) {
      events.push({
        id: this.id,
        object: 'chat.completion.chunk',
        created: this.created,
        model: this.model,
        choices: [],
        usage: usage(inputTokens, outputTokens),
      });
    }
    return events;
  }

  error(message) {
    return { error: { message, type: 'server_error', param: null, code: null } };
  }
}
