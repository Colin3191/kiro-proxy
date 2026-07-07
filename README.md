[English](README_EN.md) | [한국어](README_KR.md) | 中文

# kiro-proxy

让 [Kiro](https://kiro.dev) 订阅内含的 Claude 模型可以在 Claude Code 中使用。

通过读取 Kiro 的认证 token，代理请求到 Amazon Q Developer，暴露 OpenAI 和 Anthropic 兼容的 API 接口。

## 前提

需要先安装并登录 Kiro，确保 `~/.aws/sso/cache/kiro-auth-token.json` 存在且未过期。

## 快速开始

```bash
npx kiro-proxy
```

服务默认监听 `http://localhost:3456`。

## 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT`   | `3456` | 监听端口 |
| `PROXY_API_KEY` | 无 | 设置后所有请求需携带此 key 进行鉴权，未设置则不校验 |
| `HTTPS_PROXY` | 无 | HTTP/HTTPS 代理地址，如 `http://127.0.0.1:7890` |
| `MULTI_USER` | `false` | `true` 启用多用户模式（等同 `--multi-user` 参数） |
| `TOKEN_DB_PATH` | `~/.kiro-proxy/tokens.db` | 多用户模式下的 Token 数据库路径 |
| `DATABRICKS_APP_PORT` | - | 设置后优先于 PORT |

## 多用户模式

支持多客户端各自使用自己的 Kiro token 同时使用代理。服务器将 token 缓存到 SQLite DB，过期时自动刷新。

```bash
# CLI 参数
node server.js --multi-user

# 或环境变量
MULTI_USER=true node server.js
```

客户端需传递以下请求头：

| 请求头 | 必需 | 说明 |
|--------|------|------|
| `X-Kiro-Access-Token` | 是* | 当前 access token |
| `X-Kiro-Refresh-Token` | 是* | refresh token（服务器用来自动续期） |
| `X-Kiro-Auth-Method` | 否 | `social` 或 `IdC` |
| `X-Kiro-Profile-Arn` | 否 | profile ARN |
| `X-Kiro-Region` | 否 | AWS region |
| `X-Kiro-Provider` | 否 | provider 类型 |

\* 至少提供其中一个。建议同时传两个以启用自动续期。

提取 token：

```bash
# 使用内置脚本
./scripts/extract-token.sh headers   # 输出 -H 参数
./scripts/extract-token.sh env       # 输出 export 语句
./scripts/extract-token.sh curl      # 输出单行 curl headers

# 配合 curl 使用
eval curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  $(./scripts/extract-token.sh curl) \
  -d '{"model": "claude-sonnet-4.6", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'
```

Token 流程：
1. 首次请求：验证 token 后存入 DB
2. 后续请求：使用 DB 中的缓存 token
3. 过期时：服务器自动刷新并更新 DB
4. refresh token 本身过期：返回 401，客户端需提交新 token

不使用 `--multi-user` 时行为与原版完全一致（读取本地 token 文件）。

## API

### GET /v1/models — 查询可用模型

```bash
curl http://localhost:3456/v1/models
```

### POST /v1/messages — Anthropic 兼容

```bash
# 非流式
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{"model": "claude-sonnet-4.6", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'

# 流式
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{"model": "claude-sonnet-4.6", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

### POST /v1/chat/completions — OpenAI 兼容

```bash
# 非流式
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.6", "messages": [{"role": "user", "content": "Hello"}]}'

# 流式
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.6", "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

### GET /health

检查 token 状态及过期时间。

### GET /credits

查询积分消耗统计，支持 `period` 参数：

```bash
# 今日消耗（默认）
curl http://localhost:3456/credits

# 最近 7 天
curl http://localhost:3456/credits?period=7d

# 最近 30 天
curl http://localhost:3456/credits?period=30d

# 全部
curl http://localhost:3456/credits?period=all
```

## 与 Claude Code 集成

Claude Code 默认使用 Anthropic 官方 model ID，需要通过环境变量映射到 Q Developer 的 model ID。

在 `~/.claude/settings.json` 中添加：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "any",
    "ANTHROPIC_BASE_URL": "http://localhost:3456",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4.6",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4.6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5"
  },
  "model": "sonnet"
}
```

`model` 可选值：`sonnet`、`opus`、`haiku`，添加 `[1m]` 后缀可启用 1M 上下文窗口（如 `"opus[1m]"`）。

> 注意：不要设置 `ANTHROPIC_MODEL` 环境变量，它会覆盖 `model` 字段，导致上下文窗口等配置失效。

## 代理设置

自 2026 年 5 月 1 日起，Kiro 上的 Claude 模型无法在中国大陆及港澳台地区使用。如果遇到 `Invalid model` 错误，请配置代理。

> 注意：代理节点需选择其他地区（如新加坡、泰国、韩国等）。

通过环境变量设置 HTTP 代理：

```bash
# 设置代理后启动
HTTPS_PROXY=http://127.0.0.1:7890 npx kiro-proxy
```

支持的环境变量：`HTTPS_PROXY`、`https_proxy`、`HTTP_PROXY`、`http_proxy`，优先级从左到右。

## 相关项目

- [kiro-web-search](https://github.com/Colin3191/kiro-web-search) — 将 Kiro 内置的联网搜索封装为 MCP server，可在 Claude Code 等客户端中使用
