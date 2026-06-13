#!/usr/bin/env node
/**
 * 소스 E — 구청 공고게시판 수집기 (공식 API에 없는 지자체 고유 보조금)
 * ------------------------------------------------------------------
 * 전국 확장 설계: REGISTRY 에 지자체 "홈페이지 URL"만 추가하면 늘어남.
 *   각 홈에서 공고 게시판을 자동 발견 → 글 목록에서 '지원/보조금' 후보 추출
 *   → (LLM 켜짐 시) 상세 본문을 Gemini로 구조화 → 표준 스키마.
 *
 * 모드:
 *   --discover   LLM 없이 후보 글(제목·링크)만 수집·출력 (비용 0, 가능성 검증)
 *   (기본)        후보 상세를 Gemini로 구조화해 data/boards_live.json 생성
 *
 * ⚠️ 현실: 226개 시군구 + 3,500여 읍면동은 게시판 구조가 제각각이고,
 *   전부 매일 크롤+LLM 구조화는 무료티어/시간/용량을 초과한다.
 *   → "프레임워크 + 점진 확장 + 캐시/증분" 이 정공법(=운영 해자).
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "..", "data", "boards_live.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

// 전국 확장 지점: { region, boards:[게시판 URL] } 추가하면 됨.
// 헤드리스 일괄 스캔(probe_api.mjs)으로 '지원공고 보유' 확인된 게시판을 구별 큐레이션.
// (남동·계양·미추홀구는 사이트 구조상 자동발견 실패 → 추후 개별 보정 필요)
const REGISTRY = [
  { region: "인천광역시 연수구", boards: [
    "https://www.yeonsu.go.kr/main/part/youth/notice.asp",     // 청년정책(청년월세 등) ★
    "https://www.yeonsu.go.kr/main/part/economy/store.asp",    // 소상공인 지원 ★
    "https://www.yeonsu.go.kr/main/part/food/food_notice.asp", // 식품
    "https://www.yeonsu.go.kr/main/part/property/public.asp",  // 공동주택
    "https://www.yeonsu.go.kr/main/part/clean/notice.asp",     // 환경(음식물처리기 등)
  ] },
  { region: "인천광역시 부평구", boards: [
    "https://www.icbp.go.kr/main/civil/property/youth.jsp",          // 청년
    "https://www.icbp.go.kr/main/participation/news/incheon.jsp",    // 새소식
  ] },
  { region: "인천광역시 서구", boards: [
    "https://www.seo.incheon.kr/open_content/main/community/news/notice.jsp",
    "https://www.seo.incheon.kr/open_content/main/community/news/company.jsp",
    "https://www.seo.incheon.kr/open_content/main/community/news/other.jsp",
  ] },
  { region: "인천광역시 강화군", boards: [
    "https://www.ganghwa.go.kr/open_content/main/part/job/aid.jsp",        // 일자리 지원
    "https://www.ganghwa.go.kr/open_content/main/ganghwa/news/notice.jsp",
    "https://www.ganghwa.go.kr/open_content/main/ganghwa/news/announce.jsp",
  ] },
  { region: "인천광역시 옹진군", boards: [
    "https://www.ongjin.go.kr/open_content/main/environment/economic/store.jsp", // 소상공인
    "https://www.ongjin.go.kr/open_content/main/community/board/notice.jsp",
    "https://www.ongjin.go.kr/open_content/main/community/board/announce.jsp",
  ] },
  { region: "인천광역시 동구", boards: [
    "https://www.icdonggu.go.kr/main/community/budget/notice.jsp",
  ] },
];

// discover_incheon.mjs가 자동 발견해 저장한 게시판(구·동 단위)을 REGISTRY에 병합
function loadDiscovered() {
  const f = join(__dir, "..", "data", "incheon_boards.json");
  if (!existsSync(f)) return [];
  try { return (JSON.parse(readFileSync(f, "utf-8")).registry || []); } catch { return []; }
}
function mergedRegistry() {
  const byRegion = new Map();
  for (const e of [...REGISTRY, ...loadDiscovered()]) {
    const cur = byRegion.get(e.region) || new Set();
    (e.boards || []).forEach((u) => cur.add(u));
    byRegion.set(e.region, cur);
  }
  return [...byRegion.entries()].map(([region, set]) => ({ region, boards: [...set] }));
}

// 지원사업 신호 키워드 (제목 1차 필터)
const KW = /지원|보조금|지원금|모집|신청|지급|바우처|선착순|수당|장려금|돌봄|구입비|설치비/;
// 게시판 후보 링크 신호
const BOARD_KW = /공지|고시|공고|새소식|알림|게시|소식|notice|board|bbs|gosi|news/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => (s ? `${s}`.replace(/\s+/g, " ").trim().slice(0, n) : "");
const abs = (href, base) => { try { return new URL(href, base).href; } catch { return null; } };

async function get(url, ms = 15000) {
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" }, signal: ctrl.signal, redirect: "follow" });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (e) { return { ok: false, status: 0, body: "", err: e.message }; }
  finally { clearTimeout(to); }
}

// HTML에서 <a> 추출 (href + onclick + text) — ASP 게시판은 onclick 기반이 많음
function anchors(html, base) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const href = (attrs.match(/href=["']([^"']+)["']/i) || [])[1] || "";
    const onclick = (attrs.match(/onclick=["']([^"']+)["']/i) || [])[1] || "";
    const text = clip(m[2].replace(/<[^>]+>/g, ""), 90);
    const absHref = href && !/^javascript:/i.test(href) ? abs(href, base) : null;
    if (text && (absHref || onclick)) out.push({ href: absHref, onclick, text });
  }
  return out;
}

// 본문 텍스트만 (태그 제거, 압축)
function textOf(html) {
  return clip(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "), 3000);
}

/* ---------- 1단계: 지자체별 후보 글 수집 (서버렌더 .asp 게시판 직접) ---------- */
async function harvestCandidates({ dump = false } = {}) {
  const candidates = [];
  for (const { region, boards } of mergedRegistry()) {
    for (const b of boards) {
      await sleep(1000);
      const r = await get(b);
      if (!r.ok) { console.log(`  ✗ ${region} ${b} → ${r.status || r.err}`); continue; }
      const all = anchors(r.body, b);
      if (dump) {
        console.log(`\n  [덤프] ${b} (${(r.body.length / 1024).toFixed(1)}KB, 앵커 ${all.length}개) 샘플:`);
        all.slice(0, 18).forEach((a) => console.log(`      "${clip(a.text, 40)}" href=${a.href ? a.href.slice(-45) : "-"} onclick=${clip(a.onclick, 45) || "-"}`));
      }
      // 글 링크로 보이는 것 + 지원 키워드
      const posts = all.filter((a) => KW.test(a.text) && (/(view|seq=|idx=|no=|num=|bidx|nttsn|articleno|\d{3,})/i.test(`${a.href}${a.onclick}`)));
      const seen = new Set();
      const uniq = posts.filter((a) => { const k = a.text.slice(0, 18); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 10);
      uniq.forEach((u) => candidates.push({ region, title: u.text, url: u.href, onclick: u.onclick, board: b }));
      console.log(`  · ${region} ${b.split("/").pop()}: 앵커 ${all.length} → 지원후보 ${uniq.length}`);
    }
  }
  return candidates;
}

/* ---------- 2단계: Gemini 구조화 (선택) ---------- */
async function callGemini(system, user, maxTokens = 1024) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error("no GEMINI_API_KEY");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = { system_instruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: "application/json", ...(GEMINI_MODEL.includes("2.5") ? { thinkingConfig: { thinkingBudget: 0 } } : {}) } };
  for (let a = 0; ; a++) {
    const res = await fetch(url, { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) { const j = await res.json(); return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""); }
    const t = await res.text();
    if (res.status === 429 && a < 3) { await sleep(8000 * 2 ** a); continue; }
    throw new Error(`Gemini ${res.status}: ${clip(t, 120)}`);
  }
}
function parseObj(s) { const a = s.indexOf("{"), b = s.lastIndexOf("}"); return JSON.parse(a >= 0 ? s.slice(a, b + 1) : s); }

