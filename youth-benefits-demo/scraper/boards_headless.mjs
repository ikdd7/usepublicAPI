#!/usr/bin/env node
/**
 * 소스 F — JS 렌더 게시판 헤드리스 수집 (.jsp/eGov SPA)
 * ------------------------------------------------------------------
 * 정적 fetch로 글이 안 나오는(JS 렌더) 지자체 게시판을 Playwright로 렌더 후 수집.
 *  ① 고정 목록(인천 일부, URL 확정) ② 발견결과(incheon_boards.json)에서
 *     '홈은 열렸으나 게시판 0건'인 서울·경기 JS 지역 → 홈 크롤로 게시판 찾아 렌더.
 * 대역폭(프록시 1GB) 보호: 이미지/CSS 차단 + 회당 지역 수 상한 + 캐시로 회전(주2회).
 * 결과를 data/boards_headless.json 으로 커밋 → 메인 수집(F)이 합류.
 */
import { chromium } from "playwright";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { playwrightProxy } from "./net.mjs";
import { HOMES } from "./discover_incheon.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "..", "data", "boards_headless.json");
const HCACHE = join(__dir, "..", "data", "headless_cache.json");
const DISC = join(__dir, "..", "data", "incheon_boards.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_JS_REGIONS = Number(process.env.HEADLESS_REGIONS || 6);   // 회당 JS 지역 상한(대역폭)
const REDO_DAYS = Number(process.env.HEADLESS_REDO_DAYS || 14);     // 같은 지역 재방문 주기

// 알려진 URL 고정(인천) — 매번 갱신
const FIXED = [
  { region: "인천광역시 부평구", boards: ["https://www.icbp.go.kr/main/civil/property/youth.jsp", "https://www.icbp.go.kr/main/participation/news/incheon.jsp"] },
  { region: "인천광역시 서구", boards: ["https://www.seo.incheon.kr/open_content/main/community/news/notice.jsp", "https://www.seo.incheon.kr/open_content/main/community/news/company.jsp"] },
  { region: "인천광역시 강화군", boards: ["https://www.ganghwa.go.kr/open_content/main/part/job/aid.jsp", "https://www.ganghwa.go.kr/open_content/main/ganghwa/news/notice.jsp"] },
  { region: "인천광역시 옹진군", boards: ["https://www.ongjin.go.kr/open_content/main/environment/economic/store.jsp", "https://www.ongjin.go.kr/open_content/main/community/board/notice.jsp"] },
];

const KW = /지원|보조금|지원금|모집|신청|지급|바우처|선착순|수당|장려금|구입비|설치비|교부|돌봄|감면/;
const NOT_BENEFIT = /결과\s*공개|정산\s*(현황|결과)|심의\s*결과|선정\s*(결과|자)|발표|명단|현황$/;
const BOARD_RE = /공지|고시|공고|새소식|알림|소식|notice|board|bbs|gosi|news|announce/i;
const POST_RE = /(view|seq=|idx=|no=|num=|nttSn|articleNo|bIdx|bbsIdx|artcl|mgr_seq|\d{3,})/i;
const clip = (s, n) => (s ? `${s}`.replace(/\s+/g, " ").trim().slice(0, n) : "");
const won = (t = "") => { t = t.replace(/,/g, ""); const m = t.match(/(\d+)\s*억/) || t.match(/(\d{2,})\s*만/); return m ? (t.includes("억") ? +m[1] * 1e8 : +m[1] * 1e4) : 0; };
function need(t = "") { const s = new Set(); if (/청년|미취업|구직/.test(t)) s.add("구직중"); if (/소상공인|자영업|창업/.test(t)) s.add("자영업·창업"); if (/무주택|월세|임차|전세/.test(t)) s.add("무주택"); if (/출산|임신|육아|보육|영유아/.test(t)) s.add("육아"); if (/장애/.test(t)) s.add("장애인"); if (/저소득|기초생활|차상위/.test(t)) s.add("저소득"); return [...s]; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 발견결과에서 'JS 게시판으로 추정되는' 지역(+홈) 추리기 — 캐시로 회전
function jsTargets() {
  if (!existsSync(DISC)) return { due: [], cache: {} };
  let detail = []; try { detail = JSON.parse(readFileSync(DISC, "utf-8")).detail || []; } catch {}
  const homeOf = Object.fromEntries(HOMES.map((h) => [h.region, h.home]));
  let cache = {}; if (existsSync(HCACHE)) { try { cache = JSON.parse(readFileSync(HCACHE, "utf-8")); } catch {} }
  const now = Date.now();
  const due = detail
    .filter((s) => s.homeOk && (!s.boards || !s.boards.length) && homeOf[s.region])
    .filter((s) => { const t = cache[s.region]; return !t || (now - new Date(t).getTime()) / 864e5 > REDO_DAYS; })
    .slice(0, MAX_JS_REGIONS)
    .map((s) => ({ region: s.region, home: homeOf[s.region] }));
  return { due, cache };
}

const out = [];
const _pxy = playwrightProxy();
if (_pxy) console.log(`  [proxy] 헤드리스 프록시 활성: ${_pxy.server}`);
const browser = await chromium.launch({ args: ["--no-sandbox"], ...(_pxy ? { proxy: _pxy } : {}) });
async function leanPage(ctx) {
  const page = await ctx.newPage();
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "media" || t === "font" || t === "stylesheet") route.abort();
    else route.continue();
  });
  return page;
}
async function renderBoard(page, url, region) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1000);
  const posts = await page.$$eval("a", (as) => as.map((a) => ({ t: (a.textContent || "").trim(), h: a.href || "", oc: a.getAttribute("onclick") || "" })));
  const picked = posts.filter((p) => p.t.length > 6 && POST_RE.test(p.h + p.oc));
  let n = 0; const seen = new Set();
  for (const p of picked) {
    if (!KW.test(p.t) || NOT_BENEFIT.test(p.t)) continue;
    const k = p.t.slice(0, 18); if (seen.has(k)) continue; seen.add(k);
    out.push({
      id: "bh-" + Buffer.from((p.h || p.t) + region).toString("hex").slice(0, 12),
      title: clip(p.t, 70), category: "구청공고", region,
      amount: won(p.t), amount_label: "공고 확인 필요", age_min: 0, age_max: 120,
      need: need(p.t), support_type: won(p.t) ? "현금" : "서비스", apply_end: null,
      how: "구청 공고 확인", contact: region + " [구청공고]",
      source: p.h && /^https?:/.test(p.h) ? p.h : url,
    });
    if (++n >= 10) break;
  }
  return n;
}

