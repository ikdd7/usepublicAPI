#!/usr/bin/env node
/**
 * 멀티소스 + 다지역 + LLM 보강 복지혜택 수집기
 * ------------------------------------------------------------------
 * 소스: 복지로(지자체/중앙) + 보조금24 + 온통청년(모두 공식 OpenAPI) + 구청공고(인천 10개 구·군)
 * 지역: 전국 17개 시·도/시·군·구 (복지로 지자체·보조금24·온통청년) + 인천 게시판 직접수집(프록시)
 * LLM: ANTHROPIC_API_KEY 있으면 태그/지원형태/요약 정밀화 + 첫페이지 총평
 *      (없으면 규칙기반으로 자동 폴백)
 *
 * 키: DATA_GO_KR_KEY(공공데이터), YOUTH_API_KEY(온통청년·선택), ANTHROPIC_API_KEY(LLM·선택)
 * 실행:      DATA_GO_KR_KEY=.. node scraper/fetch_sources.mjs
 * 셀프테스트: node scraper/fetch_sources.mjs --selftest
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { parseAmount, fetchPage as fetchYouthPage, normalize as normalizeYouth, matchRegion, matchAge } from "./fetch_youth_api.mjs";
import { harvestCandidates } from "./boards.mjs";
import { regionOfOrg, KOREA, SIDO_LIST, ctpvAliases } from "./korea_regions.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "..", "data", "yeonsu_youth_live.json");

const SIDO = "인천광역시";
const SIGUNGU = ["중구", "동구", "미추홀구", "연수구", "남동구", "부평구", "계양구", "서구", "강화군", "옹진구"];
const AGE = { min: 18, max: 39 };
const NATIONWIDE = "전국";

const OCC_TAGS = ["농어업인","예술인","운수종사자","제대군인"]; // 직업군(공고에 실제 등장하는 것만)
const CONTROLLED_TAGS = ["구직중","재직중","학생","자영업·창업","1인가구","신혼","임신·출산","육아","한부모","장애인","저소득","무주택", ...OCC_TAGS];
const SUPPORT_TYPES = ["현금","바우처","대출","현물","서비스"];
const CATS = ["주거","일자리","교육","복지","건강","금융","문화","환경·생활","육아","농업","기타"];
const CACHE_FILE = join(__dir, "..", "data", "llm_cache.json");

/* ---------- 공통 유틸 ---------- */
const decodeKey = (k) => (/%[0-9A-Fa-f]{2}/.test(k) ? decodeURIComponent(k) : k);
const clip = (s, n) => (s ? `${s}`.replace(/\s+/g, " ").trim().slice(0, n) : "");

export function needFromText(text = "") {
  const need = new Set();
  const jobless = /미취업|구직|실업|취업준비/.test(text);
  if (jobless) need.add("구직중");
  if (!jobless && /재직|근로자|직장인/.test(text)) need.add("재직중");
  if (/대학생|대학원생|재학생|휴학생/.test(text)) need.add("학생");
  if (/소상공인|자영업|창업자|예비창업/.test(text)) need.add("자영업·창업");
  if (/1인\s*가구/.test(text)) need.add("1인가구");
  if (/신혼|예비\s*부부/.test(text)) need.add("신혼");
  if (/임신|임산부|출산|난임/.test(text)) need.add("임신·출산");
  if (/육아|영유아|보육|양육/.test(text)) need.add("육아");
  if (/한부모|조손/.test(text)) need.add("한부모");
  if (/장애인|장애\s*정도/.test(text)) need.add("장애인");
  if (/기초생활|차상위|저소득|중위소득/.test(text)) need.add("저소득");
  if (/무주택/.test(text)) need.add("무주택");
  // 직업군
  if (/농업인|어업인|농어업|임업인|귀농|농민/.test(text)) need.add("농어업인");
  if (/예술인|문화예술인|공연예술/.test(text)) need.add("예술인");
  if (/운수종사자|화물차주|택시기사|버스기사|배달종사자/.test(text)) need.add("운수종사자");
  if (/제대군인|의무복무.{0,4}전역/.test(text)) need.add("제대군인");
  return [...need];
}
export function supportTypeOf(text = "", hint = "") {
  const t = `${hint} ${text}`;
  if (/대출|융자|이차보전/.test(t)) return "대출";
  if (/바우처|포인트|이용권|상품권|카드\s*지급|지역화폐/.test(t)) return "바우처";
  if (/현물|물품|임대주택|주택\s*공급/.test(t)) return "현물";
  if (/현금|수당|지원금|장려금|급여|비용\s*지원|월\s*\d+|만\s*원/.test(t)) return "현금";
  return "서비스";
}
export const isYouthText = (t = "") => /청년|만\s*(1[89]|[23]\d)\s*세/.test(t);

// 텍스트에서 대상 연령 범위 추출 → [min,max]. 미상이면 전연령 [0,120].
const clampAge = (a) => Math.min(120, Math.max(0, parseInt(a) || 0));
export function parseAgeRange(text = "") {
  const t = text.replace(/\s/g, "");
  let m;
  if ((m = t.match(/만?(\d{1,3})세?[~∼\-–—](\d{1,3})세/))) return [clampAge(m[1]), clampAge(m[2])];
  if ((m = t.match(/(\d{1,3})세이상/))) return [clampAge(m[1]), 120];
  if ((m = t.match(/(\d{1,3})세(?:이하|미만)/))) return [0, clampAge(m[1])];
  if (/영유아|미취학/.test(text)) return [0, 5];
  if (/아동/.test(text)) return [0, 18];
  if (/청소년/.test(text)) return [9, 24];
  if (/대학생|대학원생/.test(text)) return [18, 29];
  if (/청년/.test(text)) return [19, 39];
  if (/노인|어르신|고령|경로(당|우대)?|기초연금|장기요양/.test(text)) return [65, 120];
  if (/고독사|독거|홀몸|무연고|홀로\s*사는/.test(text)) return [50, 120];   // 강한 노년 신호(생애주기 누락 보완)
  return [0, 120]; // 전연령
}

