#!/usr/bin/env node
/**
 * 온통청년(청년정책 통합) OpenAPI 연동 모듈
 * ------------------------------------------------------------------
 * 공식 API: 한국고용정보원_온통청년_청년정책API (data.go.kr/data/15143273)
 *   GET https://www.youthcenter.go.kr/go/ythip/getPlcy
 *
 * 하는 일: 인천 연수구 + 청년(연령) 정책을 실시간으로 받아와
 *          데모가 쓰는 표준 스키마(data/yeonsu_youth_live.json)로 정규화 저장.
 *
 * 필요 조건 2가지 (이 원격 샌드박스에서는 둘 다 막혀있어 실행 불가):
 *   1) 네트워크: 환경의 아웃바운드 정책이 www.youthcenter.go.kr 허용해야 함
 *      (현재 샌드박스는 allowlist라 정부도메인 403)
 *   2) 인증키: data.go.kr에서 위 API 활용신청 후 발급키를 환경변수로
 *      export YOUTH_API_KEY="발급받은키"
 *
 * 실행:  YOUTH_API_KEY=xxxx node scraper/fetch_youth_api.mjs
 * 검증:  node scraper/fetch_youth_api.mjs --selftest   (네트워크/키 없이 정규화 로직만 검증)
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "..", "data", "yeonsu_youth_live.json");

const API = "https://www.youthcenter.go.kr/go/ythip/getPlcy";

// 인천 연수구. zipCd는 법정동코드(시군구 prefix). 인천=28, 연수구=28185.
const REGION = { sido: "28", sigungu: "28185", label: "인천광역시 연수구" };
const PERSONA = { name: "청년", ageMin: 18, ageMax: 39 };

// 온통청년 대분류(lclsfNm) -> 데모 카테고리
const CAT = {
  "일자리": "일자리", "주거": "주거", "교육": "교육",
  "복지문화": "복지", "복지·문화": "복지", "참여권리": "참여",
};

/* ---------- 정규화 (핵심: 비정형 API응답 -> 표준 스키마) ---------- */

// 지원내용 텍스트에서 최대 금액(원) 추정. 못 찾으면 0.
export function parseAmount(text = "") {
  if (!text) return 0;
  const t = text.replace(/,/g, "");
  let max = 0;
  // "최대 300만원", "월 50만 원", "1,080만원" 등
  const re = /(\d+(?:\.\d+)?)\s*억|\b(\d{2,})\s*만\s*원?|\b(\d{3,})\s*원/g;
  let m;
  while ((m = re.exec(t))) {
    let won = 0;
    if (m[1]) won = parseFloat(m[1]) * 100000000;
    else if (m[2]) won = parseInt(m[2]) * 10000;
    else if (m[3]) won = parseInt(m[3]);
    if (won > max) max = won;
  }
  return max;
}

// 취업상태코드(jobCd) + 단서텍스트 -> 데모 상황태그(need)
export function deriveNeed(p) {
  const need = new Set();
  const job = `${p.jobCd || ""}`;
  const blob = `${p.plcySprtCn || ""} ${p.addAplyQlfcCndCn || ""} ${p.plcyMajorCn || ""} ${p.ptcpPrpTrgtCn || ""}`;
  const isJobless = /미취업|구직|실업|취업준비/.test(job + blob);
  if (isJobless) need.add("구직중");
  // '미취업자'에 '취업자'가 포함되므로 미취업이면 재직 태깅 금지
  if (!isJobless && /재직|근로자|직장인|자영업|프리랜서/.test(job + blob)) need.add("재직중");
  if (/무주택/.test(blob)) need.add("무주택");
  if (/별도\s*거주|독립|부모.{0,4}별거|임차|월세|전세/.test(blob)) need.add("독립");
  return [...need];
}

// "YYYYMMDD ~ YYYYMMDD" / "상시" 등에서 종료일(YYYY-MM-DD) 추출
export function parseEnd(p) {
  const s = `${p.aplyYmd || p.bizPrdEndYmd || ""}`;
  const ds = s.match(/(\d{4})[.\-/]?(\d{2})[.\-/]?(\d{2})/g);
  if (!ds || !ds.length) return null;
  const last = ds[ds.length - 1].replace(/[^\d]/g, "");
  return `${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6, 8)}`;
}

export function normalize(p) {
  const sprt = p.plcySprtCn || p.plcyExplnCn || "";
  return {
    id: p.plcyNo || p.bizId || cryptoId(p.plcyNm),
    title: (p.plcyNm || "이름 없음").trim(),
    category: CAT[p.lclsfNm] || p.lclsfNm || "기타",
    amount: parseAmount(sprt),
    amount_label: clip(sprt, 70) || "상세 참조",
    age_min: numOr(p.sprtTrgtMinAge, PERSONA.ageMin),
    age_max: numOr(p.sprtTrgtMaxAge, PERSONA.ageMax),
    need: deriveNeed(p),
    apply_end: parseEnd(p),
    how: clip(p.plcyAplyMthdCn, 60) || "공식 페이지 참조",
    contact: p.rgtrInstCdNm || p.plcyPvsnInstNm || REGION.label,
    source: p.aplyUrlAddr || p.refUrlAddr1 ||
      "https://www.youthcenter.go.kr/youthPolicy/ythPlcyTotalSearch",
  };
}

