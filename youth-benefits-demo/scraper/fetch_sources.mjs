#!/usr/bin/env node
/**
 * 멀티소스 복지혜택 수집기 — 복지로(지자체/중앙) + 보조금24 + 온통청년
 * ------------------------------------------------------------------
 * 소스 (모두 공식 OpenAPI):
 *  A. 복지로 지자체복지서비스  data.go.kr/data/15108347  (XML)  ← 시군구 혜택 그 자체
 *  B. 복지로 중앙부처복지서비스 data.go.kr/data/15090532  (XML)
 *  C. 보조금24 공공서비스(혜택) data.go.kr/data/15113968  (JSON, odcloud)
 *  D. 온통청년 청년정책        (별도 키, fetch_youth_api.mjs 재사용)
 *
 * 키: A·B·C는 data.go.kr serviceKey 1개(DATA_GO_KR_KEY), D는 YOUTH_API_KEY.
 * 키가 없는 소스는 건너뛰고, 수집 총량이 너무 적으면 파일을 쓰지 않아 시드 폴백 유지.
 *
 * 실행:    DATA_GO_KR_KEY=.. [YOUTH_API_KEY=..] node scraper/fetch_sources.mjs
 * 셀프테스트: node scraper/fetch_sources.mjs --selftest   (네트워크/키 불필요)
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { parseAmount, fetchPage as fetchYouthPage, normalize as normalizeYouth, matchRegion, matchAge } from "./fetch_youth_api.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "..", "data", "yeonsu_youth_live.json");

const REGION = { sido: "인천광역시", sigungu: "연수구" };
const AGE = { min: 18, max: 39 };

/* ---------- 공통 유틸 ---------- */
const decodeKey = (k) => (/%[0-9A-Fa-f]{2}/.test(k) ? decodeURIComponent(k) : k);
const clip = (s, n) => (s ? `${s}`.replace(/\s+/g, " ").trim().slice(0, n) : "");

// 어떤 텍스트든 상황태그 추출 (chips: 무주택/구직중/재직중/독립)
export function needFromText(text = "") {
  const need = new Set();
  const jobless = /미취업|구직|실업|취업준비/.test(text);
  if (jobless) need.add("구직중");
  if (!jobless && /재직|근로자|직장인|자영업|프리랜서/.test(text)) need.add("재직중");
  if (/무주택/.test(text)) need.add("무주택");
  return [...need];
}
export const isYouthText = (t = "") => /청년|만\s*(1[89]|[23]\d)\s*세/.test(t);

// 초경량 XML 파서 (flat item 구조 전용 — 복지로 응답이 이 형태)
export function xmlList(xml, itemTag) {
  const items = [];
  const re = new RegExp(`<${itemTag}>([\\s\\S]*?)</${itemTag}>`, "g");
  let m;
  while ((m = re.exec(xml))) {
    const obj = {};
    const fr = /<(\w+)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/\1>/g;
    let f;
    while ((f = fr.exec(m[1]))) obj[f[1]] = f[2].trim();
    items.push(obj);
  }
  return items;
}

async function getText(url) {
  const res = await fetch(url, { headers: { Accept: "*/*" } });
  const body = await res.text();
  // 에러 시 응답 본문을 함께 남겨 원인(미신청/키오류/파라미터)을 로그에서 즉시 진단
  if (!res.ok) throw new Error(`HTTP ${res.status} :: ${clip(body, 260)}`);
  return body;
}

/* ---------- A. 복지로 지자체복지서비스 ---------- */
async function srcBokjiroLocal(key) {
  const base = "https://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations/LcgvWelfarelist";
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const u = `${base}?serviceKey=${encodeURIComponent(key)}&pageNo=${page}&numOfRows=100`
      + `&ctpvNm=${encodeURIComponent(REGION.sido)}&sggNm=${encodeURIComponent(REGION.sigungu)}`;
    const xml = await getText(u);
    if (page === 1) console.log("  [A:원시샘플]", clip(xml, 500));
    const items = xmlList(xml, "servList");
    if (!items.length) break;
    all.push(...items);
    if (items.length < 100) break;
  }
  return all.map(mapBokjiro.bind(null, "복지로(지자체)"));
}

