#!/usr/bin/env node
import express from 'express';
import crypto from 'crypto';
import { getAccessToken } from './token-reader.js';
import { createClient, chat, chatStream, listAvailableModels } from './q-client.js';
import { c, log, logSummary, reqId, tagError } from './logger.js';
import { countMessages, countContent } from './token-counter.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3456;

let cachedClient = null;
let cachedToken = null;

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
    const opts = { messages, system, tools, profileArn: tokenData.profileArn, modelId: model };
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

        const stopReason = hasToolUse ? 'tool_use' : 'end_turn';
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
// POST /v1/chat/completions — OpenAI compatible
// ============================================================
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages: rawMsgs, model, stream } = req.body;
    if (!rawMsgs?.length) return res.status(400).json({ error: 'messages required' });

    // 简单转换 OpenAI → Anthropic 格式
    let system;
    const messages = [];
    for (const m of rawMsgs) {
      if (m.role === 'system') { system = m.content; continue; }
      messages.push({ role: m.role, content: m.content });
    }

    const { client, tokenData } = await getClient();
    const opts = { messages, system, profileArn: tokenData.profileArn, modelId: model };
    const rid = reqId();
    const start = Date.now();

    log('POST', '/v1/chat/completions', rid, {
      model: model || 'default',
      stream: !!stream,
      messages: messages.length,
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const responseId = `chatcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const inputTokens = countMessages(messages, system);
      let summary;
      const outputParts = [];

      for await (const chunk of chatStream(client, opts)) {
        if (chunk.type === 'content') {
          outputParts.push(chunk.content);
          res.write(`data: ${JSON.stringify({
            id: responseId, object: 'chat.completion.chunk', created,
            model: model || 'q-developer',
            choices: [{ index: 0, delta: { content: chunk.content }, finish_reason: null }],
          })}\n\n`);
        } else if (chunk.type === 'summary') {
          summary = chunk.stats;
        }
      }
      res.write(`data: ${JSON.stringify({
        id: responseId, object: 'chat.completion.chunk', created,
        model: model || 'q-developer',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      const outputTokens = countContent(outputParts.join(''));
      const s = summary || {};
      s.estTokens = `~tokens: in=${inputTokens} out=${outputTokens}`;
      logSummary(rid, Date.now() - start, s);
    } else {
      const result = await chat(client, opts);
      const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const promptTokens = countMessages(messages, system);
      const completionTokens = countContent(text);
      const s = result.stats || {};
      s.estTokens = `~tokens: in=${promptTokens} out=${completionTokens}`;
      logSummary(rid, Date.now() - start, s);
      res.json({
        id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model: model || 'q-developer',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      });
    }
  } catch (err) {
    tagError('openai', err.message || err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ============================================================
// GET /v1/models
// ============================================================
app.get('/v1/models', async (_req, res) => {
  try {
    const tokenData = await getAccessToken();
    const { models, defaultModel } = await listAvailableModels(tokenData.accessToken, {
      profileArn: tokenData.profileArn, authMethod: tokenData.authMethod, provider: tokenData.provider,
    });
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
    const result = await listAvailableModels(tokenData.accessToken, {
      profileArn: tokenData.profileArn, authMethod: tokenData.authMethod, provider: tokenData.provider,
    });
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

app.listen(PORT, async () => {
  console.log(`${c.cyan}Kiro Proxy${c.reset} running on ${c.green}http://localhost:${PORT}${c.reset}`);
  console.log(`  ${c.gray}Anthropic:${c.reset} http://localhost:${PORT}/v1/messages`);
  console.log(`  ${c.gray}OpenAI:   ${c.reset} http://localhost:${PORT}/v1/chat/completions`);
  console.log(`  ${c.gray}Models:   ${c.reset} http://localhost:${PORT}/v1/models`);
  try {
    const t = await getAccessToken();
    console.log(`  ${c.gray}Provider: ${c.yellow}${t.provider || 'unknown'}${c.reset}, Expires: ${c.dim}${t.expiresAt || 'unknown'}${c.reset}`);
  } catch (err) {
    console.warn(`  ${c.yellow}Warning:${c.reset} ${err.message}`);
  }
});
