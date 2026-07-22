import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ResponsesStreamAdapter,
  buildResponsesResponse,
  convertResponsesRequest,
  decodeKiroReasoning,
} from '../responses-api.js';

test('将 Codex Responses input、函数调用和工具结果转换为 Anthropic 会话', () => {
  const converted = convertResponsesRequest({
    model: 'claude-sonnet-4.6',
    instructions: 'You are Codex.',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Repository rules.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read package.json' }] },
      { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue' }] },
    ],
    tools: [
      {
        type: 'function',
        name: 'exec_command',
        description: 'Run a command',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
      },
    ],
  });

  assert.equal(converted.modelId, 'claude-sonnet-4.6');
  assert.equal(converted.system, 'You are Codex.\n\nRepository rules.');
  assert.deepEqual(converted.tools, [{
    name: 'exec_command',
    description: 'Run a command',
    input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
  }]);
  assert.deepEqual(converted.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Read package.json' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'exec_command', input: { cmd: 'pwd' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok', is_error: false }, { type: 'text', text: 'Continue' }] },
  ]);
});

test('Responses 内置工具不会被伪装成客户端函数工具', () => {
  const converted = convertResponsesRequest({
    input: 'hello',
    tools: [{ type: 'web_search' }, { type: 'function', name: 'read_file', parameters: { type: 'object' } }],
  });
  assert.deepEqual(converted.tools, [{
    name: 'read_file',
    description: 'read_file',
    input_schema: { type: 'object' },
  }]);
});

test('Codex additional_tools custom 工具转换并回放工具结果', () => {
  const converted = convertResponsesRequest({
    input: [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [{
          type: 'custom',
          name: 'exec',
          description: 'Run JavaScript',
          format: { type: 'grammar', syntax: 'lark', definition: 'start: /[\\s\\S]+/' },
        }],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run pwd' }] },
      { type: 'custom_tool_call', call_id: 'call_custom', name: 'exec', input: 'await tools.exec_command({cmd: "pwd"})' },
      { type: 'custom_tool_call_output', call_id: 'call_custom', output: '/repo' },
    ],
  });

  assert.deepEqual(converted.tools, [{
    name: 'exec',
    description: 'Pass the custom tool input in the `input` string field.\n\nRun JavaScript',
    input_schema: {
      type: 'object',
      properties: { input: { type: 'string', description: 'Raw custom tool input.' } },
      required: ['input'],
    },
  }]);
  assert.deepEqual(converted.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Run pwd' }] },
    { role: 'assistant', content: [{
      type: 'tool_use', id: 'call_custom', name: 'exec', input: { input: 'await tools.exec_command({cmd: "pwd"})' },
    }] },
    { role: 'user', content: [{
      type: 'tool_result', tool_use_id: 'call_custom', content: '/repo', is_error: false,
    }] },
  ]);
});

test('连续 user input items 合并时保留消息边界', () => {
  const converted = convertResponsesRequest({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context />' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply OK' }] },
    ],
  });
  assert.deepEqual(converted.messages, [{
    role: 'user',
    content: [
      { type: 'text', text: '<environment_context />' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: 'Reply OK' },
    ],
  }]);
});

test('非流式 Responses 输出包含文本、reasoning 和函数调用', () => {
  const response = buildResponsesResponse({
    request: { model: 'claude-sonnet-4.6', instructions: 'Be concise.', store: false },
    result: {
      content: [
        { type: 'thinking', thinking: 'Check files', signature: 'sig-1' },
        { type: 'text', text: 'Running it.' },
        { type: 'tool_use', id: 'call_1', name: 'exec_command', input: { cmd: 'pwd' } },
      ],
    },
    inputTokens: 10,
    outputTokens: 4,
    id: 'resp_test',
    createdAt: 123,
  });

  assert.equal(response.object, 'response');
  assert.equal(response.status, 'completed');
  assert.deepEqual(response.output.map(item => item.type), ['reasoning', 'message', 'function_call']);
  assert.equal(response.output[1].content[0].text, 'Running it.');
  assert.equal(response.output[2].call_id, 'call_1');
  assert.equal(response.output[2].arguments, '{"cmd":"pwd"}');
  assert.deepEqual(decodeKiroReasoning(response.output[0].encrypted_content), {
    text: 'Check files',
    signature: 'sig-1',
  });
  assert.deepEqual(response.usage, {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 4,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 14,
  });
});

test('custom 工具调用输出为 custom_tool_call', () => {
  const request = {
    model: 'gpt-test',
    input: [{
      type: 'additional_tools',
      role: 'developer',
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript' }],
    }],
  };
  const response = buildResponsesResponse({
    request,
    result: { content: [{
      type: 'tool_use', id: 'call_custom', name: 'exec', input: { input: 'text(1)' },
    }] },
    inputTokens: 1,
    outputTokens: 1,
  });

  assert.equal(response.output[0].type, 'custom_tool_call');
  assert.equal(response.output[0].input, 'text(1)');
  assert.equal(response.output[0].call_id, 'call_custom');
});

test('custom 工具流输出 custom_tool_call_input 事件', () => {
  const adapter = new ResponsesStreamAdapter({
    model: 'gpt-test',
    input: [{
      type: 'additional_tools',
      role: 'developer',
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript' }],
    }],
  });
  const events = adapter.push({
    type: 'tool_use_end', toolUseId: 'call_custom', name: 'exec', input: { input: 'text(1)' },
  });

  assert.deepEqual(events.map(event => event.type), [
    'response.output_item.added',
    'response.custom_tool_call_input.delta',
    'response.custom_tool_call_input.done',
    'response.output_item.done',
  ]);
  assert.equal(events.at(-1).item.type, 'custom_tool_call');
  assert.equal(events.at(-1).item.input, 'text(1)');
});

test('流式 Responses 生成 Codex 所需的文本和函数调用事件', () => {
  const adapter = new ResponsesStreamAdapter({ model: 'claude-sonnet-4.6', stream: true }, {
    id: 'resp_stream',
    createdAt: 123,
  });
  const events = [
    ...adapter.start(),
    ...adapter.push({ type: 'thinking', text: 'Think' }),
    ...adapter.push({ type: 'thinking_signature', signature: 'sig-2' }),
    ...adapter.push({ type: 'content', content: 'Hello' }),
    ...adapter.push({ type: 'tool_use_end', toolUseId: 'call_2', name: 'read_file', input: { path: 'a.js' } }),
    ...adapter.complete({ inputTokens: 3, outputTokens: 2 }),
  ];
  const types = events.map(event => event.type);

  assert.equal(types[0], 'response.created');
  assert.ok(types.includes('response.reasoning_summary_text.delta'));
  assert.ok(types.includes('response.output_text.delta'));
  assert.ok(types.includes('response.function_call_arguments.delta'));
  assert.equal(types.at(-1), 'response.completed');
  assert.deepEqual(events.at(-1).response.output.map(item => item.type), ['reasoning', 'message', 'function_call']);
});
