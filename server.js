#!/usr/bin/env node
import express from 'express';
import crypto from 'crypto';
import { getAccessToken } from './token-reader.js';
import { createClient, chat, chatStream, listAvailableModels } from './q-client.js';
import { c, log, tagLog, logSummary, reqId, tagError, tagWarn } from './logger.js';
import { countMessages, countContent } from './token-counter.js';
import { recordUsage, queryUsage, todaySummary } from './usage-tracker.js';
import { initGlobalProxy } from './proxy-config.js';
import {
  ResponseValidationError,
  ResponsesStreamAdapter,
  buildResponsesResponse,
  convertResponsesRequest,
} from './responses-api.js';
import {
  ChatCompletionsStreamAdapter,
  ChatCompletionsValidationError,
  buildChatCompletion,
  convertChatCompletionsRequest,
} from './chat-completions.js';
import {
  normalizeAnthropicModelOptions,
  normalizeChatCompletionsModelOptions,
  normalizeResponsesModelOptions,
  resolveAdditionalModelRequestFields,
} from './model-options.js';

const proxyUrl = initGlobalProxy();
if (proxyUrl) tagLog('proxy', `Using proxy: ${proxyUrl}`);

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3456;
const PROXY_API_KEY = process.env.PROXY_API_KEY;

function authMiddleware(req, res, next) {
  if (!PROXY_API_KEY) return next();
  const auth = req.headers['authorization'];
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token === PROXY_API_KEY) return next();
  res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid or missing API key' } });
}

app.use(authMiddleware);

let cachedClient = null;
let cachedToken = null;
let modelCatalogCache = null;
let modelCatalogPromise = null;
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;

async function getClient() {
  const tokenData = await getAccessToken();
  if (!cachedClient || cachedToken !== tokenData.accessToken) {
    cachedClient = createClient(tokenData.accessToken, {
      authMethod: tokenData.authMethod,
      profileArn: tokenData.profileArn,
      provider: tokenData.provider,
    });
    cachedToken = tokenData.accessToken;
  }
  return { client: cachedClient, tokenData };
}

async function getModelCatalog(tokenData) {
  if (modelCatalogCache?.accessToken === tokenData.accessToken && modelCatalogCache.expiresAt > Date.now()) {
    return modelCatalogCache.value;
  }
  if (modelCatalogPromise?.accessToken === tokenData.accessToken) return modelCatalogPromise.value;

  const value = listAvailableModels(tokenData.accessToken, {
    profileArn: tokenData.profileArn,
    authMethod: tokenData.authMethod,
    provider: tokenData.provider,
  }).then(result => {
    modelCatalogCache = {
      accessToken: tokenData.accessToken,
      expiresAt: Date.now() + MODEL_CATALOG_TTL_MS,
      value: result,
    };
    return result;
  }).finally(() => {
    modelCatalogPromise = null;
  });
  modelCatalogPromise = { accessToken: tokenData.accessToken, value };
  return value;
}

async function resolveModelRequestFields(tokenData, modelId, normalizedOptions) {
  if (!normalizedOptions || !modelId || modelId === 'auto') return undefined;
  try {
    const catalog = await getModelCatalog(tokenData);
    const model = catalog.models.find(item => item.modelId === modelId);
    return resolveAdditionalModelRequestFields(model?.additionalModelRequestFieldsSchema, normalizedOptions);
  } catch (error) {
    tagWarn('model-options', `Failed to resolve model effort: ${error.message}`);
    return undefined;
  }
}