const processed = new Set();
// 1) 고정 인천 보드
for (const { region, boards } of FIXED) {
  processed.add(region);
  for (const url of boards) {
    const ctx = await browser.newContext({ userAgent: UA, locale: "ko-KR" });
    const page = await leanPage(ctx);
    try { const n = await renderBoard(page, url, region); console.log(`  · ${region} ${url.split("/").pop()}: ${n}`); }
    catch (e) { console.log(`  ✗ ${region} ${url}: ${clip(e.message, 50)}`); }
    await ctx.close(); await sleep(700);
  }
}
// 2) JS 지역(서울·경기): 홈 크롤 → 게시판 렌더
const { due, cache } = jsTargets();
console.log(`\n== JS 지역 ${due.length}곳 처리(회당 상한 ${MAX_JS_REGIONS}) ==`);
for (const { region, home } of due) {
  processed.add(region);
  const ctx = await browser.newContext({ userAgent: UA, locale: "ko-KR" });
  const page = await leanPage(ctx);
  try {
    await page.goto(home, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(800);
    const host = new URL(home).host;
    const links = await page.$$eval("a", (as, h) => as
      .filter((a) => { try { return new URL(a.href).host === h; } catch { return false; } })
      .map((a) => ({ t: (a.textContent || "").trim(), u: a.href.split("#")[0] })), host);
    const cands = [...new Map(links.filter((l) => l.t && BOARD_RE.test(l.t + l.u)).map((l) => [l.u, l])).values()].slice(0, 4);
    let tot = 0;
    for (const c of cands) { try { tot += await renderBoard(page, c.u, region); } catch {} await sleep(500); }
    console.log(`  ▶ [JS] ${region}: 게시판후보 ${cands.length} → 지원후보 ${tot}`);
  } catch (e) { console.log(`  ✗ [JS] ${region} ${home}: ${clip(e.message, 50)}`); }
  cache[region] = new Date().toISOString();
  await ctx.close(); await sleep(700);
}
try { writeFileSync(HCACHE, JSON.stringify(cache, null, 2)); } catch {}

// 3) 이번에 처리 안 한 지역은 이전 결과 유지(병합 누적)
let prev = []; if (existsSync(OUT)) { try { prev = (JSON.parse(readFileSync(OUT, "utf-8")).benefits) || []; } catch {} }
const keep = prev.filter((b) => !processed.has(b.region));
const merged = [...keep, ...out];
writeFileSync(OUT, JSON.stringify({ meta: { source: "구청공고(헤드리스)", snapshot_date: new Date().toISOString().slice(0, 10), count: merged.length }, benefits: merged }, null, 2));
console.log(`\n✓ 이번 ${out.length}건 + 유지 ${keep.length}건 = 총 ${merged.length}건 → ${OUT}`);
await browser.close();
