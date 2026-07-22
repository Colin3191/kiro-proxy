import crypto from 'crypto';

const DEFAULT_REGION = 'us-east-1';

function requestIdFrom(headers) {
  return headers.get('x-amzn-requestid') ||
    headers.get('x-amzn-request-id') ||
    headers.get('x-request-id') || undefined;
}

function runtimeError(type, payload = {}, requestId, statusCode) {
  const error = new Error(payload.message || payload.Message || type || `HTTP ${statusCode}`);
  error.name = type || payload.__type?.split('#').pop() || 'KiroRuntimeError';
  error.reason = payload.reason;
  error.retryAfterMilliseconds = payload.retryAfterMilliseconds;
  error.$metadata = { requestId, httpStatusCode: statusCode };
  return error;
}

function exceptionFromEvent(type, payload, requestId) {
  const aliases = {
    error: 'InternalServerException',
    throttlingError: 'ThrottlingException',
    validationError: 'ValidationException',
    serviceUnavailableError: 'ServiceUnavailableException',
  };
  return runtimeError(aliases[type] || type, payload, requestId);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('Request aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Request aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseHeaders(frame, start, length) {
  const end = start + length;
  let offset = start;
  const headers = {};

  while (offset < end) {
    const nameLength = frame.readUInt8(offset++);
    const name = frame.subarray(offset, offset + nameLength).toString('utf8');
    offset += nameLength;
    const type = frame.readUInt8(offset++);

    // Amazon EventStream type 7 is a UTF-8 string. These are the only
    // pseudo-headers Kiro Runtime uses for event and exception dispatch.
    if (type === 7) {
      const valueLength = frame.readUInt16BE(offset);
      offset += 2;
      headers[name] = frame.subarray(offset, offset + valueLength).toString('utf8');
      offset += valueLength;
      continue;
    }

    throw new Error(`Unsupported Kiro Runtime event header type: ${type}`);
  }

  return headers;
}

/** Parse the Amazon EventStream returned by GenerateAssistantResponse. */
export async function* parseKiroEventStream(body, requestId) {
  let pending = Buffer.alloc(0);

  for await (const chunk of body) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let offset = 0;

    while (offset + 12 <= pending.length) {
      const totalLength = pending.readUInt32BE(offset);
      if (totalLength < 16) throw new Error(`Invalid Kiro Runtime event length: ${totalLength}`);
      if (offset + totalLength > pending.length) break;

      const headersLength = pending.readUInt32BE(offset + 4);
      const headersStart = offset + 12;
      const payloadStart = headersStart + headersLength;
      const payloadEnd = offset + totalLength - 4;
      if (payloadStart > payloadEnd) throw new Error('Invalid Kiro Runtime event headers length');

      const headers = parseHeaders(pending, headersStart, headersLength);
      const payloadText = pending.subarray(payloadStart, payloadEnd).toString('utf8');
      let payload = {};
      if (payloadText) {
        try {
          payload = JSON.parse(payloadText);
        } catch (error) {
          throw new Error(`Invalid Kiro Runtime event JSON: ${error.message}`);
        }
      }

      const exceptionType = headers[':exception-type'];
      if (exceptionType) throw exceptionFromEvent(exceptionType, payload, requestId);

      const eventType = headers[':event-type'];
      if (eventType) {
        const eventError = ['error', 'throttlingError', 'validationError', 'serviceUnavailableError'].includes(eventType);
        if (eventError) throw exceptionFromEvent(eventType, payload, requestId);
        yield { [eventType]: payload };
      }

      offset += totalLength;
    }

    if (offset > 0) pending = pending.subarray(offset);
  }

  if (pending.length !== 0) throw new Error('Truncated Kiro Runtime event stream');
}

export class GenerateAssistantResponseCommand {
  constructor(input) {
    this.input = input;
  }
}

/** Minimal client for @amzn/kiro-runtime-service-typescript-client. */
export class KiroRuntimeClient {
  constructor({
    region = DEFAULT_REGION,
    endpoint = `https://runtime.${region}.kiro.dev`,
    token,
    customUserAgent,
    authMethod,
    provider,
    contentCollectionEnabled = false,
    maxAttempts = 3,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!token?.token) throw new Error('Kiro Runtime access token is required');
    if (typeof fetchImpl !== 'function') throw new Error('A Fetch API implementation is required');
    this.endpoint = endpoint.replace(/\/$/, '');
    this.accessToken = token.token;
    this.customUserAgent = customUserAgent;
    this.authMethod = authMethod;
    this.provider = provider;
    this.contentCollectionEnabled = contentCollectionEnabled;
    this.maxAttempts = Math.max(1, maxAttempts);
    this.fetchImpl = fetchImpl;
  }

  async send(command, { abortSignal } = {}) {
    if (!(command instanceof GenerateAssistantResponseCommand)) {
      throw new TypeError('Unsupported Kiro Runtime command');
    }

    const headers = {
      authorization: `Bearer ${this.accessToken}`,
      accept: 'application/vnd.amazon.eventstream',
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': 'KiroRuntimeService.GenerateAssistantResponse',
      'amz-sdk-invocation-id': crypto.randomUUID(),
    };
    if (this.customUserAgent) headers['user-agent'] = this.customUserAgent;
    if (!this.contentCollectionEnabled) headers['x-amzn-codewhisperer-optout'] = 'true';

    const tokenTypes = {
      external_idp: 'EXTERNAL_IDP',
      machine_token: 'KIRO_MACHINE_TOKEN',
      api_key: 'API_KEY',
      IdC: 'SSO_OIDC',
      idc: 'SSO_OIDC',
    };
    if (tokenTypes[this.authMethod]) headers.TokenType = tokenTypes[this.authMethod];
    if (this.provider === 'Internal') headers['redirect-for-internal'] = 'true';

    let response;
    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        response = await this.fetchImpl(`${this.endpoint}/generateAssistantResponse/`, {
          method: 'POST',
          headers: { ...headers, 'amz-sdk-request': `attempt=${attempt}; max=${this.maxAttempts}` },
          body: JSON.stringify(command.input),
          signal: abortSignal,
        });
        if (![429, 500, 502, 503, 504].includes(response.status) || attempt === this.maxAttempts) break;
        await response.arrayBuffer();
      } catch (error) {
        if (error.name === 'AbortError' || attempt === this.maxAttempts) throw error;
        lastError = error;
      }
      await delay(Math.min(1000, 100 * 2 ** (attempt - 1)), abortSignal);
    }
    if (!response) throw lastError || new Error('Kiro Runtime request failed');
    const requestId = requestIdFrom(response.headers);

    if (!response.ok) {
      const text = await response.text();
      let payload = {};
      try { payload = JSON.parse(text); } catch { payload = { message: text }; }
      throw runtimeError(payload.__type?.split('#').pop(), payload, requestId, response.status);
    }
    if (!response.body) throw new Error('Kiro Runtime returned an empty response body');

    return {
      $metadata: { httpStatusCode: response.status, requestId },
      conversationId: response.headers.get('x-amzn-kiro-conversation-id') || undefined,
      generateAssistantResponseResponse: parseKiroEventStream(response.body, requestId),
    };
  }
}