function msgId() {
  return `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

// ============================================================
// POST /v1/messages — Anthropic Messages API (with tool support)
// ============================================================
app.post('/v1/messages', async (req, res) => {
  try {
    const { model, messages, system, tools, stream, max_tokens, tool_choice } = req.body;
    if (!messages?.length) {
      return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages required' } });
    }

    const { client, tokenData } = await getClient();
    const additionalModelRequestFields = await resolveModelRequestFields(
      tokenData,
      model,
      normalizeAnthropicModelOptions(req.body),
    );
    const opts = {
      messages,
      system,
      tools,
      profileArn: tokenData.profileArn,
      modelId: model,
      additionalModelRequestFields,
    };
    const rid = reqId();
    const start = Date.now();

    log('POST', '/v1/messages', rid, {
      model: model || 'default',
      stream: !!stream,
      messages: messages.length,
      tools: tools?.length || 0,
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const id = msgId();
      const usedModel = model || 'q-developer';
      let blockIndex = 0;
      let hasTextBlock = false;
      const inputTokens = countMessages(messages, system);

      // message_start
      const send = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

      send('message_start', {
        type: 'message_start',
        message: {
          id, type: 'message', role: 'assistant', content: [],
          model: usedModel, stop_reason: null, stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      });
      send('ping', { type: 'ping' });

      try {
        let hasToolUse = false;
        let hasThinkingBlock = false;
        let upstreamStopReason;
        let summary;
        const outputParts = [];

        for await (const chunk of chatStream(client, opts)) {
          if (chunk.type === 'thinking') {
            // 开启 thinking 块（如果还没有）
            if (!hasThinkingBlock) {
              send('content_block_start', {
                type: 'content_block_start', index: blockIndex,
                content_block: { type: 'thinking', thinking: '' },
              });
              hasThinkingBlock = true;
            }
            outputParts.push(chunk.text);
            send('content_block_delta', {
              type: 'content_block_delta', index: blockIndex,
              delta: { type: 'thinking_delta', thinking: chunk.text },
            });
          } else if (chunk.type === 'redacted_thinking') {
            if (hasThinkingBlock) {
              send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
              blockIndex++;
              hasThinkingBlock = false;
            }
            send('content_block_start', {
              type: 'content_block_start', index: blockIndex,
              content_block: { type: 'redacted_thinking', data: chunk.data },
            });
            send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            blockIndex++;
          } else if (chunk.type === 'thinking_signature') {
            // 关闭 thinking 块，附带 signature
            if (hasThinkingBlock) {
              send('content_block_delta', {
                type: 'content_block_delta', index: blockIndex,
                delta: { type: 'signature_delta', signature: chunk.signature },
              });
              send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
              blockIndex++;
              hasThinkingBlock = false;
            }
          } else if (chunk.type === 'content') {
            // 关闭未关闭的 thinking 块
            if (hasThinkingBlock) {
              send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
              blockIndex++;
              hasThinkingBlock = false;
            }
            // 开启文本块（如果还没有）
            if (!hasTextBlock) {
              send('content_block_start', {
                type: 'content_block_start', index: blockIndex,
                content_block: { type: 'text', text: '' },
              });
              hasTextBlock = true;
            }
            outputParts.push(chunk.content);
            send('content_block_delta', {
              type: 'content_block_delta', index: blockIndex,
              delta: { type: 'text_delta', text: chunk.content },
            });
          } else if (chunk.type === 'tool_use_start') {
            // 关闭之前的 thinking 块
            if (hasThinkingBlock) {
              send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
              blockIndex++;
              hasThinkingBlock = false;
            }
            // 关闭之前的文本块
            if (hasTextBlock) {
              send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
              blockIndex++;
              hasTextBlock = false;
            }
          } else if (chunk.type === 'tool_use_end') {
            hasToolUse = true;
            outputParts.push(JSON.stringify(chunk.input));
            // 发送完整的 tool_use content block
            send('content_block_start', {
              type: 'content_block_start', index: blockIndex,
              content_block: { type: 'tool_use', id: chunk.toolUseId, name: chunk.name, input: {} },
            });
            // 发送 input_json_delta（完整 JSON 一次性发送）
            send('content_block_delta', {
              type: 'content_block_delta', index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(chunk.input) },
            });
            send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            blockIndex++;
          } else if (chunk.type === 'summary') {
            summary = chunk.stats;
            if (typeof chunk.meteringUsage === 'number') recordUsage(chunk.meteringUsage, model);
          } else if (chunk.type === 'stop_reason') {
            upstreamStopReason = chunk.stopReason;
          }
        }

        // 关闭最后的 thinking 块
        if (hasThinkingBlock) {
          send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        }

        // 关闭最后的文本块
        if (hasTextBlock) {
          send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        }

        const stopReason = hasToolUse ? 'tool_use' : (upstreamStopReason || 'end_turn');
        const outputTokens = countContent(outputParts.join(''));
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
        send('message_stop', { type: 'message_stop' });
        res.end();
        const s = summary || {};
        s.estTokens = `~tokens: in=${inputTokens} out=${outputTokens}`;
        logSummary(rid, Date.now() - start, s);
      } catch (err) {
        tagError('stream', err.message);
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } })}\n\n`);
        res.end();
      }
    } else {
      // 非流式
      const result = await chat(client, opts);
      if (typeof result.meteringUsage === 'number') recordUsage(result.meteringUsage, model);
      const inputTokens = countMessages(messages, system);
      const outputTokens = countContent(result.content);
      const s = result.stats || {};
      s.estTokens = `~tokens: in=${inputTokens} out=${outputTokens}`;
      logSummary(rid, Date.now() - start, s);
      res.json({
        id: msgId(), type: 'message', role: 'assistant',
        content: result.content,
        model: model || 'q-developer',
        stop_reason: result.stopReason,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      });
    }
  } catch (err) {
    tagError('anthropic', err.message || err);
    const status = err.message?.includes('expired') ? 401 : 500;
    res.status(status).json({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'api_error', message: err.message } });
  }
});

