import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChatCompletionsStreamAdapter,
  ChatCompletionsValidationError,
  buildChatCompletion,
  convertChatCompletionsRequest,
} from '../chat-completions.js';
import { normalizeChatCompletionsModelOptions } from '../model-options.js';

test('将 Chat Completions messages、tool_calls 和 tool 结果转换为 Anthropic 会话', () => {
  const converted = convertChatCompletionsRequest({
    model: 'claude-sonnet-4.6',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'developer', content: 'Repository rules.' },
      { role: 'user', content: 'Read package.json' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'exec_command',
        description: 'Run a command',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
      },
    }],
  });

  assert.equal(converted.modelId, 'claude-sonnet-4.6');
  assert.equal(converted.system, 'You are helpful.\n\nRepository rules.');
  assert.deepEqual(converted.tools, [{
    name: 'exec_command',
    description: 'Run a command',
    input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
  }]);
  assert.deepEqual(converted.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Read package.json' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'exec_command', input: { cmd: 'pwd' } }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'ok', is_error: false },
        { type: 'text', text: 'Continue' },
      ],
    },
  ]);
});

test('data URL 图片被转换，普通 URL 图片报 400', () => {
  const converted = convertChatCompletionsRequest({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ],
    }],
  });
  assert.deepEqual(converted.messages, [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this' },
      { type: 'image', source: { type: 'url', url: 'data:image/png;base64,AAA' } },
    ],
  }]);

  assert.throws(
    () => convertChatCompletionsRequest({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }],
    }),
    ChatCompletionsValidationError,
  );
});

test('messages 缺失或为空时报 400', () => {
  assert.throws(() => convertChatCompletionsRequest({}), ChatCompletionsValidationError);
  assert.throws(() => convertChatCompletionsRequest({ messages: [] }), ChatCompletionsValidationError);
  assert.throws(
    () => convertChatCompletionsRequest({ messages: [{ role: 'system', content: 'only system' }] }),
    ChatCompletionsValidationError,
  );
});

test('tool_choice = none 时丢弃工具', () => {
  const converted = convertChatCompletionsRequest({
    messages: [{ role: 'user', content: 'hi' }],
    tool_choice: 'none',
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
  });
  assert.equal(converted.tools, undefined);
});

test('非流式响应包含 thinking、文本与 tool_calls', () => {
  const response = buildChatCompletion({
    request: { model: 'claude-sonnet-4.6' },
    result: {
      content: [
        { type: 'thinking', thinking: 'let me think', signature: 'sig' },
        { type: 'text', text: 'Running it.' },
        { type: 'tool_use', id: 'call_9', name: 'exec_command', input: { cmd: 'ls' } },
      ],
      stopReason: 'tool_use',
    },
    inputTokens: 12,
    outputTokens: 5,
  });

  assert.equal(response.object, 'chat.completion');
  assert.match(response.id, /^chatcmpl-/);
  assert.equal(response.model, 'claude-sonnet-4.6');
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
  assert.equal(response.choices[0].message.content, 'Running it.');
  assert.equal(response.choices[0].message.reasoning_content, 'let me think');
  assert.deepEqual(response.choices[0].message.tool_calls, [{
    id: 'call_9',
    type: 'function',
    function: { name: 'exec_command', arguments: '{"cmd":"ls"}' },
  }]);
  assert.equal(response.usage.prompt_tokens, 12);
  assert.equal(response.usage.completion_tokens, 5);
  assert.equal(response.usage.total_tokens, 17);
});

test('max_tokens 停止原因映射为 length，纯文本回复 content 为字符串', () => {
  const response = buildChatCompletion({
    request: {},
    result: { content: [{ type: 'text', text: 'hello' }], stopReason: 'max_tokens' },
    inputTokens: 1,
    outputTokens: 1,
  });
  assert.equal(response.choices[0].finish_reason, 'length');
  assert.equal(response.choices[0].message.content, 'hello');
  assert.equal(response.choices[0].message.tool_calls, undefined);
});

test('流式适配器输出 role → reasoning → content → tool_calls → finish_reason', () => {
  const adapter = new ChatCompletionsStreamAdapter({ model: 'claude-sonnet-4.6' });
  const chunks = [
    ...adapter.start(),
    ...adapter.push({ type: 'thinking', text: 'hmm' }),
    ...adapter.push({ type: 'content', content: 'Hi' }),
    ...adapter.push({ type: 'content', content: ' there' }),
    ...adapter.push({ type: 'tool_use_end', toolUseId: 'call_1', name: 'exec_command', input: { cmd: 'pwd' } }),
    ...adapter.push({ type: 'stop_reason', stopReason: 'end_turn' }),
    ...adapter.complete({ inputTokens: 3, outputTokens: 4 }),
  ];

  assert.deepEqual(chunks.map(chunk => chunk.choices[0].delta), [
    { role: 'assistant', content: '' },
    { reasoning_content: 'hmm' },
    { content: 'Hi' },
    { content: ' there' },
    { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' } }] },
    {},
  ]);
  assert.ok(chunks.every(chunk => chunk.object === 'chat.completion.chunk'));
  assert.ok(chunks.slice(0, -1).every(chunk => chunk.choices[0].finish_reason === null));
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.ok(chunks.every(chunk => !('usage' in chunk)));
});

test('include_usage 时追加一个只带 usage 的空 choices 分片', () => {
  const adapter = new ChatCompletionsStreamAdapter({ stream_options: { include_usage: true } });
  const chunks = [
    ...adapter.start(),
    ...adapter.push({ type: 'content', content: 'ok' }),
    ...adapter.complete({ inputTokens: 7, outputTokens: 2 }),
  ];
  assert.ok(chunks.slice(0, -1).every(chunk => chunk.usage === null));
  const last = chunks.at(-1);
  assert.deepEqual(last.choices, []);
  assert.equal(last.usage.prompt_tokens, 7);
  assert.equal(last.usage.completion_tokens, 2);
  assert.equal(last.usage.total_tokens, 9);
  assert.equal(chunks.at(-2).choices[0].finish_reason, 'stop');
});

test('reasoning_effort 归一化为 effort 选项', () => {
  assert.deepEqual(normalizeChatCompletionsModelOptions({ reasoning_effort: 'high' }), { effort: 'high' });
  assert.deepEqual(normalizeChatCompletionsModelOptions({ reasoning: { effort: 'low' } }), { effort: 'low' });
  assert.equal(normalizeChatCompletionsModelOptions({}), undefined);
});
