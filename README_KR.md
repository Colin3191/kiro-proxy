[English](README_EN.md) | [中文](README.md) | 한국어

# kiro-proxy

[Kiro](https://kiro.dev) 구독에 포함된 Claude 모델을 Claude Code에서 사용할 수 있게 해주는 프록시.

Kiro 인증 토큰을 읽어서 Amazon Q Developer로 요청을 프록시하고, OpenAI 및 Anthropic 호환 API 엔드포인트를 제공합니다.

## 전제조건

Kiro를 설치하고 로그인해서 `~/.aws/sso/cache/kiro-auth-token.json`이 존재하고 유효해야 합니다.

## 빠른 시작

```bash
npx kiro-proxy
```

서버 기본 포트: `http://localhost:3456`

## 설정

| 환경변수 | 기본값 | 설명 |
|----------|--------|------|
| `PORT` | `3456` | 수신 포트 |
| `PROXY_API_KEY` | 없음 | 설정 시 모든 요청에 이 키로 인증 필요. 미설정 시 검증 안 함 |
| `HTTPS_PROXY` | 없음 | HTTP/HTTPS 프록시 주소, 예: `http://127.0.0.1:7890` |
| `MULTI_USER` | `false` | `true`이면 멀티유저 모드 (`--multi-user` 플래그와 동일) |
| `TOKEN_DB_PATH` | `~/.kiro-proxy/tokens.db` | 멀티유저 모드 토큰 DB 경로 |
| `DATABRICKS_APP_PORT` | - | 설정 시 PORT보다 우선 |

## 멀티유저 모드

여러 클라이언트가 각자의 Kiro 토큰으로 프록시를 동시에 사용 가능. 서버가 토큰을 SQLite DB에 캐시하고 만료 시 자동 refresh.

```bash
# CLI 플래그
node server.js --multi-user

# 또는 환경변수
MULTI_USER=true node server.js
```

클라이언트는 다음 헤더를 포함해야 합니다:

| 헤더 | 필수 | 설명 |
|------|------|------|
| `X-Kiro-Access-Token` | 예* | 현재 access token |
| `X-Kiro-Refresh-Token` | 예* | refresh token (서버가 자동 갱신에 사용) |
| `X-Kiro-Auth-Method` | 아니오 | `social` 또는 `IdC` |
| `X-Kiro-Profile-Arn` | 아니오 | profile ARN |
| `X-Kiro-Region` | 아니오 | AWS region |
| `X-Kiro-Provider` | 아니오 | provider 타입 |

\* 둘 중 하나는 필수. 자동 갱신을 위해 둘 다 보내는 것을 권장.

토큰 추출:

```bash
# 내장 스크립트 사용
./scripts/extract-token.sh headers   # -H 플래그 출력
./scripts/extract-token.sh env       # export 구문 출력
./scripts/extract-token.sh curl      # 한 줄 curl headers 출력

# curl과 함께 사용
eval curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  $(./scripts/extract-token.sh curl) \
  -d '{"model": "claude-sonnet-4.6", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'
```

토큰 흐름:
1. 첫 요청: 토큰 검증 후 DB에 저장
2. 이후 요청: DB 캐시 사용
3. 만료 시: 서버가 자동 refresh → DB 갱신
4. refresh token 자체 만료: 401 반환 → 클라이언트가 새 토큰 제출

`--multi-user` 없이 실행하면 기존과 완전히 동일하게 동작 (로컬 토큰 파일 읽기).

## API

### GET /v1/models — 사용 가능한 모델 조회

```bash
curl http://localhost:3456/v1/models
```

### POST /v1/messages — Anthropic 호환

```bash
# 비스트리밍
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{"model": "claude-sonnet-4.6", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'

# 스트리밍
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{"model": "claude-sonnet-4.6", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

### POST /v1/chat/completions — OpenAI 호환

```bash
# 비스트리밍
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.6", "messages": [{"role": "user", "content": "Hello"}]}'

# 스트리밍
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.6", "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

### GET /health

토큰 상태 및 만료 시간 확인.

### GET /credits

크레딧 사용량 통계. `period` 파라미터 지원:

```bash
# 오늘 사용량 (기본)
curl http://localhost:3456/credits

# 최근 7일
curl http://localhost:3456/credits?period=7d

# 최근 30일
curl http://localhost:3456/credits?period=30d

# 전체
curl http://localhost:3456/credits?period=all
```

## Claude Code 연동

Claude Code는 기본적으로 Anthropic 공식 model ID를 사용합니다. 환경변수로 Q Developer model ID에 매핑해야 합니다.

`~/.claude/settings.json`에 추가:

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

`model` 옵션: `sonnet`, `opus`, `haiku`. `[1m]` 접미사로 1M 컨텍스트 윈도우 활성화 (예: `"opus[1m]"`).

> 주의: `ANTHROPIC_MODEL` 환경변수를 설정하지 마세요. `model` 필드를 덮어써서 컨텍스트 윈도우 설정이 무효화됩니다.

## 프록시 설정

2026년 5월 1일부터 Kiro의 Claude 모델은 중국 대륙 및 홍콩/마카오/대만에서 사용할 수 없습니다. `Invalid model` 에러가 발생하면 프록시를 설정하세요.

> 주의: 프록시 노드는 다른 지역(싱가포르, 태국, 한국 등)을 선택해야 합니다.

환경변수로 HTTP 프록시 설정:

```bash
# 프록시 설정 후 시작
HTTPS_PROXY=http://127.0.0.1:7890 npx kiro-proxy
```

지원 환경변수: `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy` (왼쪽부터 우선순위).

## 관련 프로젝트

- [kiro-web-search](https://github.com/Colin3191/kiro-web-search) — Kiro 내장 웹 검색을 MCP server로 래핑, Claude Code 등에서 사용 가능