// ============================================================
// POST /v1/responses — OpenAI Responses API compatible
// ============================================================
app.post('/v1/responses', async (req, res) => {
  try {
    const { model, stream } = req.body;
    const converted = convertResponsesRequest(req.body);
    const { messages, system, tools, modelId } = converted;

    const { client, tokenData } = await getClient();
    const additionalModelRequestFields = await resolveModelRequestFields(
      tokenData,
      modelId,
      normalizeResponsesModelOptions(req.body),
    );
    const opts = { messages, system, tools, profileArn: tokenData.profileArn, modelId, additionalModelRequestFields };
    const rid = reqId();
    const start = Date.now();

    log('POST', '/v1/responses', rid, {
      model: model || 'default',
      stream: !!stream,
      messages: messages.length,
      tools: tools?.length || 0,
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const inputTokens = countMessages(messages, system);
      const outputParts = [];
      const adapter = new ResponsesStreamAdapter(req.body);
      const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      for (const event of adapter.start()) send(event);

      try {
        for await (const chunk of chatStream(client, opts)) {
          if (chunk.type === 'content') outputParts.push(chunk.content);
          else if (chunk.type === 'thinking') outputParts.push(chunk.text);
          else if (chunk.type === 'tool_use_end') outputParts.push(JSON.stringify(chunk.input));
          else if (chunk.type === 'summary' && typeof chunk.meteringUsage === 'number') {
            recordUsage(chunk.meteringUsage, model);
          }
          for (const event of adapter.push(chunk)) send(event);
        }
        const outputTokens = countContent(outputParts.join(''));
        for (const event of adapter.complete({ inputTokens, outputTokens })) send(event);
        res.end();
        const summary = adapter.summary || {};
        summary.estTokens = `~tokens: in=${inputTokens} out=${outputTokens}`;
        logSummary(rid, Date.now() - start, summary);
      } catch (err) {
        tagError('responses-stream', err.message || err);
        send(adapter.event('error', {
          error: { type: 'server_error', code: 'server_error', message: err.message, param: null },
        }));
        res.end();
      }
    } else {
      const result = await chat(client, opts);
      if (typeof result.meteringUsage === 'number') recordUsage(result.meteringUsage, model);
      const inputTokens = countMessages(messages, system);
      const outputTokens = countContent(result.content);
      const s = result.stats || {};
      s.estTokens = `~tokens: in=${inputTokens} out=${outputTokens}`;
      logSummary(rid, Date.now() - start, s);
      const response = buildResponsesResponse({ request: req.body, result, inputTokens, outputTokens });
      res.json(response);
    }
  } catch (err) {
    tagError('responses', err.message || err);
    const status = err instanceof ResponseValidationError ? err.status : (err.message?.includes('expired') ? 401 : 500);
    res.status(status).json({
      error: {
        message: err.message,
        type: status === 400 ? 'invalid_request_error' : (status === 401 ? 'authentication_error' : 'server_error'),
        param: null,
        code: status === 400 ? 'invalid_request' : null,
      },
    });
  }
});

// ============================================================
// POST /v1/chat/completions — OpenAI Chat Completions compatible
// ============================================================
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, stream } = req.body;
    const { messages, system, tools, modelId } = convertChatCompletionsRequest(req.body);

    const { client, tokenData } = await getClient();
    const additionalModelRequestFields = await resolveModelRequestFields(
      tokenData,
      modelId,
      normalizeChatCompletionsModelOptions(req.body),
    );
    const opts = { messages, system, tools, profileArn: tokenData.profileArn, modelId, additionalModelRequestFields };
    const rid = reqId();
    const start = Date.now();

    log('POST', '/v1/chat/completions', rid, {
      model: model || 'default',
      stream: !!stream,
      messages: messages.length,
      tools: tools?.length || 0,
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const inputTokens = countMessages(messages, system);
      const outputParts = [];
      const adapter = new ChatCompletionsStreamAdapter(req.body);
      const send = chunk => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      for (const chunk of adapter.start()) send(chunk);

      try {
        for await (const chunk of chatStream(client, opts)) {
          if (chunk.type === 'content') outputParts.push(chunk.content);
          else if (chunk.type === 'thinking') outputParts.push(chunk.text);
          else if (chunk.type === 'tool_use_end') outputParts.push(JSON.stringify(chunk.input));
          else if (chunk.type === 'summary' && typeof chunk.meteringUsage === 'number') {
            recordUsage(chunk.meteringUsage, model);
          }
          for (const event of adapter.push(chunk)) send(event);
        }
        const outputTokens = countContent(outputParts.join(''));
        for (const event of adapter.complete({ inputTokens, outputTokens })) send(event);
        res.write('data: [DONE]\n\n');
        res.end();
        const summary = adapter.summary || {};
        summary.estTokens = `~tokens: in=${inputTokens} out=${outputTokens}`;
        logSummary(rid, Date.now() - start, summary);
      } catch (err) {
        tagError('chat-completions-stream', err.message || err);
        send(adapter.error(err.message));
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } else {
      const result = await chat(client, opts);
      if (typeof result.meteringUsage === 'number') recordUsage(result.meteringUsage, model);
      const inputTokens = countMessages(messages, system);
      const outputTokens = countContent(result.content);
      const s = result.stats || {};
      s.estTokens = `~tokens: in=${inputTokens} out=${outputTokens}`;
      logSummary(rid, Date.now() - start, s);
      res.json(buildChatCompletion({ request: req.body, result, inputTokens, outputTokens }));
    }
  } catch (err) {
    tagError('chat-completions', err.message || err);
    const status = err instanceof ChatCompletionsValidationError
      ? err.status
      : (err.message?.includes('expired') ? 401 : 500);
    res.status(status).json({
      error: {
        message: err.message,
        type: status === 400 ? 'invalid_request_error' : (status === 401 ? 'authentication_error' : 'server_error'),
        param: null,
        code: status === 400 ? 'invalid_request' : null,
      },
    });
  }
});

