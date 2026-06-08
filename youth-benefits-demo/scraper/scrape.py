#!/usr/bin/env python3
"""
연수구/인천 청년 혜택 수집 파이프라인 (프로토타입)
--------------------------------------------------
실제 서비스의 핵심 해자 = '229개 지자체 비정형 공고 -> 구조화 데이터'.
이 스크립트는 그 파이프라인의 골격을 보여준다.

현실 체크: 정부/지자체 사이트는 봇 차단(HTTP 403)이 흔하다.
 -> 실서비스에서는 (1) 공식 오픈API(data.go.kr, 온통청년 API),
    (2) 제휴/협약, (3) 합법적 수집 + 캐싱 을 조합해야 한다.
이 데모는 차단 시 'data/yeonsu_youth.json'(수기 검증 시드)로 폴백한다.

사용:  python scrape.py            # 수집 시도 -> 구조화 -> JSON 갱신
의존:  requests, beautifulsoup4 (선택)  /  표준 라이브러리만으로도 폴백 동작
"""
import json, os, sys, datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, "data", "yeonsu_youth.json")

# 수집 대상(시드). 실제로는 게시판 목록 -> 상세 공고 순회.
SOURCES = [
    {"name": "인천 청년월세 지원", "url": "https://youth.incheon.go.kr/dwelling/monthly.jsp", "category": "주거"},
    {"name": "드림체크카드",       "url": "https://youth.incheon.go.kr/job/dream.jsp",        "category": "일자리"},
    {"name": "드림For 청년통장",   "url": "https://youth.incheon.go.kr/financial/dreamfor.jsp","category": "자산형성"},
    {"name": "청년 면접수당",       "url": "https://youth.incheon.go.kr/youthpolicy/", "category": "일자리"},
]

HEADERS = {  # 차단 완화용 일반 브라우저 UA (그래도 막히면 폴백)
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9",
}

def fetch(url):
    import urllib.request, urllib.error
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.read().decode("utf-8", "ignore"), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, str(e)

def structure_with_llm(html, source):
    """
    실제 해자 단계: 비정형 공고 HTML -> 구조화 필드(JSON) 추출.
    프로덕션에서는 LLM(claude)에게 아래 스키마로 추출시킨다:
      {title, category, age_min, age_max, amount_max_won, amount_label,
       conditions[], apply_start, apply_end, apply_how, contact, source}
    여기서는 데모이므로 자리표시자만 둔다.
    """
    return None  # placeholder

def main():
    print("== 연수구 청년혜택 수집 파이프라인 ==")
    collected, blocked = [], []
    for s in SOURCES:
        html, err = fetch(s["url"])
        if err:
            print(f"  [차단/실패] {s['name']:14s} <- {err}  ({s['url']})")
            blocked.append(s["name"]); continue
        print(f"  [수집성공] {s['name']:14s} ({len(html):,} bytes) -> 구조화 단계로")
        item = structure_with_llm(html, s)
        if item: collected.append(item)

    if blocked:
        print(f"\n  ⚠️  {len(blocked)}건 차단됨(정부사이트 봇차단). "
              f"실서비스는 공식 오픈API/제휴 필요.")
    if not collected:
        print("  → 검증된 시드 데이터(data/yeonsu_youth.json)로 폴백 (앱은 정상 동작).")
        if os.path.exists(OUT):
            with open(OUT, encoding="utf-8") as f:
                data = json.load(f)
            print(f"  → 현재 시드 혜택 {len(data['benefits'])}건 보유. snapshot={data['meta']['snapshot_date']}")
        return

    # 수집 성공분 병합 (생략: 데모)
    print(f"\n  수집/구조화 완료: {len(collected)}건")

if __name__ == "__main__":
    main()
