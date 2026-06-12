#!/usr/bin/env node
/**
 * 멀티소스 + 다지역 + LLM 보강 복지혜택 수집기
 * ------------------------------------------------------------------
 * 소스: 복지로(지자체/중앙) + 보조금24 + 온통청년  (모두 공식 OpenAPI)
 * 지역: 인천 10개 군·구 (지자체) + 전국(중앙/보조금24)
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

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "..", "data", "yeonsu_youth_live.json");

const SIDO = "인천광역시";
const SIGUNGU = ["중구", "동구", "미추홀구", "연수구", "남동구", "부평구", "계양구", "서구", "강화군", "옹진구"];
const AGE = { min: 18, max: 39 };
const NATIONWIDE = "전국";

const CONTROLLED_TAGS = ["구직중","재직중","학생","자영업·창업","1인가구","신혼","임신·출산","육아","한부모","장애인","저소득","무주택"];
const SUPPORT_TYPES = ["현금","바우처","대출","현물","서비스"];

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
  if (/노인|어르신|고령/.test(text)) return [65, 120];
  return [0, 120]; // 전연령
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

/* ---------- A. 복지로 지자체 (인천 군·구 순회) ---------- */
async function srcBokjiroLocal(key) {
  const base = "https://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations/LcgvWelfarelist";
  const out = [];
  let sampled = false;
  for (const sgg of SIGUNGU) {
    try {
      const u = `${base}?serviceKey=${encodeURIComponent(key)}&pageNo=1&numOfRows=100`
        + `&ctpvNm=${encodeURIComponent(SIDO)}&sggNm=${encodeURIComponent(sgg)}`;
      const xml = await getText(u);
      if (!sampled) { console.log("  [A:원시샘플]", clip(xml, 400)); sampled = true; }
      const items = xmlList(xml, "servList");
      out.push(...items.map((p) => mapBokjiro("복지로(지자체)", p, `${SIDO} ${sgg}`)));
      console.log(`    · ${sgg}: ${items.length}건`);
    } catch (e) { console.log(`    · ${sgg}: ${clip(e.message, 60)}`); }
  }
  return out;
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

export function mapBokjiro(srcName, p, region) {
  const blob = `${p.servNm || ""} ${p.servDgst || ""} ${p.aplyMtdNm || ""}`;
  const [age_min, age_max] = parseAgeRange(blob);
  return {
    id: `bj-${p.servId || Math.random().toString(36).slice(2, 8)}`,
    title: clip(p.servNm, 60) || "이름 없음",
    category: clip((p.intrsThemaNmArray || p.intrsThemaArray || "복지").split(",")[0], 10),
    region: region || NATIONWIDE,
    amount: parseAmount(p.servDgst || ""),
    amount_label: clip(p.servDgst, 80) || "상세 참조",
    age_min, age_max,
    need: needFromText(blob),
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
// 소관기관명 → 지역 (인천 군구/시 또는 전국). 타 시도면 제외(null)
function regionOfOrg(org = "") {
  for (const sgg of SIGUNGU) if (org.includes(sgg)) return `${SIDO} ${sgg}`;
  if (org.includes("인천")) return SIDO;
  if (/부|처|청|위원회|공단|진흥원|재단|교육부|고용노동부|보건복지부|여성가족부|국토교통부/.test(org)) return NATIONWIDE;
  return null; // 타 지자체
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
    need: needFromText(`${it["서비스명"]} ${it["지원대상"]} ${it["선정기준"] || ""} ${sprt}`),
    support_type: supportTypeOf(sprt, it["지원유형"] || ""),
    apply_end: null,
    how: clip(it["신청방법"], 50) || "정부24 확인",
    contact: clip(`${it["소관기관명"] || ""} ${it["부서명"] || ""}`, 30),
    source: it["상세조회URL"] || `https://www.gov.kr/portal/rcvfvrSvc/dtlEx/${it["서비스ID"] || ""}`,
    raw: clip(`${it["서비스명"]} ${it["지원대상"]} ${sprt}`, 300),
    _src: "보조금24",
  };
}

/* ---------- D. 온통청년 (인천 시단위) ---------- */
async function srcYouthcenter(key) {
  let all = [], page = 1, total = Infinity;
  while ((page - 1) * 100 < total && page <= 30) {
    const { list, total: t } = await fetchYouthPage(key, page);
    total = t; all.push(...list);
    if (!list.length) break;
    page++;
  }
  return all.filter((p) => matchRegion(p) && matchAge(p))
    .map((p) => ({ ...normalizeYouth(p), region: SIDO, support_type: supportTypeOf(p.plcySprtCn || ""), raw: clip(`${p.plcyNm} ${p.plcySprtCn}`, 300), _src: "온통청년" }));
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

/* ---------- 머지 + 중복제거 ---------- */
export function dedupe(items) {
  const seen = new Map();
  for (const it of items) {
    const k = (it.title || "").toLowerCase().replace(/[\s()\[\]·\-~]/g, "").slice(0, 24) + "|" + (it.region || "");
    const prev = seen.get(k);
    if (!prev || it.amount > prev.amount || (it.amount === prev.amount && it.amount_label.length > prev.amount_label.length)) {
      seen.set(k, prev ? { ...it, _src: `${prev._src}+${it._src}` } : it);
    }
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
async function enrichWithLLM(items) {
  const cap = items.slice(0, 96);
  const sys = `너는 한국 복지·정책 분류 엔진이다. 입력 항목들을 분석해 JSON 배열로만 답한다.
각 원소: {"id": 입력id, "tags": [...], "support_type": "...", "summary": "..."}
- tags 는 다음에서만 고른다(해당 자격이 필요한 경우만, 없으면 []): ${CONTROLLED_TAGS.join(", ")}
- support_type 은 다음 중 하나: ${SUPPORT_TYPES.join(", ")}
- summary 는 45자 이내 한 줄, 핵심 자격과 금액 위주. 추측 금지, 입력 근거만.`;
  const SZ = 24; // 호출 수 최소화(96→4콜)로 무료 분당한도 회피
  for (let i = 0; i < cap.length; i += SZ) {
    const batch = cap.slice(i, i + SZ).map((b) => ({ id: b.id, title: b.title, desc: b.raw || b.amount_label }));
    try {
      const txt = await callLLM(sys, JSON.stringify(batch), { json: true, maxTokens: 4096 });
      const arr = parseJsonLoose(txt);
      const byId = new Map(arr.map((x) => [x.id, x]));
      for (const b of cap.slice(i, i + SZ)) {
        const e = byId.get(b.id);
        if (!e) continue;
        if (Array.isArray(e.tags)) b.need = e.tags.filter((t) => CONTROLLED_TAGS.includes(t));
        if (SUPPORT_TYPES.includes(e.support_type)) b.support_type = e.support_type;
        if (e.summary) b.summary = clip(e.summary, 60);
        b.llm = true;
      }
      console.log(`  [LLM] ${i + batch.length}/${cap.length} 보강`);
    } catch (e) { console.log(`  [LLM] 배치 ${i} 실패(규칙기반 유지): ${clip(e.message, 90)}`); }
    await sleep(5000); // 무료 분당한도 회피용 간격
  }
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
  // [정책 C] 우리동네 우선: 인천(시·군구) 지역건은 전부 유지, 전국건은 금액순 상위 150만
  const regional = merged.filter((b) => b.region !== NATIONWIDE);
  let national = merged.filter((b) => b.region === NATIONWIDE);
  national.sort((a, b) => (b.amount || 0) - (a.amount || 0));
  national = national.slice(0, 150);
  merged = [...regional, ...national];
  console.log(`  [정책C] 지역건 ${regional.length} 전부 + 전국 상위 ${national.length}`);
  // 지역 우선(연수→인천→전국) + 금액 큰 순 정렬
  const rank = (b) => b.region === `${SIDO} 연수구` ? 0 : (b.region || "").startsWith(SIDO) ? 1 : b.region === NATIONWIDE ? 2 : 3;
  merged.sort((a, b) => rank(a) - rank(b) || (b.amount || 0) - (a.amount || 0));
  console.log(`\n합계 ${collected.length} → 중복제거 ${merged.length}건`);
  if (merged.length < 4) { console.log("⚠️ 수집량 부족 → 시드 유지"); process.exit(0); }

  let summary = null;
  if (useLLM) {
    console.log(`== LLM 보강 시작 (${llmProvider()}) ==`); await enrichWithLLM(merged);
    summary = await makeOverview(merged, `${SIDO} 연수구`);
  } else console.log("ℹ️ LLM 키(GEMINI_API_KEY/ANTHROPIC_API_KEY) 없음 → 규칙기반 유지");
  if (!summary) {
    const top = [...new Set(merged.map((b) => b.category))].slice(0, 4).join("·");
    const maxAmt = Math.max(0, ...merged.map((b) => b.amount));
    summary = `${SIDO}에서 받을 수 있는 복지·지원 혜택 ${merged.length}건을 모았어요. 주요 분야는 ${top}이며, 최대 ${(maxAmt/10000).toLocaleString()}만원까지 지원됩니다. 나이와 상황(가구·소득·자격)을 입력하면 내게 맞는 것만 골라드려요.`;
  }

  const regions = [...new Set(merged.map((b) => b.region))].sort();
  const out = {
    meta: {
      region: `${SIDO} 연수구`, regions,
      personas: ["전 연령·맞춤"],
      snapshot_date: new Date().toISOString().slice(0, 10),
      source: "복지로(지자체·중앙)+보조금24" + (ykey ? "+온통청년" : "") + (useLLM ? ` · AI보강(${llmProvider()})` : ""),
      counts, summary, llm: useLLM,
    },
    benefits: merged.map(({ _src, raw, ...b }) => ({ ...b, contact: b.contact ? `${b.contact} [${_src}]` : `[${_src}]` })),
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2), "utf-8");
  console.log(`✓ 저장: ${OUT} (지역 ${regions.length}종, ${merged.length}건${useLLM ? ", AI보강" : ""})`);
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
    ["gov24 region", g.region === "인천광역시 연수구"],
    ["gov24 amount 10만", g.amount === 100000],
    ["regionOfOrg 군구", regionOfOrg("인천광역시 연수구청") === "인천광역시 연수구"],
    ["regionOfOrg 시", regionOfOrg("인천광역시") === "인천광역시"],
    ["regionOfOrg 중앙", regionOfOrg("보건복지부") === "전국"],
    ["regionOfOrg 타지역 제외", regionOfOrg("서울특별시 강남구") === null],
    ["다차원 한부모+저소득", JSON.stringify(needFromText("저소득 한부모 가정").sort()) === JSON.stringify(["저소득","한부모"])],
    ["지원유형 대출", supportTypeOf("저금리 융자") === "대출"],
    ["지원유형 바우처", supportTypeOf("문화 이용권 포인트") === "바우처"],
    ["isYouth", isYouthText("만 25세 청년") && !isYouthText("어르신")],
    ["parseJsonLoose 코드펜스", JSON.stringify(parseJsonLoose('```json\n[{"id":1}]\n```')) === '[{"id":1}]'],
    ["dedupe 지역분리", dedupe([a, { ...a, region: "인천광역시 남동구" }]).length === 2],
    ["나이 범위(만19~34세)", JSON.stringify(parseAgeRange("만 19~34세 청년")) === "[19,34]"],
    ["나이 이상(65세이상)", JSON.stringify(parseAgeRange("65세 이상 어르신")) === "[65,120]"],
    ["나이 키워드(영유아)", JSON.stringify(parseAgeRange("영유아 보육료")) === "[0,5]"],
    ["나이 미상=전연령", JSON.stringify(parseAgeRange("저소득 가구 지원")) === "[0,120]"],
    ["복지로 나이반영(청년)", a.age_min === 19 && a.age_max === 39],
  ];
  let ok = 0;
  for (const [n, p] of checks) { console.log(`${p ? "✓" : "✗ FAIL"}  ${n}`); if (p) ok++; }
  console.log(`\n결과: ${ok}/${checks.length} 통과`);
  process.exit(ok === checks.length ? 0 : 1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) { if (process.argv.includes("--selftest")) selftest(); else run().catch((e) => { console.error("✗", e.message); process.exit(1); }); }