/* ---------- B. 복지로 중앙부처복지서비스 ---------- */
async function srcBokjiroCentral(key) {
  // 문서상 V001 / 구버전 경로가 혼재 → 순차 시도
  const bases = [
    "https://apis.data.go.kr/B554287/NationalWelfareInformationsV001/NationalWelfarelistV001",
    "https://apis.data.go.kr/B554287/NationalWelfareInformations/NationalWelfarelist",
  ];
  let base = null, all = [];
  for (const b of bases) {
    try {
      const xml = await getText(`${b}?serviceKey=${encodeURIComponent(key)}&callTp=L&pageNo=1&numOfRows=100&srchKeyCode=003`);
      console.log("  [B:원시샘플]", clip(xml, 500));
      all = xmlList(xml, "servList");
      base = b;
      break;
    } catch (e) { console.log(`  [B] ${b.split("/").pop()} 실패: ${clip(e.message, 80)}`); }
  }
  if (!base) throw new Error("모든 엔드포인트 실패");
  for (let page = 2; page <= 8 && all.length % 100 === 0 && all.length > 0; page++) {
    const xml = await getText(`${base}?serviceKey=${encodeURIComponent(key)}&callTp=L&pageNo=${page}&numOfRows=100&srchKeyCode=003`);
    const items = xmlList(xml, "servList");
    if (!items.length) break;
    all.push(...items);
  }
  // 전국 단위 → 청년 관련만, 조회수(inqNum) 상위 30 캡
  const youth = all.filter((p) => isYouthText(`${p.servNm} ${p.servDgst} ${p.lifeNmArray || p.lifeArray || ""}`));
  youth.sort((a, b) => (+b.inqNum || 0) - (+a.inqNum || 0));
  return youth.slice(0, 30).map(mapBokjiro.bind(null, "복지로(중앙)"));
}

export function mapBokjiro(srcName, p) {
  const blob = `${p.servNm || ""} ${p.servDgst || ""} ${p.aplyMtdNm || ""}`;
  return {
    id: `bj-${p.servId || Math.random().toString(36).slice(2, 8)}`,
    title: clip(p.servNm, 60) || "이름 없음",
    category: clip((p.intrsThemaNmArray || p.intrsThemaArray || "복지").split(",")[0], 10),
    amount: parseAmount(p.servDgst || ""),
    amount_label: clip(p.servDgst, 70) || "상세 참조",
    age_min: AGE.min, age_max: AGE.max,
    need: needFromText(blob),
    apply_end: null, // 복지로 목록 응답엔 마감일 없음 → '상시·공고 확인'
    how: clip(p.aplyMtdNm, 50) || "복지로/주민센터 문의",
    contact: clip(p.jurOrgNm || p.jurMnofNm || p.bizChrDeptNm, 30) || `${REGION.sido} ${REGION.sigungu}`,
    source: p.servDtlLink ||
      `https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=${p.servId || ""}`,
    _src: srcName,
  };
}

/* ---------- C. 보조금24 (정부24 공공서비스 혜택, odcloud JSON) ---------- */
async function srcGov24(key) {
  const base = "https://api.odcloud.kr/api/gov24/v3/serviceList";
  const picked = [];
  let page = 1, total = Infinity;
  while ((page - 1) * 500 < total && page <= 25) {
    const u = `${base}?serviceKey=${encodeURIComponent(key)}&page=${page}&perPage=500`;
    const j = JSON.parse(await getText(u));
    total = j.totalCount ?? 0;
    const data = j.data || [];
    if (page === 1 && data[0]) console.log("  [C:원시샘플]", clip(JSON.stringify(data[0]), 500));
    for (const it of data) {
      const blob = `${it["서비스명"] || ""} ${it["지원대상"] || ""} ${it["서비스목적요약"] || ""} ${it["소관기관명"] || ""}`;
      const regional = /(인천|연수)/.test(`${it["소관기관명"] || ""}${it["부서명"] || ""}`);
      if (regional && isYouthText(blob)) picked.push(mapGov24(it));
    }
    if (!data.length) break;
    page++;
  }
  return picked.slice(0, 30);
}

export function mapGov24(it) {
  const sprt = it["지원내용"] || it["서비스목적요약"] || "";
  return {
    id: `g24-${it["서비스ID"] || Math.random().toString(36).slice(2, 8)}`,
    title: clip(it["서비스명"], 60) || "이름 없음",
    category: clip(it["서비스분야"] || "혜택", 10),
    amount: parseAmount(sprt),
    amount_label: clip(sprt, 70) || "상세 참조",
    age_min: AGE.min, age_max: AGE.max,
    need: needFromText(`${it["서비스명"]} ${it["지원대상"]} ${sprt}`),
    apply_end: null,
    how: clip(it["신청방법"], 50) || "정부24 확인",
    contact: clip(`${it["소관기관명"] || ""} ${it["부서명"] || ""}`, 30),
    source: it["상세조회URL"] || `https://www.gov.kr/portal/rcvfvrSvc/dtlEx/${it["서비스ID"] || ""}`,
    _src: "보조금24",
  };
}

/* ---------- D. 온통청년 (기존 모듈 재사용) ---------- */
async function srcYouthcenter(key) {
  let all = [], page = 1, total = Infinity;
  while ((page - 1) * 100 < total && page <= 30) {
    const { list, total: t } = await fetchYouthPage(key, page);
    total = t; all.push(...list);
    if (!list.length) break;
    page++;
  }
  if (all[0]) console.log("  [D:원시샘플]", clip(JSON.stringify(all[0]), 500));
  return all.filter((p) => matchRegion(p) && matchAge(p)).map((p) => ({ ...normalizeYouth(p), _src: "온통청년" }));
}