// 신청기한 텍스트 → 마감일(YYYY-MM-DD). 범위면 끝일, 연도없는 끝(~M.D)은 시작연도 사용.
export function parseDeadline(text = "") {
  if (!text) return null;
  const t = String(text).replace(/\s/g, "");
  if (!/20\d{2}/.test(t)) return null;                          // 연도 없으면 상시/수시로 간주
  const fulls = [...t.matchAll(/(20\d{2})[.\-\/년]?(\d{1,2})[.\-\/월]?(\d{1,2})/g)];
  if (!fulls.length) return null;
  let [, y, mo, d] = fulls[fulls.length - 1];
  const tail = t.match(/[~∼\-–](\d{1,2})[.\-\/월](\d{1,2})\.?$/) || t.match(/[~∼\-–](\d{1,2})[.\-\/월](\d{1,2})(?!\d)/);
  if (tail && !/20\d{2}$/.test(t.split(/[~∼\-–]/).pop() || "")) { mo = tail[1]; d = tail[2]; }
  mo = +mo; d = +d;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
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
  if (!res.ok) throw new Error(`HTTP ${res.status} :: ${clip(body, 200)}`);
  return body;
}

/* ---------- A. 복지로 지자체 (전국 17개 시·도 순회) ---------- */
// 시도별로 ctpvNm만 지정해 페이지네이션(시군구는 응답 항목에서 판별). 신명칭 미지원 대비 약식명 폴백.
async function srcBokjiroLocal(key) {
  const base = "https://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations/LcgvWelfarelist";
  const out = [];
  let sampled = false;
  const pagedFetch = async (extra) => {
    const got = [];
    for (let page = 1; page <= 10; page++) {
      try {
        const u = `${base}?serviceKey=${encodeURIComponent(key)}&pageNo=${page}&numOfRows=100${extra}`;
        const xml = await getText(u);
        if (!sampled) { console.log("  [A:원시샘플]", clip(xml, 1100)); sampled = true; }   // 생애주기/대상특성 필드명 확인용
        const items = xmlList(xml, "servList");
        if (!items.length) break;
        got.push(...items);
        if (items.length < 100) break;
      } catch (e) { if (page === 1) throw e; break; }
    }
    return got;
  };
  const fetchSido = async (sido) => {
    // 1차: ctpvNm만(시군구는 응답에서 판별). 신명칭 미지원 대비 약식명 폴백.
    for (const ctpv of ctpvAliases(sido)) {
      try {
        const got = await pagedFetch(`&ctpvNm=${encodeURIComponent(ctpv)}`);
        if (got.length) {
          out.push(...got.map((p) => mapBokjiro("복지로(지자체)", p, regionFromBokjiro(p, sido))));
          console.log(`    · ${sido}: ${got.length}건(시도단위)`);
          return;
        }
      } catch (e) { console.log(`    · ${sido}(${ctpv}) 시도단위 실패: ${clip(e.message, 40)}`); }
    }
    // 2차 폴백: 알려진 시군구를 ctpvNm+sggNm으로 순회(기존 동작 보장).
    let n = 0;
    for (const ctpv of ctpvAliases(sido)) {
      for (const sgg of (KOREA[sido] || [])) {
        try {
          const got = await pagedFetch(`&ctpvNm=${encodeURIComponent(ctpv)}&sggNm=${encodeURIComponent(sgg)}`);
          out.push(...got.map((p) => mapBokjiro("복지로(지자체)", p, `${sido} ${sgg}`)));
          n += got.length;
        } catch {}
      }
      if (n) break;
    }
    console.log(`    · ${sido}: ${n}건${n ? "(시군구순회)" : ""}`);
  };
  await pool(SIDO_LIST, 6, fetchSido);
  return out;
}
// 복지로 지자체 항목의 시도/시군구 필드 우선, 없으면 소관기관명 파싱, 그래도 없으면 순회 시도
function regionFromBokjiro(p, fallbackSido) {
  const ctpv = clip(p.ctpvNm || p.ctpv || "", 12);
  const sgg = clip(p.sggNm || p.sgg || "", 12);
  if (ctpv && sgg) return `${ctpv} ${sgg}`;
  const r = regionOfOrg(`${p.jurOrgNm || ""} ${p.jurMnofNm || ""} ${ctpv} ${sgg}`);
  return r || fallbackSido;
}
// 간단 동시성 풀
async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => {
    while (q.length) { const it = q.shift(); await fn(it); }
  }));
}

