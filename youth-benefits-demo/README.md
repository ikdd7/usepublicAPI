# 우리동네 복지·지원 — 전국 복지·지원금 모아보기

전국 시·도/시·군·구로 흩어진 복지·지원 혜택을 한곳에 모아, **지역·나이·상황만 고르면 받을 수 있는 것만**
골라주고 **최대 수령액을 합산**해 보여주는 서비스.

> "옆 동네는 받는데 나만 몰랐던 우리 동네 지원금" — 발견의 쾌감 = 공유 동력.

🔗 **라이브:** https://ikdd7.github.io/usepublicAPI/ (GitHub Pages, 매일 자동 갱신)

## 주요 기능
- **전국 지역 선택**: 시·도 → 시·군·구 2단 선택. 데이터에 존재하는 지역으로 동적 구성.
- **다차원 맞춤 필터**: 나이 + 신분/가구/상황(구직중·무주택·저소득·한부모·장애인 등) + **직업**(농어업인·예술인·운수종사자·제대군인) + 분야 + 지원형태.
  - 조건 충족 혜택만 ✅, 안 맞는 건 🔒 + 이유 표시. **"최대 OOO만원"** 합산 배너 + 공유.
- **같은 사업 자동 병합**: 여러 소스/여러 동에 중복 게시된 같은 사업은 한 건으로 합치고 출처를 모음.
  여러 동에 중복된 구 사업은 '구 단위 1건'으로 승격, 동 단독 사업은 동 단위로 유지.
- **노이즈/특수 정리**: 결과발표·정산·채용 등 비신청성 공지는 기본 숨김(LLM 없이도 규칙으로 동작),
  장애인·보훈 등 특수대상/자동지원은 성격별 필터에서만 노출. 마감 공고는 기본 숨김(토글로 표시).
- **생활밀착 우선 노출**: 음식물처리기·보일러·자격증 응시료 등 실생활 정보를 주제(토픽)로 묶어 전면 배치.

## 데이터 소스 (모두 공식 OpenAPI + 공고)
| 소스 | 내용 | 범위 |
|---|---|---|
| A. 복지로(지자체) | `LcgvWelfarelist` | 전국 17개 시·도 순회 |
| B. 복지로(중앙) | `NationalWelfarelistV001` | 전국(중앙부처) |
| C. 보조금24 | `odcloud gov24/v3/serviceList` | 전수 스캔 → 전국 시·군·구 매핑 |
| D. 온통청년 | `youthcenter getPlcy` | 전국 청년정책 |
| E. 구청 공고(정적) | 구청 `.asp/.jsp` 게시판 | 인천(직접수집) |
| F. 구청 공고(헤드리스) | JS 렌더 게시판(Playwright) | 인천(직접수집) |

최근 수집 실적: **전국 17개 시·도 / 269개 시·군·구, 13,718건**(보조금24 15,000건 전수 스캔 등).
앱은 `yeonsu_youth_live.json`(실데이터) → `yeonsu_youth.json`(검증 시드) → 임베드 순으로 자동 폴백.

### 지역 매핑 (`scraper/korea_regions.mjs`)
소관기관명/부서명에서 **시·도를 먼저 확정한 뒤 그 시·도 안에서만 시·군·구를 탐색** → 동명(중구·동구·고성군,
경기 광주시 vs 광주광역시) 혼선 제거. 진짜 중앙부처/공공기관만 '전국'으로 분류.

## LLM 보강 (선택)
`GEMINI_API_KEY` 있으면 신규 공고만 Gemini(`gemini-2.5-flash-lite`)로 카테고리/태그/요약/노출가치 분류 →
`data/llm_cache.json`에 캐시(중복분류 방지). **키 없거나 쿼터 초과 시 규칙기반으로 자동 폴백**하므로 필터는 항상 동작.

