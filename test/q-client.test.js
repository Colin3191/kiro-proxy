import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConversationRequest, chatStream, listAvailableModels, normalizeConversation } from '../q-client.js';

test('默认按 Kiro feature config 的关闭状态将 system 注入历史', () => {
  const request = buildConversationRequest([
    { role: 'user', content: 'hello' },
  ], {
    system: 'You are Kiro.',
    modelId: 'model-1',
    agentMode: 'vibe',
  });

  assert.equal(request.systemPrompt, undefined);
  assert.equal(request.agentMode, 'vibe');
  assert.equal(request.conversationState.history[0].userInputMessage.content, 'You are Kiro.');
  assert.equal(request.conversationState.history[1].assistantResponseMessage.content, 'I will follow these instructions.');
  assert.equal(request.conversationState.currentMessage.userInputMessage.content, 'hello');
});

test('显式 field 模式才发送顶层 systemPrompt', () => {
  const request = buildConversationRequest([
    { role: 'user', content: 'hello' },
  ], {
    system: 'You are Kiro.',
    systemPromptMode: 'field',
  });
  assert.equal(request.systemPrompt, 'You are Kiro.');
  assert.equal(request.conversationState.history.length, 0);
});

test('工具描述为空时回退到工具名', () => {
  const request = buildConversationRequest([
    { role: 'user', content: 'use tool' },
  ], {
    tools: [{ name: 'read_file', description: '', input_schema: {} }],
  });
  const tools = request.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;
  assert.equal(tools[0].toolSpecification.description, 'read_file');
  assert.deepEqual(tools[0].toolSpecification.inputSchema.json, {
    type: 'object',
    properties: {},
  });
});

test('缺少部分工具结果时只补齐缺失 ID', () => {
  const normalized = normalizeConversation([
    { userInputMessage: { content: 'go', origin: 'AI_EDITOR' } },
    { assistantResponseMessage: { content: '', toolUses: [
      { toolUseId: 'a', name: 'one', input: {} },
      { toolUseId: 'b', name: 'two', input: {} },
    ] } },
    { userInputMessage: {
      content: '',
      origin: 'AI_EDITOR',
      userInputMessageContext: { toolResults: [
        { toolUseId: 'a', content: [{ text: 'ok' }], status: 'success' },
      ] },
    } },
  ], 'model-1');

  const results = normalized[2].userInputMessage.userInputMessageContext.toolResults;
  assert.deepEqual(results.map(result => result.toolUseId), ['a', 'b']);
  assert.equal(results[1].status, 'error');
});

test('无签名 thinking 不回放，有签名 thinking 会进入 reasoningContent', () => {
  const unsigned = buildConversationRequest([
    { role: 'user', content: 'question' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'answer' }] },
    { role: 'user', content: 'next' },
  ], { modelId: 'model-1' });
  assert.equal(unsigned.conversationState.history[1].assistantResponseMessage.reasoningContent, undefined);

  const signed = buildConversationRequest([
    { role: 'user', content: 'question' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'private', signature: 'sig' }, { type: 'text', text: 'answer' }] },
    { role: 'user', content: 'next' },
  ], { modelId: 'model-1' });
  assert.deepEqual(signed.conversationState.history[1].assistantResponseMessage.reasoningContent, {
    reasoningText: { text: 'private', signature: 'sig' },
  });
});

test('模型列表使用新版 control-plane 路由', async () => {
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.KIRO_CONTROL_PLANE_ENDPOINT;
  const calls = [];
  process.env.KIRO_CONTROL_PLANE_ENDPOINT = 'https://management.test.kiro.dev';
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      models: [{ modelId: 'model-1' }],
      defaultModel: { modelId: 'model-1' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await listAvailableModels('token', {
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/test',
      authMethod: 'external_idp',
    });
    assert.equal(result.models[0].modelId, 'model-1');
    assert.match(calls[0].url, /^https:\/\/management\.test\.kiro\.dev\/List-Available-Models\/\?/);
    assert.equal(calls[0].options.headers['x-amz-target'], 'KiroControlPlaneBearerService.ListAvailableModels');
    assert.equal(calls[0].options.headers.TokenType, 'EXTERNAL_IDP');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEndpoint === undefined) delete process.env.KIRO_CONTROL_PLANE_ENDPOINT;
    else process.env.KIRO_CONTROL_PLANE_ENDPOINT = originalEndpoint;
  }
});

test('thinking signature 无效时移除 reasoning 并重试一次', async () => {
  const inputs = [];
  const client = {
    async send(command) {
      inputs.push(command.input);
      if (inputs.length === 1) {
        return {
          generateAssistantResponseResponse: (async function* () {
            const error = new Error('invalid thinking signature');
            error.reason = 'THINKING_SIGNATURE_INVALID';
            throw error;
          })(),
        };
      }
      return {
        generateAssistantResponseResponse: (async function* () {
          yield { assistantResponseEvent: { content: 'ok', modelId: 'model-1' } };
        })(),
      };
    },
  };

  const events = [];
  for await (const event of chatStream(client, {
    modelId: 'model-1',
    messages: [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'private', signature: 'bad' }, { type: 'text', text: 'answer' }] },
      { role: 'user', content: 'next' },
    ],
  })) events.push(event);

  assert.equal(inputs.length, 2);
  assert.ok(inputs[0].conversationState.history[1].assistantResponseMessage.reasoningContent);
  assert.equal(inputs[1].conversationState.history[1].assistantResponseMessage.reasoningContent, undefined);
  assert.equal(events.find(event => event.type === 'content').content, 'ok');
});

test('顶层 systemPrompt 被服务端拒绝时自动回退到历史注入', async () => {
  const inputs = [];
  const client = {
    async send(command) {
      inputs.push(command.input);
      if (inputs.length === 1) {
        const error = new Error('Improperly formed request.');
        error.name = 'KiroRuntimeError';
        throw error;
      }
      return {
        generateAssistantResponseResponse: (async function* () {
          yield { assistantResponseEvent: { content: 'ok' } };
        })(),
      };
    },
  };

  for await (const _event of chatStream(client, {
    system: 'System rules',
    systemPromptMode: 'field',
    messages: [{ role: 'user', content: 'hello' }],
  })) { /* consume */ }

  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].systemPrompt, 'System rules');
  assert.equal(inputs[1].systemPrompt, undefined);
  assert.equal(inputs[1].conversationState.history[0].userInputMessage.content, 'System rules');
  assert.equal(inputs[1].conversationState.history[1].assistantResponseMessage.content, 'I will follow these instructions.');
});