// ============================================================
// GET /v1/models
// ============================================================
app.get('/v1/models', async (_req, res) => {
  try {
    const tokenData = await getAccessToken();
    const { models, defaultModel } = await getModelCatalog(tokenData);
    res.json({
      object: 'list',
      data: models.map(m => ({
        id: m.modelId, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'amazon',
        name: m.modelName || m.modelId, description: m.description,
        is_default: defaultModel?.modelId === m.modelId,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.get('/q/models', async (_req, res) => {
  try {
    const tokenData = await getAccessToken();
    const result = await getModelCatalog(tokenData);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.get('/health', async (_req, res) => {
  try {
    const tokenData = await getAccessToken();
    const expired = tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date();
    res.json({ status: expired ? 'token_expired' : 'ok', provider: tokenData.provider || 'unknown', expiresAt: tokenData.expiresAt });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// ============================================================
// GET /credits — Usage statistics
// ============================================================
app.get('/credits', (_req, res) => {
  const period = _req.query.period || 'today';
  res.json(queryUsage(period));
});

app.listen(PORT, async () => {
  console.log(`${c.cyan}Kiro Proxy${c.reset} running on ${c.green}http://localhost:${PORT}${c.reset}`);
  console.log(`  ${c.gray}Anthropic:${c.reset} http://localhost:${PORT}/v1/messages`);
  console.log(`  ${c.gray}OpenAI:   ${c.reset} http://localhost:${PORT}/v1/responses`);
  console.log(`  ${c.gray}OpenAI:   ${c.reset} http://localhost:${PORT}/v1/chat/completions`);
  console.log(`  ${c.gray}Models:   ${c.reset} http://localhost:${PORT}/v1/models`);
  console.log(`  ${c.gray}Credits: ${c.reset} http://localhost:${PORT}/credits`);
  console.log(`  ${c.gray}Auth:     ${c.reset} ${PROXY_API_KEY ? `${c.green}enabled${c.reset} (PROXY_API_KEY)` : `${c.yellow}disabled${c.reset} (no PROXY_API_KEY set)`}`);
  try {
    const t = await getAccessToken();
    console.log(`  ${c.gray}Provider: ${c.yellow}${t.provider || 'unknown'}${c.reset}, Expires: ${c.dim}${t.expiresAt || 'unknown'}${c.reset}`);
  } catch (err) {
    console.warn(`  ${c.yellow}Warning:${c.reset} ${err.message}`);
  }
});

function shutdown() {
  const today = todaySummary();
  if (today.requests > 0) {
    console.log(`\n${c.cyan}Today:${c.reset} ${c.yellow}${today.credits.toFixed(4)} credits${c.reset} (${today.requests} requests)`);
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