## 인천 구·동 게시판 직접수집 (공식 API에 없는 동네 고유 공고)
- `scraper/discover_incheon.mjs` — 인천 10개 구·군 홈을 훑어 '지원공고 보유' 게시판(구 + 읍·면·동 주민센터)을
  자동 발견 → `data/incheon_boards.json` → `boards.mjs`가 수집 대상에 자동 합류.
- ⚠️ **현실**: 한국 지자체 사이트가 GitHub 러너의 해외 IP를 차단 → 현재 클라우드에선 **연수구만 접속**되고
  나머지 인천 구·군은 `fetch failed`. 동 단위까지 확장하려면 **한국 IP 경로**가 필요.
- **해결**: `PROXY_URL` 시크릿(한국 HTTP/HTTPS 프록시)을 넣으면 게시판 fetch·헤드리스 브라우저가 그 경로로
  라우팅(`scraper/net.mjs`). 공공 API 대량 스캔은 직결 유지(대역폭 절약). 미설정 시 조용히 직결 폴백.

## 자동화 (GitHub Actions)
- `youth-benefits.yml` — 메인 수집·배포. 매일 **06/10/14시(KST)** + 푸시 시. (`DATA_GO_KR_KEY`/`YOUTH_API_KEY`/`GEMINI_API_KEY`/`PROXY_URL`)
- `boards-headless.yml` — JS 게시판 헤드리스 수집(매일 05:30 KST), 결과 커밋.
- `discover-incheon.yml` — 인천 구·동 게시판 발견(매주 월 + 수동/푸시), 결과 커밋.

### 시크릿 (저장소 Settings → Secrets and variables → Actions)
| 이름 | 용도 | 필수 |
|---|---|---|
| `DATA_GO_KR_KEY` | 복지로·보조금24 | ✅ |
| `YOUTH_API_KEY` | 온통청년 | 선택 |
| `GEMINI_API_KEY` | LLM 분류·총평 | 선택 |
| `PROXY_URL` | 한국 IP 프록시(인천 구·동 직접수집) | 선택 |

## 로컬 실행 / 검증
```bash
# 앱: 빌드 불필요, 브라우저로 열기
python3 -m http.server 8000      # http://localhost:8000/youth-benefits-demo/

# 수집(키 필요): 전국 멀티소스
DATA_GO_KR_KEY=xxxx node youth-benefits-demo/scraper/fetch_sources.mjs

# 네트워크/키 없이 로직 검증
node youth-benefits-demo/scraper/fetch_sources.mjs --selftest   # 30/30
node youth-benefits-demo/scraper/fetch_youth_api.mjs --selftest # 10/10

# 인천 게시판 발견(프록시 있으면 PROXY_URL 지정)
node youth-benefits-demo/scraper/discover_incheon.mjs
```
> 이 원격 샌드박스는 allowlist 정책이라 정부/Gemini 도메인이 403으로 막힘 → 실수집은 GitHub Actions 러너에서 수행.

## 파일 구조
```
youth-benefits-demo/
  index.html                     # 프런트(지역 캐스케이드·필터·합산·공유)
  scraper/
    fetch_sources.mjs            # 메인 멀티소스 수집 + 병합/중복제거 + LLM 분류
    korea_regions.mjs            # 전국 시도→시군구 표 + 소관기관명 파서
    fetch_youth_api.mjs          # 온통청년 정규화
    boards.mjs                   # 구청 공고(정적) 수집 + 발견결과 병합
    boards_headless.mjs          # JS 게시판(Playwright) 수집
    discover_incheon.mjs         # 인천 구·동 게시판 자동 발견
    net.mjs                      # PROXY_URL(한국 IP) 라우팅
  data/                          # live/seed/cache/boards json
```

## 로드맵
1. `PROXY_URL` 연결 → 인천 전 구·동 직접수집 자동화 → 전국 시·군·구로 확장.
2. 알림: "신청 D-7" 푸시로 놓친 돈 회수.
3. 성능: 데이터가 커지면 시·도별 분할 로딩.
