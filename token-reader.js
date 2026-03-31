import fs from 'fs';
import path from 'path';
import os from 'os';

const SSO_CACHE_DIR = path.join(os.homedir(), '.aws', 'sso', 'cache');
const KIRO_TOKEN_FILE = 'kiro-auth-token.json';

// Social 刷新 URL
const SOCIAL_REFRESH_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';

// token 提前刷新的缓冲时间（5 分钟）
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Kiro profile 缓存路径
const KIRO_PROFILE_PATHS = [
  path.join(os.homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'),
  path.join(os.homedir(), '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'),
];

// 内存缓存
let cachedToken = null;
let refreshPromise = null;

/**
 * 读取 ~/.aws/sso/cache/kiro-auth-token.json
 */
function readKiroToken() {
  const tokenPath = path.join(SSO_CACHE_DIR, KIRO_TOKEN_FILE);
  if (!fs.existsSync(tokenPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch { return null; }
}

/**
 * 写回 token 到磁盘（让 Kiro 也能用刷新后的 token）
 */
function writeKiroToken(tokenData) {
  try {
    const tokenPath = path.join(SSO_CACHE_DIR, KIRO_TOKEN_FILE);
    fs.mkdirSync(SSO_CACHE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2));
  } catch (err) {
    console.warn('[token] Failed to write token to disk:', err.message);
  }
}

/**
 * 读取 Kiro profile 缓存
 */
function readKiroProfile() {
  for (const p of KIRO_PROFILE_PATHS) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* skip */ }
  }
  return null;
}

/**
 * 读取 IdC 的 client registration（从 ~/.aws/sso/cache/{hash}.json）
 */
function readClientRegistration(clientIdHash) {
  if (!clientIdHash) return null;
  const filePath = path.join(SSO_CACHE_DIR, `${clientIdHash}.json`);
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { /* skip */ }
  return null;
}

/**
 * 判断 token 是否过期或即将过期
 */
function isTokenExpired(tokenData) {
  if (!tokenData?.expiresAt) return true;
  return new Date(tokenData.expiresAt).getTime() < Date.now() + REFRESH_BUFFER_MS;
}

// ============================================================
// Social token 刷新（Google / Github 登录）
// POST https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken
// ============================================================
async function refreshSocialToken(tokenData) {
  console.log('[token] Refreshing Social token...');
  const res = await fetch(SOCIAL_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokenData.refreshToken }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Social token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  // 响应: { accessToken, refreshToken?, expiresIn, profileArn? }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (data.expiresIn || 3600) * 1000).toISOString();

  return {
    ...tokenData,
    accessToken: data.accessToken,
    // refreshToken 可能会更新
    ...(data.refreshToken && { refreshToken: data.refreshToken }),
    ...(data.profileArn && { profileArn: data.profileArn }),
    expiresAt,
  };
}

// ============================================================
// IdC token 刷新（Enterprise / BuilderId）
// POST https://oidc.us-east-1.amazonaws.com/token
// ============================================================
async function refreshIdCToken(tokenData) {
  console.log('[token] Refreshing IdC token...');

  // 读取 client registration
  const clientReg = readClientRegistration(tokenData.clientIdHash);
  if (!clientReg?.clientId || !clientReg?.clientSecret) {
    throw new Error('IdC refresh failed: no valid client registration found. Please re-login in Kiro.');
  }

  const region = tokenData.region || 'us-east-1';
  const endpoint = `https://oidc.${region}.amazonaws.com/token`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: clientReg.clientId,
      clientSecret: clientReg.clientSecret,
      grantType: 'refresh_token',
      refreshToken: tokenData.refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`IdC token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (data.expiresIn || 3600) * 1000).toISOString();

  return {
    ...tokenData,
    accessToken: data.accessToken,
    ...(data.refreshToken && { refreshToken: data.refreshToken }),
    expiresAt,
  };
}

// ============================================================
// 刷新调度
// ============================================================
async function refreshToken(tokenData) {
  const method = tokenData.authMethod;
  if (method === 'social' || method === 'Social') {
    return refreshSocialToken(tokenData);
  }
  if (method === 'IdC' || method === 'idc') {
    return refreshIdCToken(tokenData);
  }
  throw new Error(`Unknown auth method: ${method}. Cannot refresh token.`);
}

/**
 * 获取可用的 access token
 * - 优先使用内存缓存
 * - 过期时自动刷新（带去重，避免并发刷新）
 * - 刷新后写回磁盘
 * - 如果没有 profileArn，从 Kiro profile 缓存补充
 */
export async function getAccessToken() {
  // 1. 内存缓存未过期，直接返回
  if (cachedToken && !isTokenExpired(cachedToken)) {
    return cachedToken;
  }

  // 2. 从磁盘读取
  let tokenData = readKiroToken();
  if (!tokenData?.accessToken) {
    throw new Error('No token found in ~/.aws/sso/cache/kiro-auth-token.json. Please login in Kiro first.');
  }

  // 3. 如果未过期，缓存并返回
  if (!isTokenExpired(tokenData)) {
    tokenData = enrichWithProfile(tokenData);
    cachedToken = tokenData;
    return tokenData;
  }

  // 4. 过期了，需要刷新
  if (!tokenData.refreshToken) {
    throw new Error('Token expired and no refreshToken available. Please re-login in Kiro.');
  }

  // 去重：如果已经有刷新在进行，等待它完成
  if (refreshPromise) {
    console.log('[token] Waiting for ongoing refresh...');
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      console.log(`[token] Token expired (${tokenData.expiresAt}), refreshing...`);
      const newToken = await refreshToken(tokenData);
      const enriched = enrichWithProfile(newToken);

      // 写回磁盘
      writeKiroToken(enriched);
      cachedToken = enriched;

      console.log(`[token] Token refreshed, new expiry: ${enriched.expiresAt}`);
      return enriched;
    } catch (err) {
      console.error('[token] Refresh failed:', err.message);
      // 刷新失败，如果旧 token 还没完全过期（只是在缓冲期内），仍然可以用
      if (tokenData.expiresAt && new Date(tokenData.expiresAt) > new Date()) {
        console.warn('[token] Using existing token despite refresh failure');
        cachedToken = enrichWithProfile(tokenData);
        return cachedToken;
      }
      throw err;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

function enrichWithProfile(tokenData) {
  if (!tokenData.profileArn) {
    const profile = readKiroProfile();
    if (profile?.arn) {
      tokenData.profileArn = profile.arn;
    }
  }
  return tokenData;
}
