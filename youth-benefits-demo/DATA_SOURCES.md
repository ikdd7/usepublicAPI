# 📡 복지 데이터소스 로드맵 — 연계 가능한 공식 OpenAPI 카탈로그

> 조사일 2026-06-12 · 목적: 온통청년 외에 **프로그램으로 호출 가능한 공식 복지 API**를 모두 발굴해
> "우리동네 혜택 찾기"를 청년 → 전 생애주기로 확장하기 위한 연동 우선순위표.

## ⭐ 핵심 발견
공공데이터포털(data.go.kr)은 **계정당 인증키(serviceKey) 1개**로, 각 API에 "활용신청"만 추가하면
**같은 키로 전부 호출 가능**. 즉 아래 API들은 키 하나로 통합 연동된다.
(예외: 온통청년처럼 `LINK` 유형은 해당 기관 포털에서 별도 키 발급)

---

## 🥇 1순위 — 우리 컨셉(시군구 혜택 모아보기)에 정조준

| API | 기관 | 내용 | 왜 킬러인가 |
|---|---|---|---|
| **지자체복지서비스** ([15108347](https://www.data.go.kr/data/15108347/openapi.do)) | 한국사회보장정보원(복지로) | **지자체별** 복지서비스 목록·상세 | **우리가 하려는 "시군구 혜택" 그 자체.** 연수구 필터 가능 |
| **중앙부처복지서비스** ([15090532](https://www.data.go.kr/data/15090532/openapi.do)) | 한국사회보장정보원(복지로) | 중앙부처 복지서비스 전체 | 지자체+중앙 합치면 복지로 수준 커버리지 |
| **대한민국 공공서비스(혜택) 정보 = 보조금24** ([15113968](https://www.data.go.kr/data/15113968/openapi.do)) | 행정안전부(정부24) | 부처·지자체·교육청 **수혜서비스** 목록·상세 | 보조금24의 원천 데이터. [gov.kr/openapi](https://www.gov.kr/openapi) 명세 제공 |
| 온통청년 청년정책 (연동 완료) | 한국고용정보원 | 청년정책 전국 | 이미 코드 완성, 키 승인 대기 |

→ **이 3+1개면 "중앙+지자체+청년" 3층 커버리지 완성.** 동일한 normalize 파이프라인에 어댑터만 추가.

## 🥈 2순위 — 페르소나 확장용 (분야별 버티컬)

| 분야 | API | 활용 |
|---|---|---|
| 🏠 주거 | [마이홈 공공임대주택 단지정보](https://www.data.go.kr/data/15110581/openapi.do) (국토부), [LH 단지정보](https://www.data.go.kr/data/15058476/openapi.do) | "우리 동네 입주 가능한 임대주택" — 시도/시군구 코드로 조회 |
| 💼 일자리 | [워크넷(고용24) 채용정보](https://www.data.go.kr/data/3038225/openapi.do) (한국고용정보원) | 구직 청년에게 혜택+일자리 같이 추천 |
| 💰 금융 | [서민금융 대출상품한눈에](https://www.data.go.kr/data/15106208/openapi.do), [서민금융상품기본정보](https://www.data.go.kr/data/15094787/openapi.do) | 햇살론유스 등 "조건 맞는 정책금융" 매칭 |
| 🎓 장학 | [대학별 장학금 정보](https://www.data.go.kr/data/15107739/standard.do), [학자금지원정보(대학생)](https://www.data.go.kr/data/15028252/fileData.do) | 대학생 페르소나 |
| 👶 육아 | [아이돌봄 서비스제공기관](https://www.data.go.kr/data/15078130/openapi.do) (여가부), 어린이집정보공개포털 API | 신혼·출산 페르소나 |
| 🏥 시설 | [사회복지시설정보](https://www.data.go.kr/data/15001848/openapi.do), [사회서비스 제공기관](https://www.data.go.kr/data/15057683/openapi.do) | 어르신·돌봄 페르소나 |

## 연동 아키텍처 (확장 설계)

```
sources/
  youthcenter.mjs    (완성)  온통청년 — 별도 키
  bokjiro_local.mjs  (다음)  지자체복지서비스 ┐
  bokjiro_central.mjs        중앙부처복지서비스 ├ data.go.kr serviceKey 1개
  gov24_benefit.mjs          보조금24 혜택     ┘
        ↓ 각자 fetch
  normalize()  ← 공통 스키마 {title, category, amount, age, need, apply_end, ...}
        ↓ merge + dedupe(같은 사업 중복 제거)
  data/benefits_live.json → 정적 사이트 렌더
```

## 실행 순서 제안
1. **data.go.kr 회원가입 → 인증키 확인** (마이페이지, 자동발급)
2. 1순위 3개 API에 **활용신청** (대부분 자동승인, 즉시)
3. GitHub Secret `DATA_GO_KR_KEY` 추가
4. 어댑터 3개 구현 → 머지/중복제거 → 배포 (현 파이프라인 재사용)
5. 온통청년 키 승인되면 4번째 소스로 합류

## 주의
- 개발계정 트래픽 보통 **일 1,000회** — 우리는 하루 1회 빌드라 여유 충분
- API마다 응답 필드 상이 → 어댑터별 selftest 필수 (온통청년 방식 재사용)
- `LINK` 유형 API는 data.go.kr 키가 아닌 **기관 포털 키** 필요 (신청 전 유형 확인)

> ✅ 2026-06-12: data.go.kr 1순위 3개 API 활용신청 완료 — 멀티소스 실데이터 전환 트리거