/* ---------- B. 복지로 중앙 (전국) ---------- */
async function srcBokjiroCentral(key) {
  const bases = [
    "https://apis.data.go.kr/B554287/NationalWelfareInformationsV001/NationalWelfarelistV001",
    "https://apis.data.go.kr/B554287/NationalWelfareInformations/NationalWelfarelist",
  ];
  let all = [], base = null;
  for (const b of bases) {
    try {
      const xml = await getText(`${b}?serviceKey=${encodeURIComponent(key)}&callTp=L&pageNo=1&numOfRows=100&srchKeyCode=003`);
      console.log("  [B:원시샘플]", clip(xml, 400));
      all = xmlList(xml, "servList"); base = b; break;
    } catch (e) { console.log(`  [B] ${b.split("/").pop()}: ${clip(e.message, 70)}`); }
  }
  if (!base) throw new Error("모든 엔드포인트 실패");
  for (let page = 2; page <= 3; page++) {
    try {
      const xml = await getText(`${base}?serviceKey=${encodeURIComponent(key)}&callTp=L&pageNo=${page}&numOfRows=100&srchKeyCode=003`);
      const items = xmlList(xml, "servList");
      if (!items.length) break;
      all.push(...items);
    } catch { break; }
  }
  all.sort((a, b) => (+b.inqNum || 0) - (+a.inqNum || 0)); // 조회순(인기순)
  return all.slice(0, 60).map((p) => mapBokjiro("복지로(중앙)", p, NATIONWIDE));
}

// 복지로 생애주기(lifeNmArray) → 정확한 나이범위. 복지로 사이트와 동일한 기준.
const LIFE_AGE = { "영유아":[0,5], "아동":[6,12], "청소년":[13,18], "청년":[19,39], "중장년":[40,64], "노년":[65,120] };
export function ageFromLife(life){
  const t = `${life || ""}`; let lo = null, hi = null;
  for (const k of Object.keys(LIFE_AGE)) {
    if (t.includes(k)) { const [a, b] = LIFE_AGE[k]; lo = lo === null ? a : Math.min(lo, a); hi = hi === null ? b : Math.max(hi, b); }
  }
  return [lo, hi];
}
// 복지로 대상특성/가구(trgterIndvdlNmArray) → 우리 상황 태그(텍스트 추정 대신 공식 코드)
export function tagsFromTrg(trg){
  const t = `${trg || ""}`, s = new Set();
  if (/다문화|탈북|북한이탈/.test(t)) s.add("다문화");
  if (/장애/.test(t)) s.add("장애인");
  if (/한부모|조손/.test(t)) s.add("한부모");
  if (/저소득/.test(t)) s.add("저소득");
  if (/다자녀/.test(t)) s.add("다자녀");
  if (/1인\s*가구|독거/.test(t)) s.add("1인가구");
  if (/임신|출산|임산부/.test(t)) s.add("임신·출산");
  return [...s];
}
export function mapBokjiro(srcName, p, region) {
  const blob = `${p.servNm || ""} ${p.servDgst || ""} ${p.aplyMtdNm || ""}`;
  const life = p.lifeNmArray || p.lifeArray || "";
  const trg = p.trgterIndvdlNmArray || p.trgterIndvdlArray || "";
  let [age_min, age_max] = ageFromLife(life);                 // ① 생애주기(공식) 우선
  if (age_min === null) [age_min, age_max] = parseAgeRange(blob);  // ② 없으면 텍스트 추정
  const need = [...new Set([...needFromText(blob), ...tagsFromTrg(trg)])];   // 텍스트 + 공식 대상특성
  return {
    id: `bj-${p.servId || Math.random().toString(36).slice(2, 8)}`,
    title: clip(p.servNm, 60) || "이름 없음",
    category: clip((p.intrsThemaNmArray || p.intrsThemaArray || "복지").split(",")[0], 10),
    region: region || NATIONWIDE,
    amount: parseAmount(p.servDgst || ""),
    amount_label: clip(p.servDgst, 80) || "상세 참조",
    age_min, age_max,
    need,
    target: clip([life, trg].filter(Boolean).join(" · "), 60),  // 공식 생애주기·대상특성을 '대상'으로
    support_type: supportTypeOf(blob, p.srvPvsnNm || ""),
    apply_end: null,
    how: clip(p.aplyMtdNm, 50) || "복지로/주민센터 문의",
    contact: clip(p.jurOrgNm || p.jurMnofNm, 30) || region || SIDO,
    source: p.servDtlLink || `https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=${p.servId || ""}`,
    raw: clip(`${p.servNm} ${p.servDgst}`, 300),
    _src: srcName,
  };
}