async function structure(cand) {
  const sys = `너는 한국 지자체 공고를 구조화하는 엔진이다. 입력은 공고 제목과 본문 일부다.
이게 '주민이 신청해 돈/현물을 받는 지원사업'이면 JSON으로, 아니면 {"benefit":false} 로 답하라.
형식: {"benefit":true,"title":"사업명","amount_label":"금액(예: 최대 30만원)","target":"대상","apply_period":"신청기간","how":"신청방법","category":"분야"}
추측 금지, 본문 근거만. 금액 미상이면 amount_label:"".`;
  const r = await get(cand.url); if (!r.ok) return null;
  const txt = await callGemini(sys, `[제목] ${cand.title}\n[본문] ${textOf(r.body)}`);
  let o; try { o = parseObj(txt); } catch { return null; }
  if (!o.benefit) return null;
  const amount = (() => { const t = (o.amount_label || "").replace(/,/g, ""); const m = t.match(/(\d+)\s*억/) || t.match(/(\d{2,})\s*만/); return m ? (t.includes("억") ? +m[1] * 1e8 : +m[1] * 1e4) : 0; })();
  return {
    id: "board-" + Buffer.from(cand.url).toString("hex").slice(0, 12),
    title: clip(o.title || cand.title, 60), category: clip(o.category || "생활지원", 10),
    region: cand.region, amount, amount_label: clip(o.amount_label || "상세 참조", 80),
    age_min: 0, age_max: 120, need: [], support_type: /현물|처리기|기기|물품/.test(o.amount_label + o.title) ? "현물" : amount ? "현금" : "서비스",
    apply_end: null, how: clip(o.how || "구청 공고 확인", 50), contact: cand.region,
    summary: clip(`${o.target || ""} ${o.amount_label || ""}`.trim(), 60),
    source: cand.url, _src: "구청공고",
  };
}

/* ---------- 메인 ---------- */
async function main() {
  const discoverOnly = process.argv.includes("--discover");
  console.log(`== 소스E 구청공고 수집 (${discoverOnly ? "발견전용" : "구조화"}, ${REGISTRY.length}개 지자체) ==`);
  const cands = await harvestCandidates({ dump: discoverOnly });
  console.log(`\n총 후보 ${cands.length}건`);
  cands.slice(0, 25).forEach((c) => console.log(`   · [${c.region}] ${c.title}`));

  if (discoverOnly || !process.env.GEMINI_API_KEY) {
    console.log("\n(발견 모드 — 구조화 생략)");
    return;
  }
  console.log("\n== Gemini 구조화 시작 ==");
  const out = [];
  for (const c of cands.slice(0, 40)) {
    try { const s = await structure(c); if (s) { out.push(s); console.log(`  ✓ ${s.title} (${s.amount_label})`); } }
    catch (e) { console.log(`  ✗ ${clip(c.title, 24)}: ${clip(e.message, 70)}`); }
    await sleep(4000);
  }
  writeFileSync(OUT, JSON.stringify({ meta: { source: "구청공고", snapshot_date: new Date().toISOString().slice(0, 10), count: out.length }, benefits: out }, null, 2));
  console.log(`\n✓ 저장: ${OUT} (${out.length}건)`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.error("✗", e.message); process.exit(1); });

export { harvestCandidates, structure };
