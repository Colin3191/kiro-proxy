import crypto from 'node:crypto';

const REASONING_PREFIX = 'kiro:v1:';

export class ResponseValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResponseValidationError';
    this.status = 400;
  }
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    return '';
  }).join('');
}

function stringifyOutput(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return contentText(output) || JSON.stringify(output);
  if (output == null) return '';
  return JSON.stringify(output);
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

function inputContentToAnthropic(content, role) {
  const parts = typeof content === 'string' ? [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }] : content;
  if (!Array.isArray(parts)) return [];
  const converted = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      converted.push({ type: 'text', text: part });
      continue;
    }
    if (['input_text', 'output_text', 'text', 'refusal'].includes(part?.type) && typeof part.text === 'string') {
      converted.push({ type: 'text', text: part.text });
      continue;
    }
    if (part?.type === 'input_image') {
      if (!part.image_url?.startsWith('data:')) {
        throw new ResponseValidationError('Only data URL input_image values are supported');
      }
      converted.push({ type: 'image', source: { type: 'url', url: part.image_url } });
    }
  }
  return converted;
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

export function encodeKiroReasoning(value) {
  return `${REASONING_PREFIX}${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
}

export function decodeKiroReasoning(value) {
  if (typeof value !== 'string' || !value.startsWith(REASONING_PREFIX)) return undefined;
  try {
    return JSON.parse(Buffer.from(value.slice(REASONING_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

function requestTools(body, input) {
  const tools = Array.isArray(body.tools) ? [...body.tools] : [];
  for (const item of input) {
    if (item?.type === 'additional_tools' && Array.isArray(item.tools)) tools.push(...item.tools);
  }
  const seen = new Set();
  return tools.filter(tool => {
    const key = `${tool?.type || 'function'}:${tool?.name || ''}`;
    if (!tool?.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = tools
    .filter(tool => (!tool.type || tool.type === 'function' || tool.type === 'custom') && typeof tool.name === 'string' && tool.name.length > 0)
    .map(tool => tool.type === 'custom' ? {
      name: tool.name,
      description: `Pass the custom tool input in the \`input\` string field.\n\n${tool.description?.trim() || tool.name}`,
      input_schema: {
        type: 'object',
        properties: { input: { type: 'string', description: 'Raw custom tool input.' } },
        required: ['input'],
      },
    } : {
      name: tool.name,
      description: tool.description?.trim() || tool.name,
      input_schema: tool.parameters || { type: 'object', properties: {} },
    });
  return converted.length > 0 ? converted : undefined;
}

function customToolNames(request) {
  const input = Array.isArray(request.input) ? request.input : [];
  return new Set(requestTools(request, input).filter(tool => tool.type === 'custom').map(tool => tool.name));
}

function customToolInput(input) {
  if (typeof input === 'string') return input;
  if (typeof input?.input === 'string') return input.input;
  if (typeof input?.raw === 'string') return input.raw;
  return JSON.stringify(input ?? '');
}

export function convertResponsesRequest(body = {}) {
  if (body.input == null) throw new ResponseValidationError('input is required');

  const messages = [];
  const systemParts = [];
  if (typeof body.instructions === 'string' && body.instructions.length > 0) systemParts.push(body.instructions);
  const input = typeof body.input === 'string'
    ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }]
    : body.input;
  if (!Array.isArray(input)) throw new ResponseValidationError('input must be a string or an array');

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' || (!item.type && item.role)) {
      if (item.role === 'system' || item.role === 'developer') {
        const text = contentText(item.content);
        if (text) systemParts.push(text);
      } else if (item.role === 'user' || item.role === 'assistant') {
        appendMessage(messages, item.role, inputContentToAnthropic(item.content, item.role));
      }
      continue;
    }
    if (item.type === 'function_call') {
      appendMessage(messages, 'assistant', [{
        type: 'tool_use',
        id: item.call_id || item.id || randomId('call'),
        name: item.name,
        input: parseArguments(item.arguments),
      }]);
      continue;
    }
    if (item.type === 'custom_tool_call') {
      appendMessage(messages, 'assistant', [{
        type: 'tool_use',
        id: item.call_id || item.id || randomId('call'),
        name: item.name,
        input: { input: item.input || '' },
      }]);
      continue;
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      appendMessage(messages, 'user', [{
        type: 'tool_result',
        tool_use_id: item.call_id,
        content: stringifyOutput(item.output),
        is_error: item.status === 'failed' || item.status === 'incomplete',
      }]);
      continue;
    }
    if (item.type === 'reasoning') {
      const reasoning = decodeKiroReasoning(item.encrypted_content);
      if (reasoning?.redacted) {
        appendMessage(messages, 'assistant', [{ type: 'redacted_thinking', data: reasoning.redacted }]);
      } else if (reasoning?.text) {
        appendMessage(messages, 'assistant', [{
          type: 'thinking',
          thinking: reasoning.text,
          signature: reasoning.signature || '',
        }]);
      }
    }
  }

  if (messages.length === 0) throw new ResponseValidationError('input must contain at least one user or assistant message');
  return {
    messages,
    system: systemParts.join('\n\n') || undefined,
    tools: convertTools(requestTools(body, input)),
    modelId: body.model,
  };
}