/* ---------- 머지 + 중복제거 ---------- */
export function dedupe(items) {
  const seen = new Map();
  for (const it of items) {
    const k = (it.title || "").toLowerCase().replace(/[\s()\[\]·\-~]/g, "").slice(0, 24);
    const prev = seen.get(k);
    // 금액 정보가 있는 쪽 / 설명 긴 쪽 우선
    if (!prev || (it.amount > prev.amount) || (it.amount === prev.amount && it.amount_label.length > prev.amount_label.length)) {
      seen.set(k, prev ? { ...it, _src: `${prev._src}+${it._src}` } : it);
    }
  }
  return [...seen.values()];
}

/* ---------- 메인 ---------- */
async function run() {
  const dkey = process.env.DATA_GO_KR_KEY ? decodeKey(process.env.DATA_GO_KR_KEY) : null;
  const ykey = process.env.YOUTH_API_KEY ? decodeKey(process.env.YOUTH_API_KEY) : null;
  if (!dkey && !ykey) { console.error("✗ DATA_GO_KR_KEY / YOUTH_API_KEY 둘 다 없음"); process.exit(1); }

  console.log("== 멀티소스 수집 시작 ==");
  const sources = [
    dkey && ["A.복지로(지자체)", () => srcBokjiroLocal(dkey)],
    dkey && ["B.복지로(중앙)", () => srcBokjiroCentral(dkey)],
    dkey && ["C.보조금24", () => srcGov24(dkey)],
    ykey && ["D.온통청년", () => srcYouthcenter(ykey)],
  ].filter(Boolean);

  const collected = [];
  const counts = {};
  for (const [name, fn] of sources) {
    try {
      const items = await fn();
      counts[name] = items.length;
      collected.push(...items);
      console.log(`  ✓ ${name}: ${items.length}건`);
    } catch (e) {
      counts[name] = `실패(${e.message})`;
      console.log(`  ✗ ${name}: ${e.message}`);
    }
  }

  const merged = dedupe(collected);
  console.log(`\n합계 ${collected.length}건 → 중복제거 후 ${merged.length}건`);

  if (merged.length < 4) {
    console.log("⚠️ 수집량 부족(<4) → live 파일 미작성, 검증 시드 유지");
    process.exit(0);
  }
  const out = {
    meta: {
      region: `${REGION.sido} ${REGION.sigungu}`,
      personas: [`청년(만 ${AGE.min}~${AGE.max}세)`],
      snapshot_date: new Date().toISOString().slice(0, 10),
      source: "복지로(지자체·중앙)+보조금24" + (ykey ? "+온통청년" : "") + " 공공API",
      counts,
    },
    benefits: merged.map(({ _src, ...b }) => ({ ...b, contact: b.contact ? `${b.contact} [${_src}]` : `[${_src}]` })),
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2), "utf-8");
  console.log(`✓ 저장: ${OUT}`);
}

/* ---------- 셀프테스트 ---------- */
function selftest() {
  const xml = `<response><body><servList><servId><![CDATA[WLF001]]></servId><servNm>연수구 청년 월세 지원</servNm><servDgst>무주택 청년에게 월 최대 20만원 지원</servDgst><ctpvNm>인천광역시</ctpvNm><sggNm>연수구</sggNm><intrsThemaNmArray>주거,생활지원</intrsThemaNmArray><aplyMtdNm>방문신청</aplyMtdNm></servList><servList><servNm>노인 돌봄</servNm><servDgst>어르신 지원</servDgst></servList></body></response>`;
  const items = xmlList(xml, "servList");
  const a = mapBokjiro("복지로(지자체)", items[0]);
  const g = mapGov24({ "서비스ID": "SVC1", "서비스명": "인천 청년 면접수당", "지원내용": "면접 1회 5만원, 최대 2회 10만원", "지원대상": "구직 청년", "소관기관명": "인천광역시 연수구", "서비스분야": "고용", "신청방법": "온라인" });
  const dup = dedupe([a, { ...a, id: "x", amount: a.amount + 1, _src: "보조금24" }, g]);
  const checks = [
    ["XML 파싱 2건", items.length === 2],
    ["CDATA servId", items[0].servId === "WLF001"],
    ["복지로 title", a.title === "연수구 청년 월세 지원"],
    ["복지로 amount 20만", a.amount === 200000],
    ["복지로 need 무주택", a.need.includes("무주택")],
    ["category 첫 항목", a.category === "주거"],
    ["gov24 amount 10만", g.amount === 100000],
    ["gov24 need 구직중", g.need.includes("구직중")],
    ["청년텍스트 판별", isYouthText("만 25세 청년") && !isYouthText("어르신 지원")],
    ["dedupe 2건+출처병합", dup.length === 2 && dup[0]._src.includes("+")],
  ];
  let ok = 0;
  for (const [name, pass] of checks) { console.log(`${pass ? "✓" : "✗ FAIL"}  ${name}`); if (pass) ok++; }
  console.log(`\n결과: ${ok}/${checks.length} 통과`);
  process.exit(ok === checks.length ? 0 : 1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.includes("--selftest")) selftest();
  else run().catch((e) => { console.error("✗ 수집 실패:", e.message); process.exit(1); });
}
