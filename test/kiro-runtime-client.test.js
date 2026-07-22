import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GenerateAssistantResponseCommand,
  KiroRuntimeClient,
  parseKiroEventStream,
} from '../kiro-runtime-client.js';

function stringHeader(name, value) {
  const nameBytes = Buffer.from(name);
  const valueBytes = Buffer.from(value);
  const header = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  let offset = 0;
  header.writeUInt8(nameBytes.length, offset++);
  nameBytes.copy(header, offset);
  offset += nameBytes.length;
  header.writeUInt8(7, offset++);
  header.writeUInt16BE(valueBytes.length, offset);
  offset += 2;
  valueBytes.copy(header, offset);
  return header;
}

function eventFrame(type, payload, { exception = false } = {}) {
  const headers = stringHeader(exception ? ':exception-type' : ':event-type', type);
  const body = Buffer.from(JSON.stringify(payload));
  const totalLength = 12 + headers.length + body.length + 4;
  const frame = Buffer.alloc(totalLength);
  frame.writeUInt32BE(totalLength, 0);
  frame.writeUInt32BE(headers.length, 4);
  // Prelude CRC at bytes 8..11 and message CRC at the end are deliberately
  // zeroed; Kiro's current client parser dispatches frames without CRC checks.
  headers.copy(frame, 12);
  body.copy(frame, 12 + headers.length);
  return frame;
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

test('解析跨 chunk 的 Kiro Runtime EventStream', async () => {
  const frame = eventFrame('assistantResponseEvent', { content: 'hello' });
  const chunks = [frame.subarray(0, 7), frame.subarray(7, 19), frame.subarray(19)];
  const events = await collect(parseKiroEventStream(chunks, 'req-1'));
  assert.deepEqual(events, [{ assistantResponseEvent: { content: 'hello' } }]);
});

test('EventStream 异常转换为带 reason 的错误', async () => {
  const frame = eventFrame('ValidationException', {
    message: 'bad request',
    reason: 'REQUEST_BODY_INVALID',
  }, { exception: true });

  await assert.rejects(
    async () => collect(parseKiroEventStream([frame], 'req-2')),
    error => error.name === 'ValidationException' &&
      error.reason === 'REQUEST_BODY_INVALID' &&
      error.$metadata.requestId === 'req-2',
  );
});

test('客户端发送新版请求体和认证 headers', async () => {
  let captured;
  const responseFrame = eventFrame('metadataEvent', { stopReason: 'end_turn' });
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return new Response(responseFrame, {
      status: 200,
      headers: {
        'x-amzn-requestid': 'req-3',
        'x-amzn-kiro-conversation-id': 'conversation-3',
      },
    });
  };
  const client = new KiroRuntimeClient({
    endpoint: 'https://runtime.us-east-1.kiro.dev',
    token: { token: 'secret' },
    authMethod: 'IdC',
    customUserAgent: 'kiro-ide/test',
    fetchImpl,
  });

  const output = await client.send(new GenerateAssistantResponseCommand({
    conversationState: { conversationId: 'local' },
    systemPrompt: 'system',
    agentMode: 'vibe',
  }));

  assert.equal(captured.url, 'https://runtime.us-east-1.kiro.dev/generateAssistantResponse/');
  assert.equal(captured.options.headers.authorization, 'Bearer secret');
  assert.equal(captured.options.headers['content-type'], 'application/x-amz-json-1.0');
  assert.equal(captured.options.headers['x-amz-target'], 'KiroRuntimeService.GenerateAssistantResponse');
  assert.equal(captured.options.headers.TokenType, 'SSO_OIDC');
  assert.equal(captured.options.headers['x-amzn-codewhisperer-optout'], 'true');
  assert.deepEqual(JSON.parse(captured.options.body), {
    conversationState: { conversationId: 'local' },
    systemPrompt: 'system',
    agentMode: 'vibe',
  });
  assert.equal(output.conversationId, 'conversation-3');
  assert.deepEqual(await collect(output.generateAssistantResponseResponse), [
    { metadataEvent: { stopReason: 'end_turn' } },
  ]);
});