/* ---------- C. 보조금24 (전국+지역 혼합) ---------- */
async function srcGov24(key, cap = 200) {
  const base = "https://api.odcloud.kr/api/gov24/v3/serviceList";
  const picked = [];
  let page = 1, total = Infinity, sampled = false;
  while ((page - 1) * 500 < total && page <= 60) {   // 전수 스캔(최대 30k)
    let j = null;
    for (let t = 0; t < 3 && !j; t++) {   // odcloud 일시 오류(400 UNKNOWN) 재시도
      try { j = JSON.parse(await getText(`${base}?serviceKey=${encodeURIComponent(key)}&page=${page}&perPage=500`)); }
      catch (e) { if (t === 2) throw e; await sleep(2500); }
    }
    total = j.totalCount ?? 0;
    const data = j.data || [];
    if (!sampled && data[0]) { console.log("  [C:원시샘플]", clip(JSON.stringify(data[0]), 200)); sampled = true; }
    for (const it of data) {
      const region = regionOfOrg(`${it["소관기관명"] || ""}${it["부서명"] || ""}`);
      if (region) picked.push(mapGov24(it, region));
    }
    if (!data.length) break;
    page++;
  }
  console.log(`  [C] 전수 ${total}건 중 인천·전국 ${picked.length}건`);
  return picked; // 캡은 run()에서 정책적으로(인천 전부 + 전국 상위) 적용
}
// 소관기관명 → 지역 매핑은 korea_regions.mjs(regionOfOrg, 전국 17개 시도)로 일원화.
// 보조금24 마감일: 전용 필드 → 설명문 안의 '신청기간/접수기간 …' 구절 순으로
function gov24Deadline(it) {
  let d = parseDeadline(it["신청기한"] || it["신청기간"] || it["신청기간및방법"] || "");
  if (d) return d;
  const dt = `${it["서비스목적요약"] || ""} ${it["지원내용"] || ""} ${it["신청방법"] || ""} ${it["지원대상"] || ""}`;
  const m = dt.match(/(?:신청|접수|모집|운영)\s*기[간한][^\n]{0,55}/);   // '신청기간 …' 구절만(잡음 배제)
  return m ? parseDeadline(m[0]) : null;
}
export function mapGov24(it, region) {
  const sprt = it["지원내용"] || it["서비스목적요약"] || "";
  const [age_min, age_max] = parseAgeRange(`${it["지원대상"] || ""} ${it["선정기준"] || ""} ${it["서비스명"] || ""}`);
  return {
    id: `g24-${it["서비스ID"] || Math.random().toString(36).slice(2, 8)}`,
    title: clip(it["서비스명"], 60) || "이름 없음",
    category: clip(it["서비스분야"] || "혜택", 10),
    region: region || NATIONWIDE,
    amount: parseAmount(sprt),
    amount_label: clip(sprt, 80) || "상세 참조",
    age_min, age_max,
    target: clip(`${it["지원대상"] || ""}`.replace(/[\(（][^)）]*[\)）]/g, " "), 110),  // 공식 지원대상 원문
    need: needFromText(`${it["서비스명"]} ${it["지원대상"]} ${it["선정기준"] || ""} ${sprt}`),
    support_type: supportTypeOf(sprt, it["지원유형"] || ""),
    apply_end: gov24Deadline(it),   // 마감 지난 공고 필터용(전용필드+설명문 폴백)
    how: clip(it["신청방법"], 50) || "정부24 확인",
    contact: clip(`${it["소관기관명"] || ""} ${it["부서명"] || ""}`, 30),
    source: it["상세조회URL"] || `https://www.gov.kr/portal/rcvfvrSvc/dtlEx/${it["서비스ID"] || ""}`,
    raw: clip(`${it["서비스명"]} ${it["지원대상"]} ${sprt}`, 300),
    _src: "보조금24",
  };
}

/* ---------- D. 온통청년 (전국 청년정책) ---------- */
async function srcYouthcenter(key) {
  let all = [], page = 1, total = Infinity;
  while ((page - 1) * 100 < total && page <= 80) {
    const { list, total: t } = await fetchYouthPage(key, page, 100, ""); // zipCd 비움 = 전국
    total = t; all.push(...list);
    if (!list.length) break;
    page++;
  }
  return all.filter((p) => matchAge(p))
    .map((p) => {
      const inst = `${p.rgtrInstCdNm || ""} ${p.rgtrUpInstCdNm || ""} ${p.plcyPvsnInstNm || ""}`;
      const region = regionOfOrg(inst) || NATIONWIDE;
      return { ...normalizeYouth(p), region, support_type: supportTypeOf(p.plcySprtCn || ""), raw: clip(`${p.plcyNm} ${p.plcySprtCn}`, 300), _src: "온통청년" };
    });
}

/* ---------- E. 구청 공고게시판 (boards.mjs) ---------- */
// 결과공개·정산·현황 등 비신청성 글은 제외
const NOT_BENEFIT = /결과\s*공개|정산\s*(현황|결과)|심의\s*결과|선정\s*(결과|자)|발표|명단|현황$/;
async function srcBoards() {
  const cands = await harvestCandidates();
  const out = [];
  for (const c of cands) {
    if (NOT_BENEFIT.test(c.title)) continue;
    const [age_min, age_max] = parseAgeRange(c.title);
    out.push({
      id: "bd-" + Buffer.from(c.url || c.title).toString("hex").slice(0, 12),
      title: clip(c.title, 70), category: "구청공고", region: c.region,
      amount: parseAmount(c.title), amount_label: "공고 확인 필요",
      age_min, age_max, need: needFromText(c.title), support_type: supportTypeOf(c.title),
      apply_end: null, how: "구청 공고 확인", contact: c.region,
      source: c.url || c.board, raw: c.title, _src: "구청공고",
    });
  }
  return out;
}

/* ---------- F. 구청공고(헤드리스, 별도 워크플로가 커밋한 파일) ---------- */
function srcHeadless() {
  const f = join(__dir, "..", "data", "boards_headless.json");
  if (!existsSync(f)) return [];
  try {
    const j = JSON.parse(readFileSync(f, "utf-8"));
    return (j.benefits || []).map((b) => ({ ...b, raw: b.title, _src: "구청공고" }));
  } catch { return []; }
}

