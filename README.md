[English](README_EN.md) | [한국어](README_KR.md) | 中文

# kiro-proxy

将 Kiro 订阅中的 Claude 模型通过 OpenAI/Anthropic 兼容 API 暴露出来。

读取 Kiro 认证 token，代理请求到 Amazon Q Developer，提供 OpenAI 和 Anthropic 兼容端点。

## 模式

### 本地模式（默认）

从本机 `~/.aws/sso/cache/kiro-auth-token.json` 读取 token。

```bash
node server.js
```

### 多用户模式

客户端通过请求头传递 token，服务器缓存到 SQLite DB 并在过期时自动刷新。多个用户可同时使用各自 token。

```bash
# CLI 参数
node server.js --multi-user

# 或环境变量
MULTI_USER=true node server.js
```

多用户模式下，客户端需传递以下请求头：

| 请求头 | 必需 | 说明 |
|--------|------|------|
| `X-Kiro-Access-Token` | 是* | 当前 access token |
| `X-Kiro-Refresh-Token` | 是* | refresh token（服务器用来自动续期） |
| `X-Kiro-Auth-Method` | 否 | `social` 或 `IdC` |
| `X-Kiro-Profile-Arn` | 否 | profile ARN |
| `X-Kiro-Region` | 否 | AWS region |
| `X-Kiro-Provider` | 否 | provider 类型 |

\* 至少提供其中一个。建议同时传两个以启用自动续期。

提取 token 示例：

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

## 前提

安装并登录 Kiro，确保 `~/.aws/sso/cache/kiro-auth-token.json` 存在。

## 快速开始

```bash
npx kiro-proxy
```

默认端口：`http://localhost:3456`

## 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | `3456` | 监听端口 |
| `DATABRICKS_APP_PORT` | - | 设置后优先于 PORT |
| `PROXY_API_KEY` | - | 设置后所有请求需 Bearer 认证 |
| `MULTI_USER` | `false` | `true` 启用多用户模式（等同 `--multi-user` 参数） |
| `TOKEN_DB_PATH` | `~/.kiro-proxy/tokens.db` | Token 数据库路径 |
| `HTTPS_PROXY` | - | 出站代理地址 |

## API

### POST /v1/messages — Anthropic 兼容

```bash
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.6", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'
```

### POST /v1/chat/completions — OpenAI 兼容

```bash
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.6", "messages": [{"role": "user", "content": "Hello"}]}'
```

### GET /v1/models

查询可用模型列表。

### GET /health

检查 token 状态及过期时间。

### GET /credits?period=today|7d|30d|all

积分使用统计。

## Claude Code 集成

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

## 代理设置

遇到 `Invalid model` 错误时：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 node server.js
```

## 原始项目

Fork from [Colin3191/kiro-proxy](https://github.com/Colin3191/kiro-proxy)
