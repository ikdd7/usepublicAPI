#!/usr/bin/env bash
# 사용: YOUTH_API_KEY="키" ./scraper/run.sh   (네트워크가 youthcenter.go.kr 허용된 환경에서)
set -e
[ -z "$YOUTH_API_KEY" ] && { echo "YOUTH_API_KEY 를 설정하세요 (data.go.kr 발급키)"; exit 1; }
node "$(dirname "$0")/fetch_youth_api.mjs"
echo "완료. data/yeonsu_youth_live.json 생성됨. 'python3 -m http.server' 로 확인하세요."