function usage(inputTokens, outputTokens) {
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  };
}

function responseBase(request, { id = randomId('resp'), createdAt = Math.floor(Date.now() / 1000), status = 'completed' } = {}) {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: request.instructions ?? null,
    max_output_tokens: request.max_output_tokens ?? null,
    model: request.model || 'q-developer',
    output: [],
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    previous_response_id: request.previous_response_id ?? null,
    reasoning: request.reasoning ?? null,
    store: request.store ?? false,
    temperature: request.temperature ?? null,
    text: request.text ?? { format: { type: 'text' } },
    tool_choice: request.tool_choice ?? 'auto',
    tools: request.tools ?? [],
    top_p: request.top_p ?? null,
    truncation: request.truncation ?? 'disabled',
    usage: null,
    user: request.user ?? null,
    metadata: request.metadata ?? {},
  };
}

function reasoningItem(block) {
  const redacted = block.type === 'redacted_thinking' ? block.data : undefined;
  const text = block.type === 'thinking' ? block.thinking : '';
  return {
    id: randomId('rs'),
    type: 'reasoning',
    summary: text ? [{ type: 'summary_text', text }] : [],
    encrypted_content: encodeKiroReasoning(redacted ? { redacted } : { text, signature: block.signature || '' }),
    status: 'completed',
  };
}

function outputItems(content = [], request = {}) {
  const customNames = customToolNames(request);
  const output = [];
  for (const block of content) {
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      output.push(reasoningItem(block));
    } else if (block.type === 'text') {
      const previous = output.at(-1);
      if (previous?.type === 'message') {
        previous.content[0].text += block.text || '';
      } else {
        output.push({
          id: randomId('msg'),
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: block.text || '', annotations: [], logprobs: [] }],
        });
      }
    } else if (block.type === 'tool_use') {
      if (customNames.has(block.name)) {
        output.push({
          id: randomId('ctc'),
          type: 'custom_tool_call',
          status: 'completed',
          call_id: block.id,
          name: block.name,
          input: customToolInput(block.input),
        });
      } else {
        output.push({
          id: randomId('fc'),
          type: 'function_call',
          status: 'completed',
          arguments: JSON.stringify(block.input || {}),
          call_id: block.id,
          name: block.name,
        });
      }
    }
  }
  return output;
}

export function buildResponsesResponse({ request, result, inputTokens, outputTokens, id, createdAt }) {
  const response = responseBase(request, { id, createdAt });
  response.output = outputItems(result.content, request);
  response.usage = usage(inputTokens, outputTokens);
  return response;
}

export class ResponsesStreamAdapter {
  constructor(request, options = {}) {
    this.response = responseBase(request, { ...options, status: 'in_progress' });
    this.customToolNames = customToolNames(request);
    this.sequenceNumber = 0;
    this.pendingReasoning = null;
    this.activeMessage = null;
    this.summary = undefined;
    this.meteringUsage = undefined;
  }

  event(type, fields = {}) {
    return { type, sequence_number: this.sequenceNumber++, ...fields };
  }

  start() {
    return [this.event('response.created', { response: structuredClone(this.response) })];
  }