const numOr = (v, d) => (v !== undefined && v !== null && `${v}`.trim() !== "" && !isNaN(+v) ? +v : d);
const clip = (s, n) => (s ? `${s}`.replace(/\s+/g, " ").trim().slice(0, n) : "");
const cryptoId = (s) => "p" + Buffer.from(s || "" + Math.random()).toString("hex").slice(0, 10);

// 지역/연령 매칭 (인천 연수구 + 청년 연령대 겹침)
export function matchRegion(p) {
  const zip = `${p.zipCd || ""}`;
  const inst = `${p.rgtrInstCdNm || ""}${p.rgtrUpInstCdNm || ""}`;
  if (zip.split(",").some((z) => z.trim().startsWith(REGION.sido))) return true; // 인천 전역
  if (/인천|연수/.test(inst)) return true;
  return false;
}
export function matchAge(p) {
  const lo = numOr(p.sprtTrgtMinAge, 0), hi = numOr(p.sprtTrgtMaxAge, 200);
  return lo <= PERSONA.ageMax && hi >= PERSONA.ageMin; // 구간 겹침
}

/* ---------- API 호출 ---------- */
export async function fetchPage(key, pageNum, pageSize = 100) {
  const u = new URL(API);
  u.search = new URLSearchParams({
    apiKeyNm: key, rtnType: "json", pageNum: `${pageNum}`, pageSize: `${pageSize}`,
    pageType: "1", zipCd: `${REGION.sido}`, // 인천 전역 후 코드단에서 연수구/청년 필터
  }).toString();
  const res = await fetch(u, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  const j = await res.json();
  const r = j.result || j;
  const list = r.youthPolicyList || r.policyList || [];
  const total = r?.pagging?.totCount ?? r?.totCount ?? list.length;
  return { list, total };
}

async function run() {
  let key = process.env.YOUTH_API_KEY;
  if (!key) { console.error("✗ YOUTH_API_KEY 환경변수가 없습니다. (data.go.kr 발급 필요)"); process.exit(1); }
  // data.go.kr은 인코딩/디코딩 키 2종 제공. URLSearchParams가 한 번 인코딩하므로
  // 인코딩키(%2F,%3D 포함)가 들어오면 디코딩해서 이중 인코딩을 방지한다.
  if (/%[0-9A-Fa-f]{2}/.test(key)) key = decodeURIComponent(key);
  console.log("== 온통청년 청년정책 API 수집 시작 ==");
  let page = 1, all = [], total = Infinity;
  while ((page - 1) * 100 < total && page <= 30) {
    const { list, total: t } = await fetchPage(key, page);
    total = t;
    all.push(...list);
    if (!list.length) break;
    page++;
  }
  const picked = all.filter((p) => matchRegion(p) && matchAge(p)).map(normalize);
  const out = {
    meta: {
      region: REGION.label, personas: [`${PERSONA.name}(만 ${PERSONA.ageMin}~${PERSONA.ageMax}세)`],
      snapshot_date: new Date().toISOString().slice(0, 10),
      source: "온통청년 청년정책 OpenAPI (data.go.kr 15143273)",
      fetched: all.length, matched: picked.length,
    },
    benefits: picked,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2), "utf-8");
  console.log(`✓ 전체 ${all.length}건 중 연수구·청년 ${picked.length}건 -> ${OUT}`);
}

/* ---------- 오프라인 셀프테스트 (네트워크/키 불필요) ---------- */
function selftest() {
  const mock = {
    plcyNo: "R2026INCHEON001",
    plcyNm: "드림체크카드(구직활동비 지원)",
    lclsfNm: "일자리",
    plcyExplnCn: "미취업 청년 구직활동 지원",
    plcySprtCn: "월 50만원씩 최대 6개월, 최대 300만원(드림체크카드 30 + 인천e음 20)",
    sprtTrgtMinAge: "18", sprtTrgtMaxAge: "39",
    jobCd: "미취업자",
    aplyYmd: "20260101 ~ 20261231",
    plcyAplyMthdCn: "인천청년포털 온라인 신청",
    rgtrInstCdNm: "인천광역시", zipCd: "2818500000",
    aplyUrlAddr: "https://youth.incheon.go.kr/job/dream.jsp",
  };
  const n = normalize(mock);
  const checks = [
    ["title", n.title === "드림체크카드(구직활동비 지원)"],
    ["category 매핑", n.category === "일자리"],
    ["amount 파싱(300만)", n.amount === 3000000],
    ["age", n.age_min === 18 && n.age_max === 39],
    ["need 구직중", n.need.includes("구직중")],
    ["apply_end", n.apply_end === "2026-12-31"],
    ["regionMatch(인천)", matchRegion(mock) === true],
    ["ageMatch", matchAge(mock) === true],
    ["parseAmount 억", parseAmount("최대 1억원 지원") === 100000000],
    ["parseAmount 월만원", parseAmount("월 20만원") === 200000],
  ];
  let ok = 0;
  for (const [name, pass] of checks) { console.log(`${pass ? "✓" : "✗ FAIL"}  ${name}`); if (pass) ok++; }
  console.log(`\n결과: ${ok}/${checks.length} 통과`);
  console.log("정규화 출력 예시:\n", JSON.stringify(n, null, 2));
  process.exit(ok === checks.length ? 0 : 1);
}

// 직접 실행할 때만 동작 (다른 모듈에서 import 시 자동 실행 방지)
import { pathToFileURL } from "node:url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.includes("--selftest")) selftest();
  else run().catch((e) => { console.error("✗ 수집 실패:", e.message); process.exit(1); });
}
