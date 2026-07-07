import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { tagLog } from './logger.js';

// DB 경로: 환경변수 또는 기본값
const DB_PATH = process.env.TOKEN_DB_PATH || path.join(os.homedir(), '.kiro-proxy', 'tokens.db');

let db;

function getDb() {
  if (db) return db;
  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      key_hash TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TEXT NOT NULL,
      auth_method TEXT,
      profile_arn TEXT,
      region TEXT,
      provider TEXT,
      client_id_hash TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

export function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function getStoredToken(keyHash) {
  const row = getDb().prepare('SELECT * FROM tokens WHERE key_hash = ?').get(keyHash);
  if (!row) return null;
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    authMethod: row.auth_method,
    profileArn: row.profile_arn,
    region: row.region,
    provider: row.provider,
    clientIdHash: row.client_id_hash,
  };
}

export function upsertToken(keyHash, tokenData) {
  const stmt = getDb().prepare(`
    INSERT INTO tokens (key_hash, access_token, refresh_token, expires_at, auth_method, profile_arn, region, provider, client_id_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key_hash) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      auth_method = excluded.auth_method,
      profile_arn = excluded.profile_arn,
      region = excluded.region,
      provider = excluded.provider,
      client_id_hash = excluded.client_id_hash,
      updated_at = excluded.updated_at
  `);
  stmt.run(
    keyHash,
    tokenData.accessToken,
    tokenData.refreshToken || null,
    tokenData.expiresAt,
    tokenData.authMethod || null,
    tokenData.profileArn || null,
    tokenData.region || null,
    tokenData.provider || null,
    tokenData.clientIdHash || null,
    Date.now(),
  );
}

export function deleteToken(keyHash) {
  getDb().prepare('DELETE FROM tokens WHERE key_hash = ?').run(keyHash);
}

/**
 * 오래된 토큰 정리 — 기본 7일 미갱신 엔트리 삭제
 */
export function purgeExpired(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  const result = getDb().prepare('DELETE FROM tokens WHERE updated_at < ?').run(cutoff);
  if (result.changes > 0) {
    tagLog('token-store', `Purged ${result.changes} stale token(s)`);
  }
  return result.changes;
}

/**
 * 서버 시작 시 1회 purge 실행
 */
export function initTokenStore() {
  getDb(); // ensure table exists
  purgeExpired();
  tagLog('token-store', `Initialized at ${DB_PATH}`);
}
