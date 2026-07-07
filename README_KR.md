[English](README_EN.md) | [中文](README.md) | 한국어

# kiro-proxy

Kiro 구독에 포함된 Claude 모델을 OpenAI/Anthropic 호환 API로 노출하는 프록시.

Kiro 인증 토큰을 읽어서 Amazon Q Developer로 요청을 프록시하고, OpenAI 및 Anthropic 호환 엔드포인트를 제공합니다.

## 모드

### 로컬 모드 (기본)

로컬 머신의 `~/.aws/sso/cache/kiro-auth-token.json`에서 토큰을 읽습니다.

```bash
node server.js
```

### 멀티유저 모드

클라이언트가 요청 헤더로 토큰을 전달하면 서버가 SQLite DB에 캐시하고, 만료 시 자동으로 refresh합니다. 여러 유저가 각자 토큰으로 동시에 사용 가능.

```bash
# CLI 플래그
node server.js --multi-user

# 또는 환경변수
MULTI_USER=true node server.js
```

멀티유저 모드에서 클라이언트는 다음 헤더를 포함해야 합니다:

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
1. 첫 요청 시 토큰 유효성 검증 후 DB에 저장
2. 이후 요청에서 DB 캐시 사용
3. 만료 시 서버가 자동 refresh → DB 갱신
4. refresh token 자체 만료 시 401 반환 → 클라이언트가 새 토큰 제출

## 전제조건

Kiro를 설치하고 로그인해서 `~/.aws/sso/cache/kiro-auth-token.json`이 존재해야 합니다.

## 빠른 시작

```bash
npx @leecoder/kiro-proxy
```

서버 기본 포트: `http://localhost:3456`

## 설정

| 환경변수 | 기본값 | 설명 |
|----------|--------|------|
| `PORT` | `3456` | 수신 포트 |
| `DATABRICKS_APP_PORT` | - | 설정 시 PORT보다 우선 |
| `PROXY_API_KEY` | - | 설정 시 모든 요청에 Bearer 인증 필요 |
| `MULTI_USER` | `false` | `true`이면 멀티유저 모드 (`--multi-user` 플래그와 동일) |
| `TOKEN_DB_PATH` | `~/.kiro-proxy/tokens.db` | 토큰 DB 경로 |
| `HTTPS_PROXY` | - | 아웃바운드 프록시 주소 |

## API

### POST /v1/messages — Anthropic 호환

```bash
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.6", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'
```

### POST /v1/chat/completions — OpenAI 호환

```bash
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.6", "messages": [{"role": "user", "content": "Hello"}]}'
```

### GET /v1/models

사용 가능한 모델 목록 조회.

### GET /health

토큰 상태 및 만료 시간 확인.

### GET /credits?period=today|7d|30d|all

크레딧 사용량 통계.

## Claude Code 연동

`~/.claude/settings.json`:

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

## Databricks Apps 배포

`app.yaml` 예시 (`.gitignore`에 포함, 로컬에서만 관리):

```yaml
command:
  - node
  - server.js
  - --multi-user
env:
  - name: PROXY_API_KEY
    valueFrom: secret
  - name: TOKEN_DB_PATH
    value: "/tmp/kiro-proxy/tokens.db"
```

```bash
databricks apps deploy kiro-proxy --source-code-path "/Workspace/Users/$USER/kiro-proxy"
```

## 프록시 설정

`Invalid model` 에러 발생 시:

```bash
HTTPS_PROXY=http://127.0.0.1:7890 node server.js
```

## 원본 프로젝트

Fork from [Colin3191/kiro-proxy](https://github.com/Colin3191/kiro-proxy)
