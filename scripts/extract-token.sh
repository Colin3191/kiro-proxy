#!/usr/bin/env bash
set -euo pipefail

TOKEN_FILE="${KIRO_TOKEN_FILE:-$HOME/.aws/sso/cache/kiro-auth-token.json}"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "Error: $TOKEN_FILE not found. Login to Kiro first." >&2
  exit 1
fi

ACCESS_TOKEN=$(python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])" < "$TOKEN_FILE")
REFRESH_TOKEN=$(python3 -c "import sys,json;print(json.load(sys.stdin).get('refreshToken',''))" < "$TOKEN_FILE")
AUTH_METHOD=$(python3 -c "import sys,json;print(json.load(sys.stdin).get('authMethod',''))" < "$TOKEN_FILE")
PROFILE_ARN=$(python3 -c "import sys,json;print(json.load(sys.stdin).get('profileArn',''))" < "$TOKEN_FILE")
REGION=$(python3 -c "import sys,json;print(json.load(sys.stdin).get('region',''))" < "$TOKEN_FILE")

case "${1:-headers}" in
  headers)
    echo "-H \"X-Kiro-Access-Token: $ACCESS_TOKEN\""
    [ -n "$REFRESH_TOKEN" ] && echo "-H \"X-Kiro-Refresh-Token: $REFRESH_TOKEN\""
    [ -n "$AUTH_METHOD" ] && echo "-H \"X-Kiro-Auth-Method: $AUTH_METHOD\""
    [ -n "$PROFILE_ARN" ] && echo "-H \"X-Kiro-Profile-Arn: $PROFILE_ARN\""
    [ -n "$REGION" ] && echo "-H \"X-Kiro-Region: $REGION\""
    ;;
  env)
    echo "export X_KIRO_ACCESS_TOKEN=\"$ACCESS_TOKEN\""
    [ -n "$REFRESH_TOKEN" ] && echo "export X_KIRO_REFRESH_TOKEN=\"$REFRESH_TOKEN\""
    [ -n "$AUTH_METHOD" ] && echo "export X_KIRO_AUTH_METHOD=\"$AUTH_METHOD\""
    [ -n "$PROFILE_ARN" ] && echo "export X_KIRO_PROFILE_ARN=\"$PROFILE_ARN\""
    [ -n "$REGION" ] && echo "export X_KIRO_REGION=\"$REGION\""
    ;;
  curl)
    HEADERS="-H \"X-Kiro-Access-Token: $ACCESS_TOKEN\""
    [ -n "$REFRESH_TOKEN" ] && HEADERS="$HEADERS -H \"X-Kiro-Refresh-Token: $REFRESH_TOKEN\""
    [ -n "$AUTH_METHOD" ] && HEADERS="$HEADERS -H \"X-Kiro-Auth-Method: $AUTH_METHOD\""
    [ -n "$PROFILE_ARN" ] && HEADERS="$HEADERS -H \"X-Kiro-Profile-Arn: $PROFILE_ARN\""
    [ -n "$REGION" ] && HEADERS="$HEADERS -H \"X-Kiro-Region: $REGION\""
    echo "$HEADERS"
    ;;
  *)
    echo "Usage: $(basename "$0") [headers|env|curl]" >&2
    echo "  headers  — print -H flags (default)" >&2
    echo "  env      — print export statements (eval-able)" >&2
    echo "  curl     — print single-line curl headers" >&2
    exit 1
    ;;
esac
