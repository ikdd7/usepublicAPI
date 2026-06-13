# 🏘️ 우리동네 복지·지원 (Local Welfare & Benefits Finder)

> **전국 시·도/시·군·구로 흩어진 복지·지원 혜택을 한곳에 모아, 지역·나이·상황만 고르면
> "내가 받을 수 있는 것"만 골라주고 최대 수령액까지 합산해주는 서비스.**
>
> 복지로(지자체·중앙) · 보조금24 · 온통청년 **공공 OpenAPI** + 구청 공고를 매일 자동 수집.

🔗 **라이브:** https://ikdd7.github.io/usepublicAPI/ · 매일 **06/10/14시(KST)** 자동 갱신

---

## 💡 왜 이 니치인가
| 항목 | 내용 |
|---|---|
| **페인포인트** | 혜택이 **거주지마다 천차만별**인데 **나만 몰라서 못 받음** |
| **빈칸** | 보조금24·토스는 *중앙* 혜택 위주, **시·군·구의 hyperlocal 혜택은 빵꾸가 큼** |
| **"좋아!" 포인트** | "헐 우리 동네에 이런 게? 나 OOO만원 받네" → **발견의 쾌감 = 공유 동력** |
| **진짜 해자** | 지자체 데이터 **수집·구조화·최신화·중복정리** (기술이 아니라 운영력) |

---

## 🧩 동작 (`youth-benefits-demo/`)
**시·도 → 시·군·구** 선택 + 나이 + 상황(구직중·무주택·저소득·한부모·장애인…) + **직업**(농어업인·예술인·운수종사자·제대군인) 선택 →
- ✅ **받을 수 있는 혜택만** 필터 + 🔒 안 되는 건 *이유까지* 표시
- 💰 **"최대 OOO만원"** 자동 합산 배너 + 💬 공유
- **같은 사업 자동 병합**(여러 소스·여러 동 중복 → 한 건, 출처 합산), 마감·공지·특수지원은 기본 정리(토글로 열람)
- 생활밀착(음식물처리기·보일러·자격증 응시료 등)·태양광·육아·장애인 등 **주제별** 모아보기

최근 실적: **전국 17개 시·도 / 269개 시·군·구, 13,718건.**

---

## 🔌 데이터 소스 (모두 공식 OpenAPI + 공고)
- **복지로 지자체**(`LcgvWelfarelist`) — 전국 17개 시·도 순회
- **복지로 중앙**(`NationalWelfarelistV001`) — 중앙부처
- **보조금24**(`odcloud gov24/v3/serviceList`) — 전수 스캔 → 전국 시·군·구 매핑
- **온통청년**(`youthcenter getPlcy`) — 전국 청년정책
- **구청 공고**(정적 `.asp/.jsp` + 헤드리스) — 인천(직접수집)
- **지역 매핑**: 시·도 먼저 확정 후 그 안에서 시·군·구 탐색 → 동명(중구·고성군, 경기 광주시 vs 광주광역시) 혼선 제거.
- **LLM 보강(선택)**: `GEMINI_API_KEY` 있으면 신규 공고만 분류·요약(캐시). 없거나 쿼터 초과 시 규칙기반 폴백 → 필터는 항상 동작.

> ⚠️ **현실 체크**: 한국 지자체 사이트는 GitHub 러너의 **해외 IP를 차단**(인천 9/10 `fetch failed`).
> 동 단위 직접수집은 **한국 IP 프록시(`PROXY_URL` 시크릿)** 를 넣으면 자동 활성화(공공 API 스캔은 직결 유지).

---

## ☁️ 배포 — PC 없이 클라우드에서 (GitHub Actions + Pages)
- `youth-benefits.yml` — 메인 수집·배포(매일 06/10/14시 KST + 푸시)
- `boards-headless.yml` — JS 게시판 헤드리스 수집(매일 05:30 KST)
- `discover-incheon.yml` — 인천 구·동 게시판 자동 발견(매주 월 + 수동/푸시)

**시크릿 (Settings → Secrets and variables → Actions):**
| 이름 | 용도 | 필수 |
|---|---|---|
| `DATA_GO_KR_KEY` | 복지로·보조금24 | ✅ |
| `YOUTH_API_KEY` | 온통청년 | 선택 |
| `GEMINI_API_KEY` | LLM 분류·총평 | 선택 |
| `PROXY_URL` | 한국 IP 프록시(인천 구·동 직접수집) | 선택 |

→ 공개 URL: **`https://ikdd7.github.io/usepublicAPI/`** (키 미설정 시 검증 시드로 배포되어 사이트는 정상 표시)

---

## 🖥️ 로컬에서 보기 / 검증
```bash
cd youth-benefits-demo
python3 -m http.server 8000        # http://localhost:8000

# 전국 멀티소스 수집(키 필요)
DATA_GO_KR_KEY="발급키" node scraper/fetch_sources.mjs

# 네트워크/키 없이 로직 검증
node scraper/fetch_sources.mjs --selftest     # 30/30
node scraper/fetch_youth_api.mjs --selftest   # 10/10
```
> 원격 샌드박스는 allowlist라 정부/Gemini 도메인 403 → 실수집은 GitHub Actions 러너에서 수행.

---

## 📁 저장소 구조
```
youth-benefits-demo/
  index.html                  지역 캐스케이드·다차원 필터·합산·공유 UI
  scraper/
    fetch_sources.mjs         메인 멀티소스 수집 + 병합/중복제거 + LLM 분류
    korea_regions.mjs         전국 시도→시군구 표 + 소관기관명 파서
    fetch_youth_api.mjs       온통청년 정규화
    boards.mjs                구청 공고(정적) + 발견결과 병합
    boards_headless.mjs       JS 게시판(Playwright)
    discover_incheon.mjs      인천 구·동 게시판 자동 발견
    net.mjs                   PROXY_URL(한국 IP) 라우팅
  data/                       live/seed/cache/boards json
.github/workflows/            youth-benefits · boards-headless · discover-incheon
README.md                     상세 문서(youth-benefits-demo/README.md)
```

---

## 🔮 로드맵
1. `PROXY_URL` 연결 → 인천 전 구·동 직접수집 자동화 → 전국 시·군·구 확장
2. 알림: "신청 D-7" 푸시로 *놓친 돈 회수*
3. 성능: 데이터가 커지면 시·도별 분할 로딩
4. 수익화: 발견 무료 + 신청 서류대행 업셀, 지자체·지역업체 제휴

---

## ⚖️ 면책
표시 정보는 공개자료·공공API 기반 **참고용**이며 금액·기간·조건은 변동될 수 있습니다.
신청 전 **복지로·보조금24·관할 시·군·구청** 등 공식 출처로 반드시 확인하세요.
