#!/usr/bin/env node
/**
 * 인천 10개 구·군 게시판 자동 발견기 (구청 + 동 주민센터, 정적 fetch)
 * ------------------------------------------------------------------
 * 목적: 공공 API에 없는 '동네 고유 지원공고'를 직접 수집하기 위해, 각 구·군 홈에서
 *   ① 구 단위 공고/고시 게시판  ② 읍·면·동(주민센터/행정복지센터) 게시판
 *   을 자동으로 찾아 '지원사업 글이 실제로 있는' URL만 추려 data/incheon_boards.json 에 저장.
 *   harvest(boards.mjs)가 이 파일을 읽어 수집 대상에 자동 합류한다.
 *
 * 정적 fetch만 사용(헤드리스 X) → 느린 eGov 사이트에서도 타임아웃 없이 빠르게 훑는다.
 *   (JS로만 목록을 그리는 게시판은 posts=0 으로 잡혀 '헤드리스 필요'로 로그에 남는다)
 *
 * 실행: node scraper/discover_incheon.mjs           (전체)
 *       node scraper/discover_incheon.mjs --gu 연수구  (특정 구만)
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { proxyFetch, hasProxy } from "./net.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "..", "data", "incheon_boards.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const HOMES = [
  { gu: "중구", home: "https://www.icjg.go.kr/" },
  { gu: "동구", home: "https://www.icdonggu.go.kr/" },
  { gu: "미추홀구", home: "https://www.michuhol.go.kr/" },
  { gu: "연수구", home: "https://www.yeonsu.go.kr/" },
  { gu: "남동구", home: "https://www.namdong.go.kr/" },
  { gu: "부평구", home: "https://www.icbp.go.kr/" },
  { gu: "계양구", home: "https://www.gyeyang.go.kr/" },
  { gu: "서구", home: "https://www.seo.incheon.kr/" },
  { gu: "강화군", home: "https://www.ganghwa.go.kr/" },
  { gu: "옹진군", home: "https://www.ongjin.go.kr/" },
];

// 홈이 막혀도 '깊은 게시판 URL'은 열릴 때가 있어 직접 시드로 찔러본다(=연결성 테스트 겸용).
const SEEDS = {
  "중구": ["https://www.icjg.go.kr/open_content/main/intro/news/notice.jsp"],
  "동구": ["https://www.icdonggu.go.kr/main/community/budget/notice.jsp"],
  "미추홀구": ["https://www.michuhol.go.kr/open_content/main/intro/news/notice.jsp"],
  "남동구": ["https://www.namdong.go.kr/open_content/main/intro/news/notice.jsp"],
  "부평구": ["https://www.icbp.go.kr/main/civil/property/youth.jsp", "https://www.icbp.go.kr/main/participation/news/incheon.jsp"],
  "계양구": ["https://www.gyeyang.go.kr/open_content/main/intro/news/notice.jsp"],
  "서구": ["https://www.seo.incheon.kr/open_content/main/community/news/notice.jsp", "https://www.seo.incheon.kr/open_content/main/community/news/company.jsp", "https://www.seo.incheon.kr/open_content/main/community/news/other.jsp"],
  "강화군": ["https://www.ganghwa.go.kr/open_content/main/part/job/aid.jsp", "https://www.ganghwa.go.kr/open_content/main/ganghwa/news/notice.jsp"],
  "옹진군": ["https://www.ongjin.go.kr/open_content/main/environment/economic/store.jsp", "https://www.ongjin.go.kr/open_content/main/community/board/notice.jsp"],
};
// 실제 동이 아닌데 DONG_KW에 걸리는 메뉴어(오탐 차단)
const DONG_STOP = /우리동|이동|활동|행동|아동|노동|공동|자동|동행|동참|동의/;

// 지원사업 신호(글 제목)
const KW = /지원|보조금|지원금|모집|신청|지급|바우처|선착순|수당|장려금|구입비|설치비|교부|돌봄|감면/;
// 게시판으로 보이는 링크(텍스트/URL)
const BOARD_KW = /공지|고시|공고|새소식|알림|게시|소식|notice|board|bbs|gosi|news|announce/i;
// 읍·면·동/주민센터 링크
const DONG_KW = /(주민센터|행정복지센터|[가-힣]{1,3}[동읍면]\b)/;
// 게시글 링크 패턴(상세보기)
const POST_HREF = /(view|seq=|idx=|no=|num=|bidx|nttsn|articleno|artcl|mgr_seq|board_seq|\d{3,})/i;
// 전체 시간예산(프록시 지연 대비) — 초과 시 그때까지 결과로 저장(다음 실행에 누적 병합)
const T0 = Date.now();
const BUDGET_MS = Number(process.env.DISCOVER_BUDGET_MS || 300000);
const overBudget = () => Date.now() - T0 > BUDGET_MS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => (s ? `${s}`.replace(/\s+/g, " ").trim().slice(0, n) : "");
const abs = (href, base) => { try { return new URL(href, base).href; } catch { return null; } };

async function get(url, ms = 9000) {
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const px = await proxyFetch();
    const doFetch = px ? px.fetch : fetch;
    const res = await doFetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" }, signal: ctrl.signal, redirect: "follow", ...(px ? { dispatcher: px.agent } : {}) });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (e) { return { ok: false, status: 0, body: "", err: e.message }; }
  finally { clearTimeout(to); }
}
// 로테이팅 프록시는 연결마다 IP가 바뀌므로 실패 시 재시도하면 다른 한국 IP로 붙는다.
async function getR(url, ms, tries = 1) {
  let last = { ok: false };
  for (let i = 0; i < tries; i++) {
    last = await get(url, ms);
    if (last.ok) return last;
    if (overBudget()) break;
    if (i < tries - 1) await sleep(800);
  }
  return last;
}

function anchors(html, base) {
  const out = []; const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi; let m;
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

// 한 게시판 페이지가 '지원공고 보유'인지 판정
function scoreBoard(html, base) {
  const as = anchors(html, base);
  const posts = as.filter((a) => a.text.length > 6 && POST_HREF.test(`${a.href || ""}${a.onclick || ""}`));
  const supports = posts.filter((a) => KW.test(a.text));
  return { posts: posts.length, supports: supports.length, sample: supports.slice(0, 3).map((a) => clip(a.text, 40)) };
}

// 게시판 URL 정제: 동일 호스트 + 프래그먼트(#) 없음 + 루트(/)보다 깊은 경로만
function cleanBoardUrl(u, host) {
  try { const x = new URL(u); return (x.host === host && !x.hash && x.pathname.length > 1) ? x.href.split("#")[0] : null; }
  catch { return null; }
}

async function discoverSite({ gu, home }) {
  const region = `인천광역시 ${gu}`;
  console.log(`\n##### ${region} (${home}) #####`);
  const host = new URL(home).host;
  const r = await getR(home, 15000, 3);   // 실패 시 IP 바꿔 3회 재시도
  const homeOk = r.ok;
  if (!homeOk) console.log(`  ⚠ 홈 접속 실패(${r.status || r.err}) → 시드 게시판만 직접 점검(재시도)`);
  const links = homeOk ? anchors(r.body, home).filter((a) => cleanBoardUrl(a.href, host)) : [];

  // ── 구 단위 게시판 후보 = 홈에서 발견 + 시드(깊은 URL) ──
  const fromHome = links.filter((l) => BOARD_KW.test(l.text) || BOARD_KW.test(l.href)).map((l) => cleanBoardUrl(l.href, host));
  const candUrls = [...new Set([...(SEEDS[gu] || []), ...fromHome].filter(Boolean))].slice(0, 12);
  const guSet = new Set();
  const guBoards = [];
  for (const url of candUrls) {
    if (overBudget()) break;
    await sleep(250);
    const p = await getR(url, 9000, homeOk ? 1 : 3);   // 홈 실패 구의 시드는 IP 바꿔 재시도
    if (!p.ok) continue;
    const s = scoreBoard(p.body, url);
    if (s.supports > 0) { guBoards.push({ url, ...s }); guSet.add(url); console.log(`  ✓[구 지원 ${s.supports}/${s.posts}] ${url}`); s.sample.forEach((x) => console.log(`       · ${x}`)); }
  }

  // ── 읍·면·동(주민센터) 후보 → 그 페이지의 게시판 (홈 접속됐을 때만) ──
  const dongBoards = [];
  if (homeOk) {
    const dongLinks = [...new Map(links
      .filter((l) => DONG_KW.test(l.text) && !DONG_STOP.test(l.text) && /[가-힣]{2,3}[동읍면]/.test(l.text))
      .map((l) => [cleanBoardUrl(l.href, host), l])).values()]
      .filter((l) => l && !guSet.has(cleanBoardUrl(l.href, host))).slice(0, 6);
    for (const d of dongLinks) {
      if (overBudget()) break;
      const durl = cleanBoardUrl(d.href, host); if (!durl || guSet.has(durl)) continue;
      await sleep(250);
      const dp = await get(durl); if (!dp.ok) continue;
      const dongName = (d.text.match(/[가-힣]{2,3}[동읍면]/) || [])[0];
      let s = scoreBoard(dp.body, durl);
      if (s.supports > 0) { dongBoards.push({ region: `${region} ${dongName}`, url: durl, ...s }); console.log(`  ✓[동 ${dongName} 지원 ${s.supports}] ${durl}`); continue; }
      const subs = anchors(dp.body, durl).filter((a) => { const cu = cleanBoardUrl(a.href, host); return cu && !guSet.has(cu) && (BOARD_KW.test(a.text) || BOARD_KW.test(a.href)); });
      for (const sub of [...new Map(subs.map((l) => [cleanBoardUrl(l.href, host), l])).values()].slice(0, 1)) {
        const surl = cleanBoardUrl(sub.href, host); if (!surl) continue;
        await sleep(300);
        const sp = await get(surl); if (!sp.ok) continue;
        s = scoreBoard(sp.body, surl);
        if (s.supports > 0) { dongBoards.push({ region: `${region} ${dongName}`, url: surl, ...s }); console.log(`  ✓✓[동 ${dongName} 지원 ${s.supports}] ${surl}`); break; }
      }
    }
  }

  console.log(`  → 구 게시판 ${guBoards.length}개 · 동 게시판 ${dongBoards.length}개`);
  return { gu, region, homeOk, boards: guBoards, dong: dongBoards };
}

async function main() {
  const only = process.argv.includes("--gu") ? process.argv[process.argv.indexOf("--gu") + 1] : null;
  const targets = only ? HOMES.filter((h) => h.gu === only) : HOMES;
  console.log(`== 인천 게시판 발견 (${targets.length}개 구·군, 정적 fetch${hasProxy() ? ", 프록시 ON" : ""}) ==`);
  await proxyFetch();
  // 프록시 자가진단: 실제 나가는 IP/국가 확인(KR이어야 지자체 차단 통과)
  if (hasProxy()) {
    try {
      const r = await get("http://ip-api.com/json/?fields=query,country,countryCode", 9000);
      if (r.ok) console.log(`  [proxy] 출구 IP: ${clip(r.body, 120)}`);
      else console.log(`  [proxy] 출구 확인 실패: ${r.status || r.err}`);
    } catch (e) { console.log(`  [proxy] 출구 확인 오류: ${clip(e.message, 60)}`); }
  }
  const sites = [];
  for (const t of targets) {
    if (overBudget()) { console.log(`  ⏱ 시간예산(${Math.round(BUDGET_MS/1000)}s) 초과 → ${t.gu} 이후 중단(다음 실행에 누적)`); break; }
    try { sites.push(await discoverSite(t)); } catch (e) { console.log(`  ✗ ${t.gu}: ${clip(e.message, 60)}`); }
  }

  // boards.mjs(REGISTRY) 호환 형태로 변환: 구 게시판 + 동 게시판(있으면 동 region)
  const registry = [];
  for (const s of sites) {
    if (s.boards?.length) registry.push({ region: s.region, boards: s.boards.map((b) => b.url) });
    for (const d of (s.dong || [])) registry.push({ region: d.region, boards: [d.url] });
  }
  // 기존 발견결과와 병합(이번에 실패/0건인 구는 이전 값 유지)
  let prev = { registry: [] };
  if (existsSync(OUT)) { try { prev = JSON.parse(readFileSync(OUT, "utf-8")); } catch {} }
  const okUrl = (u) => { try { const x = new URL(u); return !x.hash && x.pathname.length > 1; } catch { return false; } };
  const byRegion = new Map();
  for (const e of [...(prev.registry || []), ...registry]) {
    const cur = byRegion.get(e.region) || new Set();
    (e.boards || []).filter(okUrl).forEach((u) => cur.add(u.split("#")[0]));
    byRegion.set(e.region, cur);
  }
  const merged = [...byRegion.entries()].map(([region, set]) => ({ region, boards: [...set] }))
    .filter((e) => e.boards.length)
    .filter((e) => { const p = e.region.split(" "); return p.length < 3 || (!DONG_STOP.test(p[2]) && /[가-힣]{2,3}[동읍면]$/.test(p[2])); }); // 가짜 동(우리동 등) 제거

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    snapshot_date: new Date().toISOString().slice(0, 10),
    note: "discover_incheon.mjs 자동 발견 결과. boards.mjs가 REGISTRY에 병합.",
    registry: merged,
    detail: sites,
  }, null, 2));
  const guN = merged.filter((e) => e.region.split(" ").length === 2).length;
  const dongN = merged.filter((e) => e.region.split(" ").length >= 3).length;
  console.log(`\n✓ 저장: ${OUT}\n  지역 ${merged.length}곳(구단위 ${guN} · 동단위 ${dongN}), 게시판 ${merged.reduce((n, e) => n + e.boards.length, 0)}개`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.error("✗", e.message); process.exit(1); });

export { discoverSite, HOMES };