/* ---------- 머지 + 중복제거(같은 사업 합치기) ---------- */
// 정규화 제목: 연도·호수·괄호·공백·문장부호 제거 → 같은 사업 판별 키
function normTitle(t = "") {
  return `${t}`.toLowerCase()
    .replace(/20\d{2}\s*년?도?|제?\s*\d+\s*[차호회]|\[[^\]]*\]|\([^)]*\)/g, "")
    .replace(/[\s()\[\]{}·\-~,.\/]/g, "")
    .slice(0, 30);
}
const isDong = (r = "") => r.split(" ").length >= 3;                 // "인천 연수구 송도동"
const rollupGu = (r = "") => r.split(" ").slice(0, 2).join(" ");     // → "인천 연수구"
// 정보량 점수(많은 쪽을 대표로): 금액 > 라벨길이 > 요약 > 마감일 > 분야명확
function infoScore(b) {
  return (b.amount || 0) / 1e4 + (b.amount_label || "").length * 0.1
    + (b.summary ? 5 : 0) + (b.apply_end ? 3 : 0) + (b.category && b.category !== "구청공고" && b.category !== "기타" ? 2 : 0);
}
function mergeTwo(a, b) {
  const [hi, lo] = infoScore(a) >= infoScore(b) ? [a, b] : [b, a];
  const srcs = [...new Set(`${a._src || ""}+${b._src || ""}`.split("+").filter(Boolean))].join("+");
  return {
    ...hi,
    need: [...new Set([...(a.need || []), ...(b.need || [])])],
    summary: hi.summary || lo.summary || "",
    apply_end: hi.apply_end || lo.apply_end || null,
    amount: Math.max(a.amount || 0, b.amount || 0),
    _src: srcs,
    _also: [...new Set([...(a._also || []), ...(b._also || []), a.source, b.source].filter((u) => u && u !== hi.source))].slice(0, 4),
  };
}
export function dedupe(items) {
  // 0) 동단위 보드글 승격: 같은 구·같은 사업이 2개 이상 동에 올라오면 '구 단위 1건'으로 합침
  const guCnt = new Map();
  for (const it of items) if (isDong(it.region)) {
    const k = normTitle(it.title) + "|" + rollupGu(it.region);
    guCnt.set(k, (guCnt.get(k) || 0) + 1);
  }
  const lifted = items.map((it) => {
    if (!isDong(it.region)) return it;
    const k = normTitle(it.title) + "|" + rollupGu(it.region);
    return guCnt.get(k) > 1 ? { ...it, region: rollupGu(it.region) } : it; // 여러 동 중복 = 구 사업
  });
  // 1) 표준 병합: (정규제목 + 지역) 동일하면 한 건으로 합치고 출처를 모은다
  const seen = new Map();
  for (const it of lifted) {
    const k = normTitle(it.title) + "|" + (it.region || "");
    const prev = seen.get(k);
    seen.set(k, prev ? mergeTwo(prev, it) : it);
  }
  return [...seen.values()];
}

