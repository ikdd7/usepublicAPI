# 🏘️ 우리동네 청년혜택 (Local Youth Benefits Finder)

> **시군구(지자체) 단위로 흩어진 청년 지원금·혜택을 한곳에 모아, 나이·상황만 넣으면
> "내가 받을 수 있는 것"만 골라주고 최대 수령액까지 합산해주는 서비스.**
>
> 첫 타깃: **인천광역시 연수구 · 청년(만 18~39세)**

---

## 💡 왜 이 니치인가

| 항목 | 내용 |
|---|---|
| **페인포인트** | 혜택이 **거주지마다 천차만별**(인천 출생아 최대 1억 vs 서울 13개구 폐지)인데 **나만 몰라서 못 받음** |
| **빈칸** | 보조금24·토스·카카오는 *중앙정부* 혜택은 모으지만, **229개 시군구의 hyperlocal 혜택은 빵꾸가 큼** |
| **"좋아!" 포인트** | "헐 우리 구에 이런 게? 나 OOO만원 받네" → **발견의 쾌감 = 공유 동력** |
| **진짜 해자** | 지자체 데이터 **수집·구조화·최신화** (기술이 아니라 운영력). 정부사이트는 크롤이 막혀 있어 아무나 못 함 |

---

## 🧩 무엇을 만들었나 (`youth-benefits-demo/`)

나이·상황(무주택/구직중/재직중/별거)을 입력하면:
- ✅ **받을 수 있는 혜택만** 필터 + 🔒 안 되는 건 *이유까지* 표시
- 💰 **"최대 OOO만원"** 자동 합산 배너 + 💬 카톡 공유
- 각 혜택: 금액 · 신청 **D-day** · 문의처 · 공식 출처 링크

현재 수록(인천/연수구 청년): 청년월세 · 드림체크카드 · 면접수당 · 드림For청년통장 · 재직청년 복지포인트 · 마음건강.

---

## 🔌 데이터 — 공식 API 연동

- **온통청년 청년정책 OpenAPI** (`한국고용정보원`, data.go.kr/data/15143273)
  - `GET https://www.youthcenter.go.kr/go/ythip/getPlcy`
  - `scraper/fetch_youth_api.mjs` 가 호출 → **연수구·청년 필터** → 표준 스키마 정규화
    (카테고리 매핑 / 금액 텍스트→숫자 / 취업상태→상황태그 / 신청기간→마감일)
- **폴백 체계**: `live.json`(API) → `yeonsu_youth.json`(검증 시드) → HTML 임베드
- **검증**: 정규화 로직 오프라인 셀프테스트 **10/10 통과** (`node scraper/fetch_youth_api.mjs --selftest`)

> ⚠️ **현실 체크**: 정부/지자체 사이트는 직접 크롤이 **HTTP 403**으로 막힌다(데모에서 실측).
> 그래서 정공법은 **공식 오픈API + 제휴**이며, API에도 안 잡히는 *연 1회성 지자체 고유 혜택*까지
> 모으는 **수집 운영력**이 결국 해자가 된다.

---

## ☁️ 배포 — PC 없이 클라우드에서 (GitHub Actions + Pages)

`.github/workflows/youth-benefits.yml` 가 GitHub 클라우드 러너에서 API를 호출하고 Pages로 배포한다.
(러너는 인터넷이 열려 있어 `youthcenter.go.kr` 호출 가능)

**설정 (브라우저 클릭만, 본인 PC 불필요):**
1. **Settings → Secrets and variables → Actions** → `YOUTH_API_KEY` 등록 (data.go.kr 발급키)
2. **Settings → Pages → Source: `GitHub Actions`**
3. **Actions 탭 → "청년혜택 실데이터 수집 & 배포" → Run workflow**

→ 공개 URL: **`https://ikdd7.github.io/Test3/`** · 이후 **매일 06시(KST) 자동 갱신**
(키 미설정 시 검증 시드로 배포되어 사이트는 정상 표시)

---

## 🖥️ 로컬에서 보기

```bash
cd youth-benefits-demo
python3 -m http.server 8000        # http://localhost:8000

# 실데이터 수집(네트워크 허용 환경 + 키 필요)
YOUTH_API_KEY="발급키" node scraper/fetch_youth_api.mjs
```

---

## 📁 저장소 구조

```
youth-benefits-demo/          ★ 현재 메인 프로젝트
  index.html                  나이·상황 필터 + 최대수령액 합산 UI
  data/yeonsu_youth.json      검증 시드(공개정보 기반)
  scraper/fetch_youth_api.mjs 온통청년 API 연동 + 정규화 + 셀프테스트
  scraper/scrape.py           직접 크롤 골격(403 차단 실측용)
  README.md                   데모 상세 문서
.github/workflows/
  youth-benefits.yml          API 수집 + Pages 자동 배포

# 아이디어 발굴 리서치 로그 (이 결론에 도달한 과정)
MARKET_PIVOT_RESEARCH.md      니치 후보 1차 검증
IDEA_BANK_more.md             추가 라운드(콜포비아/사업계획서/디지털유산 등)
DESIRE_DOPAMINE_PLAYBOOK.md   욕구이론 × 도파민 프레임워크
IDEA_REPORT.md / PERSONA_REVIEW.md   초기 리포트·페르소나 검토

# (참고) 이전 프로토타입 — 경조사비 도우미
index.html, assets/, premium/   루트의 정적 사이트(초기 실험본, 보존용)
```

---

## 🔮 확장 로드맵
1. **지역 확장**: 연수구 → 인천 10개 군·구 → 전국 229개 (수집 파이프라인 일반화)
2. **페르소나 확장**: 청년 → 신혼·출산 / 소상공인 / 어르신
3. **알림**: "신청 D-7" 푸시로 *놓친 돈 회수*
4. **수익화**: 발견 무료 + 신청 서류대행 업셀, 지자체·지역업체 제휴

---

## ⚖️ 면책
표시 정보는 공개자료 기반 **참고용**이며 금액·기간·조건은 변동될 수 있습니다.
신청 전 **인천청년포털·연수구청·복지로** 등 공식 출처로 반드시 확인하세요.
