import crypto from 'crypto';

export const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
};

const METHOD_COLORS = {
  POST: c.green,
  GET: c.blue,
  DELETE: c.yellow,
};

function timestamp() {
  const now = new Date();
  return c.gray + now.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0') + c.reset;
}

/**
 * 生成 3 字符的短请求 ID
 */
export function reqId() {
  return crypto.randomBytes(2).toString('hex').slice(0, 3);
}

/**
 * HTTP 请求日志（server.js 用）
 * 格式: 12:34:56.789 POST /v1/messages [a3f] model=xxx
 */
export function log(method, path, id, info) {
  const methodColor = METHOD_COLORS[method] || c.magenta;
  const parts = [timestamp()];
  if (id) parts.push(c.magenta + `[${id}]` + c.reset);
  parts.push(methodColor + method + c.reset, c.cyan + path + c.reset);
  if (info) parts.push(c.dim + (typeof info === 'string' ? info : JSON.stringify(info)) + c.reset);
  console.log(parts.join(' '));
}

/**
 * 带标签的日志（q-client.js / token-reader.js 用）
 * 格式: 12:34:56.789 [token] Refreshing Social token...
 */
export function tagLog(tag, ...args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.log(`${timestamp()} ${c.cyan}[${tag}]${c.reset} ${msg}`);
}

export function tagWarn(tag, ...args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.warn(`${timestamp()} ${c.yellow}[${tag}]${c.reset} ${msg}`);
}

export function tagError(tag, ...args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.error(`${timestamp()} ${c.red}[${tag}]${c.reset} ${msg}`);
}

/**
 * 请求完成汇总行
 * 格式: 12:34:56.789  └─ [a3f] 4.07s context=0.21% 0.0096 credits
 */
export function logSummary(id, elapsed, stats) {
  const duration = elapsed >= 1000 ? `${(elapsed / 1000).toFixed(2)}s` : `${elapsed}ms`;
  const parts = [];
  parts.push(duration);
  if (stats.context) parts.push(`context=${stats.context}`);
  if (stats.metering) parts.push(stats.metering);
  if (stats.tokens) parts.push(stats.tokens);
  if (stats.estTokens) parts.push(stats.estTokens);
  if (stats.links) parts.push(stats.links);
  if (stats.invalid) parts.push(`invalid: ${stats.invalid}`);
  if (stats.codeRef) parts.push(`codeRef: ${typeof stats.codeRef === 'string' ? stats.codeRef : JSON.stringify(stats.codeRef)}`);
  const tag = id ? `${c.magenta}[${id}]${c.reset} ` : '';
  console.log(`${timestamp()} ${tag}${c.dim}${parts.join(' | ')}${c.reset}`);
}