  push(chunk) {
    if (chunk.type === 'thinking') {
      this.pendingReasoning ||= { text: '', signature: '', redacted: undefined };
      this.pendingReasoning.text += chunk.text || '';
      return [];
    }
    if (chunk.type === 'thinking_signature') {
      this.pendingReasoning ||= { text: '', signature: '', redacted: undefined };
      this.pendingReasoning.signature = chunk.signature || '';
      return [];
    }
    if (chunk.type === 'redacted_thinking') {
      this.pendingReasoning ||= { text: '', signature: '', redacted: undefined };
      this.pendingReasoning.redacted = chunk.data;
      return [];
    }
    if (chunk.type === 'content') {
      const events = this.flushReasoning();
      events.push(...this.ensureMessage());
      this.activeMessage.text += chunk.content || '';
      events.push(this.event('response.output_text.delta', {
        item_id: this.activeMessage.item.id,
        output_index: this.activeMessage.outputIndex,
        content_index: 0,
        delta: chunk.content || '',
        logprobs: [],
      }));
      return events;
    }
    if (chunk.type === 'tool_use_end') {
      const events = [...this.flushReasoning(), ...this.finishMessage()];
      if (this.customToolNames.has(chunk.name)) {
        const input = customToolInput(chunk.input);
        const outputIndex = this.response.output.length;
        const item = {
          id: randomId('ctc'),
          type: 'custom_tool_call',
          status: 'completed',
          call_id: chunk.toolUseId,
          name: chunk.name,
          input,
        };
        this.response.output.push(item);
        events.push(this.event('response.output_item.added', {
          output_index: outputIndex,
          item: { ...item, status: 'in_progress', input: '' },
        }));
        events.push(this.event('response.custom_tool_call_input.delta', {
          item_id: item.id,
          output_index: outputIndex,
          delta: input,
        }));
        events.push(this.event('response.custom_tool_call_input.done', {
          item_id: item.id,
          output_index: outputIndex,
          input,
        }));
        events.push(this.event('response.output_item.done', { output_index: outputIndex, item: structuredClone(item) }));
        return events;
      }
      const argumentsText = JSON.stringify(chunk.input || {});
      const outputIndex = this.response.output.length;
      const item = {
        id: randomId('fc'),
        type: 'function_call',
        status: 'completed',
        arguments: argumentsText,
        call_id: chunk.toolUseId,
        name: chunk.name,
      };
      this.response.output.push(item);
      events.push(this.event('response.output_item.added', {
        output_index: outputIndex,
        item: { ...item, status: 'in_progress', arguments: '' },
      }));
      events.push(this.event('response.function_call_arguments.delta', {
        item_id: item.id,
        output_index: outputIndex,
        delta: argumentsText,
      }));
      events.push(this.event('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: outputIndex,
        arguments: argumentsText,
      }));
      events.push(this.event('response.output_item.done', { output_index: outputIndex, item: structuredClone(item) }));
      return events;
    }
    if (chunk.type === 'summary') {
      this.summary = chunk.stats;
      this.meteringUsage = chunk.meteringUsage;
    }
    return [];
  }

  flushReasoning() {
    if (!this.pendingReasoning) return [];
    const reasoning = this.pendingReasoning;
    this.pendingReasoning = null;
    const outputIndex = this.response.output.length;
    const item = {
      id: randomId('rs'),
      type: 'reasoning',
      summary: reasoning.text ? [{ type: 'summary_text', text: reasoning.text }] : [],
      encrypted_content: encodeKiroReasoning(reasoning.redacted
        ? { redacted: reasoning.redacted }
        : { text: reasoning.text, signature: reasoning.signature }),
      status: 'completed',
    };
    this.response.output.push(item);
    const events = [this.event('response.output_item.added', {
      output_index: outputIndex,
      item: { ...item, status: 'in_progress', summary: [] },
    })];
    if (reasoning.text) {
      const emptyPart = { type: 'summary_text', text: '' };
      events.push(this.event('response.reasoning_summary_part.added', {
        item_id: item.id, output_index: outputIndex, summary_index: 0, part: emptyPart,
      }));
      events.push(this.event('response.reasoning_summary_text.delta', {
        item_id: item.id, output_index: outputIndex, summary_index: 0, delta: reasoning.text,
      }));
      events.push(this.event('response.reasoning_summary_text.done', {
        item_id: item.id, output_index: outputIndex, summary_index: 0, text: reasoning.text,
      }));
      events.push(this.event('response.reasoning_summary_part.done', {
        item_id: item.id, output_index: outputIndex, summary_index: 0, part: item.summary[0],
      }));
    }
    events.push(this.event('response.output_item.done', { output_index: outputIndex, item: structuredClone(item) }));
    return events;
  }

  ensureMessage() {
    if (this.activeMessage) return [];
    const outputIndex = this.response.output.length;
    const item = {
      id: randomId('msg'),
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [],
    };
    this.activeMessage = { item, outputIndex, text: '' };
    return [
      this.event('response.output_item.added', { output_index: outputIndex, item: structuredClone(item) }),
      this.event('response.content_part.added', {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
      }),
    ];
  }

  finishMessage() {
    if (!this.activeMessage) return [];
    const active = this.activeMessage;
    this.activeMessage = null;
    const part = { type: 'output_text', text: active.text, annotations: [], logprobs: [] };
    const item = { ...active.item, status: 'completed', content: [part] };
    this.response.output.push(item);
    return [
      this.event('response.output_text.done', {
        item_id: item.id, output_index: active.outputIndex, content_index: 0, text: active.text, logprobs: [],
      }),
      this.event('response.content_part.done', {
        item_id: item.id, output_index: active.outputIndex, content_index: 0, part: structuredClone(part),
      }),
      this.event('response.output_item.done', { output_index: active.outputIndex, item: structuredClone(item) }),
    ];
  }

  complete({ inputTokens, outputTokens }) {
    const events = [...this.flushReasoning(), ...this.finishMessage()];
    this.response.status = 'completed';
    this.response.usage = usage(inputTokens, outputTokens);
    events.push(this.event('response.completed', { response: structuredClone(this.response) }));
    return events;
  }
}