/* ---------- LLM 보강 (Gemini 우선 / Anthropic 폴백, 선택) ---------- */
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
export const hasLLMKey = () => !!(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY);
export const llmProvider = () => (process.env.GEMINI_API_KEY ? `Gemini(${GEMINI_MODEL})` : process.env.ANTHROPIC_API_KEY ? "Claude" : null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withTimeout(fn, ms = 60000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try { return await fn(ctrl.signal); } finally { clearTimeout(to); }
}
async function callGemini(key, system, user, json, maxTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: maxTokens,
      // 2.5 계열만 thinking 끄기(출력잘림 방지). 2.0/lite 등은 미지원이라 제외
      ...(GEMINI_MODEL.includes("2.5") ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      ...(json ? { responseMimeType: "application/json" } : {}),
    },
  };
  // 429(쿼터) 재시도: 8s, 16s, 32s 백오프
  for (let attempt = 0; ; attempt++) {
    const res = await withTimeout((signal) => fetch(url, { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body), signal }));
    if (res.ok) {
      const j = await res.json();
      return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    }
    const txt = await res.text();
    if (res.status === 429 && attempt < 3) { await sleep(8000 * 2 ** attempt); continue; }
    throw new Error(`Gemini HTTP ${res.status} :: ${clip(txt, 160)}`);
  }
}
async function callClaude(key, system, user, maxTokens) {
  return withTimeout(async (signal) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, temperature: 0, system, messages: [{ role: "user", content: user }] }),
      signal,
    });
    if (!res.ok) throw new Error(`Claude HTTP ${res.status} :: ${clip(await res.text(), 160)}`);
    return (await res.json()).content?.[0]?.text || "";
  });
}
// 공급자 무관 호출 (Gemini 우선)
async function callLLM(system, user, { json = false, maxTokens = 2000 } = {}) {
  const g = process.env.GEMINI_API_KEY, a = process.env.ANTHROPIC_API_KEY;
  if (g) return callGemini(g, system, user, json, maxTokens);
  if (a) return callClaude(a, system, user, maxTokens);
  throw new Error("LLM 키 없음");
}
function parseJsonLoose(s) {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = m ? m[1] : s;
  const a = body.indexOf("["), b = body.lastIndexOf("]");
  return JSON.parse(a >= 0 ? body.slice(a, b + 1) : body);
}
// ── LLM 분류 (새 공고만 + 캐시) ──
function loadCache() { try { return existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf-8")) : {}; } catch { return {}; } }
function applyClass(b, c) {
  if (c.category && CATS.includes(c.category)) b.category = c.category;
  if (Array.isArray(c.tags)) {
    const occKeep = (b.need || []).filter((t) => OCC_TAGS.includes(t)); // 구버전 캐시가 직업태그 못 지우게 보존
    b.need = [...new Set([...c.tags.filter((t) => CONTROLLED_TAGS.includes(t)), ...occKeep])];
  }
  if (SUPPORT_TYPES.includes(c.support_type)) b.support_type = c.support_type;
  if (c.summary) b.summary = clip(c.summary, 60);
  if (c.target) b.target_llm = clip(c.target, 60);     // 제미나이 정리 대상
  if (c.amount) b.amount_clean = clip(c.amount, 40);    // 제미나이 정리 금액(퍼센트 맥락 포함)
  b.show = c.show !== false;
  if (c.special) b.special = true;
  b.llm = true;
}
async function classifyWithLLM(items) {
  const cache = loadCache();
  for (const b of items) if (cache[b.id]) applyClass(b, cache[b.id]);   // 기존 캐시 적용(무료)
  let added = 0, dirty = false;
  if (hasLLMKey()) {
    // 신규 공고 + '대상(target) 정리가 아직 안 된' 기존 캐시 공고(한 번만 보강 후 다시 안 건드림)
    const need = items.filter((b) => {
      const c = cache[b.id];
      if (!c) return true;                                                // 신규
      return c.target === undefined && `${b.target || ""}`.length > 6;    // 대상 미정리 기존
    });
    // 화면에 보이고(대상 원문 있는) 공고부터 우선 보강 → 체감 품질 빨리 개선
    need.sort((a, b) => ((b.target ? 2 : 0) + (b.show !== false ? 1 : 0)) - ((a.target ? 2 : 0) + (a.show !== false ? 1 : 0)));
    const todo = need.slice(0, 120);                                      // 무료 쿼터 상한
    const sys = `너는 한국 복지·지원 공고 분류기다. 각 항목을 분석해 JSON 배열로만 답한다.
각 원소: {"id":입력id,"category":"...","tags":[...],"support_type":"...","summary":"...","target":"...","amount":"...","show":true/false,"special":true/false}
- category 는 다음 중 하나: ${CATS.join(", ")}
- tags 는 자격조건이 꼭 필요한 경우만(없으면 []): ${CONTROLLED_TAGS.join(", ")}
- support_type 은 다음 중 하나: ${SUPPORT_TYPES.join(", ")}
- summary: 35자 내외 한 줄, "[대상]에게 [무엇] [얼마]" 형식의 명사형(예: "무주택 청년 월세 최대 20만원"). 한눈에 읽히게, 추측 금지.
- target: 25자 내외, 이 혜택을 받을 수 있는 핵심 '대상'을 명확히(나이·자격·소득 위주). 글머리기호(○·-)·라벨·군더더기 빼고 평서형 명사구로. 원문에 없으면 "".
- amount: 20자 내외, 받는 '혜택의 핵심'. 퍼센트면 반드시 '무엇의 몇 %'인지 명시(예: "설치비의 60%"), 금액이면 "최대 ○○만원". 단독 "60%"처럼 맥락 없이 쓰지 말 것. 불명확하면 "".
- show: 일반 주민이 신청해 실익 있는 지원이면 true. 단순공지·결과발표·내부행정·입찰·채용공고면 false.
- special: 자동지급(별도 신청 불필요)이거나 극소수 특수대상(장애인·유공자 등)이면 true.`;
    const SZ = 20;
    for (let i = 0; i < todo.length; i += SZ) {
      const batch = todo.slice(i, i + SZ).map((b) => ({ id: b.id, title: b.title, desc: clip(b.raw || b.amount_label, 140), 대상원문: clip(b.target || "", 110) }));
      try {
        const arr = parseJsonLoose(await callLLM(sys, JSON.stringify(batch), { json: true, maxTokens: 4096 }));
        const byId = new Map(arr.map((x) => [x.id, x]));
        for (const b of todo.slice(i, i + SZ)) {
          const e = byId.get(b.id); if (!e) continue;
          const cls = { category: e.category, tags: e.tags, support_type: e.support_type, summary: clip(e.summary, 60), target: clip(e.target || "", 60), amount: clip(e.amount || "", 40), show: e.show !== false, special: e.special === true };
          cache[b.id] = cls; applyClass(b, cls); added++; dirty = true;
        }
        console.log(`  [LLM분류] ${Math.min(i + SZ, todo.length)}/${todo.length} 신규`);
      } catch (e) { console.log(`  [LLM분류] 배치 ${i} 실패: ${clip(e.message, 90)}`); }
      await sleep(5000);
    }
  }
  if (dirty) writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`  [LLM분류] 신규 ${added}건 · 캐시 총 ${Object.keys(cache).length}건`);
  return items;
}
async function makeOverview(items, region) {
  const top = items.filter((b) => b.region === region || b.region === SIDO || b.region === NATIONWIDE);
  const brief = top.slice(0, 40).map((b) => `${b.title}(${b.category})`).join(", ");
  const sys = "너는 복지정보 큐레이터다. 사용자가 첫 화면에서 읽을 2~3문장 한국어 요약을 쓴다. 과장/추측 없이 담백하게.";
  const user = `지역: ${region}. 복지·지원 혜택 목록(${top.length}건): ${brief}.\n이 지역 주민이 알아두면 좋은 핵심(주요 분야·대상)을 2~3문장으로 요약.`;
  try { return clip(await callLLM(sys, user, { maxTokens: 400 }), 400); }
  catch (e) { console.log(`  [LLM] 총평 실패: ${clip(e.message, 90)}`); return null; }
}

/* ---------- 메인 ---------- */
async function run() {
  const dkey = process.env.DATA_GO_KR_KEY ? decodeKey(process.env.DATA_GO_KR_KEY) : null;
  const ykey = process.env.YOUTH_API_KEY ? decodeKey(process.env.YOUTH_API_KEY) : null;
  const useLLM = hasLLMKey();
  if (!dkey && !ykey) { console.error("✗ DATA_GO_KR_KEY / YOUTH_API_KEY 둘 다 없음"); process.exit(1); }

  console.log("== 멀티소스·다지역 수집 시작 ==");
  const sources = [
    dkey && ["A.복지로(지자체)", () => srcBokjiroLocal(dkey)],
    dkey && ["B.복지로(중앙)", () => srcBokjiroCentral(dkey)],
    dkey && ["C.보조금24", () => srcGov24(dkey)],
    ykey && ["D.온통청년", () => srcYouthcenter(ykey)],
    ["E.구청공고", () => srcBoards()],
    ["F.구청공고(헤드리스파일)", () => srcHeadless()],
  ].filter(Boolean);

  const collected = [], counts = {};
  for (const [name, fn] of sources) {
    try { const items = await fn(); counts[name] = items.length; collected.push(...items); console.log(`  ✓ ${name}: ${items.length}건`); }
    catch (e) { counts[name] = `실패`; console.log(`  ✗ ${name}: ${clip(e.message, 100)}`); }
  }

  let merged = dedupe(collected);
  // [정책] 전국 커버리지: 모든 시·군·구 지역건은 전부 유지, 전국(중앙)건은 금액순 상위 400만.
  const regional = merged.filter((b) => b.region !== NATIONWIDE);
  let national = merged.filter((b) => b.region === NATIONWIDE);
  national.sort((a, b) => (b.amount || 0) - (a.amount || 0));
  national = national.slice(0, 400);
  merged = [...regional, ...national];
  console.log(`  [정책] 지역건 ${regional.length} 전부 + 전국 상위 ${national.length}`);
  // 지역건 먼저(시군구 단위 → 시도 단위) → 전국 → 금액 큰 순
  const rank = (b) => /\s/.test(b.region || "") ? 0 : b.region === NATIONWIDE ? 2 : 1;
  merged.sort((a, b) => rank(a) - rank(b) || (b.amount || 0) - (a.amount || 0));
  console.log(`\n합계 ${collected.length} → 중복제거 ${merged.length}건`);
  if (merged.length < 4) { console.log("⚠️ 수집량 부족 → 시드 유지"); process.exit(0); }

  console.log(`== LLM 분류(새 공고만+캐시)${useLLM ? " " + llmProvider() : " — 키없음, 캐시만 적용"} ==`);
  await classifyWithLLM(merged);
  let summary = null;
  if (useLLM) summary = await makeOverview(merged, "전국");
  const sidoCount = new Set(merged.map((b) => (b.region || "").split(" ")[0]).filter((s) => s && s !== NATIONWIDE)).size;
  if (!summary) {
    const top = [...new Set(merged.map((b) => b.category))].slice(0, 4).join("·");
    const maxAmt = Math.max(0, ...merged.map((b) => b.amount));
    summary = `전국 ${sidoCount}개 시·도의 복지·지원 혜택 ${merged.length}건을 모았어요. 주요 분야는 ${top}이며, 최대 ${(maxAmt/10000).toLocaleString()}만원까지 지원됩니다. 지역과 나이·상황(가구·소득·자격)을 고르면 내게 맞는 것만 골라드려요.`;
  }

  const regions = [...new Set(merged.map((b) => b.region))].sort();
  const out = {
    meta: {
      region: "전국", regions, sido_count: sidoCount,
      personas: ["전 연령·맞춤"],
      snapshot_date: new Date().toISOString().slice(0, 10),
      source: "복지로(지자체·중앙)+보조금24" + (ykey ? "+온통청년" : "") + (useLLM ? ` · AI보강(${llmProvider()})` : ""),
      counts, summary, llm: useLLM,
    },
    benefits: merged.map(({ _src, raw, ...b }) => ({ ...b, contact: b.contact ? `${b.contact} [${_src}]` : `[${_src}]` })),
  };
  writeFileSync(OUT, JSON.stringify(out), "utf-8");
  console.log(`✓ 저장: ${OUT} (지역 ${regions.length}종/${sidoCount}개 시도, ${merged.length}건${useLLM ? ", AI보강" : ""})`);
}

/* ---------- 셀프테스트 ---------- */
function selftest() {
  const xml = `<r><servList><servId><![CDATA[WLF001]]></servId><servNm>연수구 청년 월세 지원</servNm><servDgst>무주택 청년에게 월 최대 20만원 지원</servDgst><intrsThemaNmArray>주거,생활지원</intrsThemaNmArray><aplyMtdNm>방문신청</aplyMtdNm></servList></r>`;
  const items = xmlList(xml, "servList");
  const a = mapBokjiro("복지로(지자체)", items[0], "인천광역시 연수구");
  const g = mapGov24({ "서비스ID": "S1", "서비스명": "인천 청년 면접수당", "지원내용": "면접 1회 5만원, 최대 2회 10만원", "지원대상": "구직 청년", "소관기관명": "인천광역시 연수구", "서비스분야": "고용" }, "인천광역시 연수구");
  const checks = [
    ["XML/CDATA", items[0].servId === "WLF001"],
    ["복지로 region", a.region === "인천광역시 연수구"],
    ["복지로 amount 20만", a.amount === 200000],
    ["복지로 need 무주택", a.need.includes("무주택")],
    ["복지로 생애주기→나이(노년 65+)", (()=>{ const x=mapBokjiro("복지로(중앙)",{servNm:"고독사 예방",servDgst:"독거 어르신 지원",lifeNmArray:"노년",trgterIndvdlNmArray:"저소득"},"인천광역시 남동구"); return x.age_min===65 && x.age_max===120 && x.need.includes("저소득"); })()],
    ["복지로 생애주기 다중(청년·중장년→19-64)", (()=>{ const x=mapBokjiro("복지로(중앙)",{servNm:"x",servDgst:"y",lifeNmArray:"청년,중장년"},"전국"); return x.age_min===19 && x.age_max===64; })()],
    ["복지로 대상특성→태그(다문화)", (()=>{ const x=mapBokjiro("복지로(중앙)",{servNm:"x",servDgst:"y",trgterIndvdlNmArray:"다문화·탈북민"},"전국"); return x.need.includes("다문화"); })()],
    ["gov24 region", g.region === "인천광역시 연수구"],
    ["gov24 amount 10만", g.amount === 100000],
    ["마감 범위 '2026. 3. 3. ~ 3. 18.'", parseDeadline("2026. 3. 3. ~ 3. 18.") === "2026-03-18"],
    ["마감 단일 '2026-03-18'", parseDeadline("2026-03-18") === "2026-03-18"],
    ["마감 풀범위 '2026.3.3~2026.3.18'", parseDeadline("2026.3.3~2026.3.18") === "2026-03-18"],
    ["마감 상시=null", parseDeadline("상시 신청 (예산 소진 시까지)") === null],
    ["gov24 마감 반영", mapGov24({ "서비스명": "x", "지원내용": "y", "신청기한": "2026. 3. 3. ~ 3. 18.", "소관기관명": "인천광역시 연수구" }, "인천광역시 연수구").apply_end === "2026-03-18"],
    ["regionOfOrg 군구", regionOfOrg("인천광역시 연수구청") === "인천광역시 연수구"],
    ["regionOfOrg 시", regionOfOrg("인천광역시") === "인천광역시"],
    ["regionOfOrg 중앙", regionOfOrg("보건복지부") === "전국"],
    ["regionOfOrg 전국확장: 서울 강남구", regionOfOrg("서울특별시 강남구") === "서울특별시 강남구"],
    ["regionOfOrg 전국확장: 대구 재단", regionOfOrg("대구신용보증재단") === "대구광역시"],
    ["regionOfOrg 전국확장: 경기 시군구", regionOfOrg("경기도 광주시 환경과") === "경기도 광주시"],
    ["다차원 한부모+저소득", JSON.stringify(needFromText("저소득 한부모 가정").sort()) === JSON.stringify(["저소득","한부모"])],
    ["지원유형 대출", supportTypeOf("저금리 융자") === "대출"],
    ["지원유형 바우처", supportTypeOf("문화 이용권 포인트") === "바우처"],
    ["isYouth", isYouthText("만 25세 청년") && !isYouthText("어르신")],
    ["parseJsonLoose 코드펜스", JSON.stringify(parseJsonLoose('```json\n[{"id":1}]\n```')) === '[{"id":1}]'],
    ["dedupe 지역분리", dedupe([a, { ...a, region: "인천광역시 남동구" }]).length === 2],
    ["dedupe 같은사업 병합(연도차이)", dedupe([
      { id: "x1", title: "2025년 청년 면접수당", region: "인천광역시 연수구", amount: 0, amount_label: "", need: [], _src: "구청공고", source: "u1" },
      { id: "x2", title: "청년 면접수당", region: "인천광역시 연수구", amount: 100000, amount_label: "최대 10만원", need: ["구직중"], summary: "면접수당", _src: "보조금24", source: "u2" },
    ]).length === 1],
    ["dedupe 병합시 정보풍부쪽 채택+출처합산", (() => {
      const m = dedupe([
        { id: "y1", title: "효도수당", region: "인천광역시 연수구", amount: 0, amount_label: "", need: [], _src: "구청공고", source: "u1" },
        { id: "y2", title: "효도수당", region: "인천광역시 연수구", amount: 300000, amount_label: "분기 30만원", need: ["저소득"], _src: "복지로(지자체)", source: "u2" },
      ])[0];
      return m.amount === 300000 && m._src.includes("구청공고") && m._src.includes("복지로(지자체)");
    })()],
    ["dedupe 동단위 중복→구단위 승격", (() => {
      const r = dedupe([
        { id: "z1", title: "에너지바우처", region: "인천광역시 미추홀구 숭의동", amount: 0, amount_label: "", need: [], _src: "구청공고", source: "u1" },
        { id: "z2", title: "에너지바우처", region: "인천광역시 미추홀구 용현동", amount: 0, amount_label: "", need: [], _src: "구청공고", source: "u2" },
      ]);
      return r.length === 1 && r[0].region === "인천광역시 미추홀구";
    })()],
    ["dedupe 동단위 단독은 동 유지", dedupe([
      { id: "w1", title: "용현동 경로당 지원", region: "인천광역시 미추홀구 용현동", amount: 0, amount_label: "", need: [], _src: "구청공고", source: "u1" },
    ])[0].region === "인천광역시 미추홀구 용현동"],
    ["나이 범위(만19~34세)", JSON.stringify(parseAgeRange("만 19~34세 청년")) === "[19,34]"],
    ["나이 이상(65세이상)", JSON.stringify(parseAgeRange("65세 이상 어르신")) === "[65,120]"],
    ["나이 키워드(영유아)", JSON.stringify(parseAgeRange("영유아 보육료")) === "[0,5]"],
    ["나이 미상=전연령", JSON.stringify(parseAgeRange("저소득 가구 지원")) === "[0,120]"],
    ["복지로 나이반영(청년)", a.age_min === 19 && a.age_max === 39],
    ["직업: 농어업인", needFromText("귀농 농업인 영농정착 지원").includes("농어업인")],
    ["직업: 예술인", needFromText("예술인 창작지원금").includes("예술인")],
    ["직업: 운수종사자", needFromText("화물차주 유가보조금").includes("운수종사자")],
  ];
  let ok = 0;
  for (const [n, p] of checks) { console.log(`${p ? "✓" : "✗ FAIL"}  ${n}`); if (p) ok++; }
  console.log(`\n결과: ${ok}/${checks.length} 통과`);
  process.exit(ok === checks.length ? 0 : 1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) { if (process.argv.includes("--selftest")) selftest(); else run().catch((e) => { console.error("✗", e.message); process.exit(1); }); }
