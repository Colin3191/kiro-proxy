import fs from 'fs';
import path from 'path';
import os from 'os';

const USAGE_DIR = path.join(os.homedir(), '.kiro-proxy', 'usage');

function dateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return { y, m, day };
}

function filePath(date) {
  const { y, m, day } = dateStr(date);
  return path.join(USAGE_DIR, String(y), m, `${day}.jsonl`);
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function recordUsage(credits, model) {
  const fp = filePath(new Date());
  ensureDir(fp);
  const entry = JSON.stringify({ ts: Date.now(), credits, model }) + '\n';
  fs.appendFileSync(fp, entry);
}

function readFile(fp) {
  if (!fs.existsSync(fp)) return [];
  const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return entries;
}

function daysBetween(since) {
  const dates = [];
  const d = new Date(since);
  d.setHours(0, 0, 0, 0);
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  while (d <= now) {
    dates.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function readEntries(since) {
  const entries = [];
  for (const d of daysBetween(since)) {
    for (const e of readFile(filePath(d))) {
      if (e.ts >= since) entries.push(e);
    }
  }
  return entries;
}

function readAllEntries() {
  const entries = [];
  if (!fs.existsSync(USAGE_DIR)) return entries;
  for (const y of fs.readdirSync(USAGE_DIR)) {
    const yDir = path.join(USAGE_DIR, y);
    if (!fs.statSync(yDir).isDirectory()) continue;
    for (const m of fs.readdirSync(yDir)) {
      const mDir = path.join(yDir, m);
      if (!fs.statSync(mDir).isDirectory()) continue;
      for (const f of fs.readdirSync(mDir)) {
        if (f.endsWith('.jsonl')) entries.push(...readFile(path.join(mDir, f)));
      }
    }
  }
  return entries;
}

function summarize(entries) {
  let total = 0;
  const byModel = {};
  for (const e of entries) {
    total += e.credits || 0;
    const m = e.model || 'unknown';
    byModel[m] = (byModel[m] || 0) + (e.credits || 0);
  }
  return { requests: entries.length, credits: +total.toFixed(6), byModel };
}

function startOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfMonth() {                                                                                                             
  const d = new Date();
  d.setDate(1);                                                                                                                       
  d.setHours(0, 0, 0, 0);                                                   
  return d.getTime();                                                                                                                 
}

export function queryUsage(period) {
  const now = Date.now();
  const ranges = {
    today: startOfDay(),
    '7d': now - 7 * 86400000,
    '30d': now - 30 * 86400000,
    'month': startOfMonth(),   // 当前自然月
  };
  if (period === 'all') return { period, ...summarize(readAllEntries()) };
  const since = ranges[period] ?? ranges.today;
  return { period: period || 'today', ...summarize(readEntries(since)) };
}

export function todaySummary() {
  return queryUsage('today');
}
