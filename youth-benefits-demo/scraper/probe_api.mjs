#!/usr/bin/env node
/**
 * 인천 10개 군·구 게시판 일괄 발견 (헤드리스, 범용)
 * ------------------------------------------------------------------
 * 각 구청 홈을 띄워 전체메뉴를 펼치고, 게시판으로 보이는 내부 링크를
 * 방문해 '지원공고 보유' 여부를 판정 → 구별 등록용 URL 목록을 출력.
 * 사이트 구조(.asp/.do/bbs 등)가 달라도 동작하도록 휴리스틱 일반화.
 */
import { chromium } from "playwright";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const KW = /지원|보조금|지원금|모집|신청|지급|바우처|선착순|수당|장려금|구입비|설치비|교부/;
const BOARDISH = /(공고|공지|지원|모집|알림|소식|사업|게시|복지|보조)/;
const HREF_BOARD = /(bbs|board|notice|gosi|\.asp|\.do|selectBoardList|artcl|nttList|list\.do|cop\/bbs)/i;
const clip = (s, n) => (s ? `${s}`.replace(/\s+/g, " ").trim().slice(0, n) : "");

const SITES = [
  { region: "인천광역시 중구", home: "https://www.icjg.go.kr/" },
  { region: "인천광역시 동구", home: "https://www.icdonggu.go.kr/" },
  { region: "인천광역시 미추홀구", home: "https://www.michuhol.go.kr/" },
  { region: "인천광역시 연수구", home: "https://www.yeonsu.go.kr/" },
  { region: "인천광역시 남동구", home: "https://www.namdong.go.kr/" },
  { region: "인천광역시 부평구", home: "https://www.icbp.go.kr/" },
  { region: "인천광역시 계양구", home: "https://www.gyeyang.go.kr/" },
  { region: "인천광역시 서구", home: "https://www.seo.incheon.kr/" },
  { region: "인천광역시 강화군", home: "https://www.ganghwa.go.kr/" },
  { region: "인천광역시 옹진군", home: "https://www.ongjin.go.kr/" },
];

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = {};

for (const { region, home } of SITES) {
  console.log(`\n##### ${region} (${home}) #####`);
  const ctx = await browser.newContext({ userAgent: UA, locale: "ko-KR" });
  const page = await ctx.newPage();
  const found = [];
  try {
    await page.goto(home, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(1200);
    for (const sel of ["#allmenu", ".allmenu", "[class*=all][class*=menu]", ".btn_total", ".total_menu", "[href*='allmenu']"]) {
      try { await page.click(sel, { timeout: 1000 }); await page.waitForTimeout(400); } catch {}
    }
    const host = new URL(home).host;
    let cands = await page.$$eval("a", (as, h) => as
      .filter((a) => { try { return new URL(a.href).host === h; } catch { return false; } })
      .map((a) => ({ t: (a.textContent || "").trim(), u: a.href })), host);
    // 게시판스러운 링크만
    cands = cands.filter((c) => c.t && (HREF_BOARD.test(c.u) || BOARDISH.test(c.t)));
    const seen = new Set();
    cands = cands.filter((c) => { const k = c.u.split("#")[0]; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 18);

    for (const c of cands) {
      try {
        await page.goto(c.u, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.waitForTimeout(500);
        const info = await page.evaluate((kwSrc) => {
          const KW = new RegExp(kwSrc);
          const as = [...document.querySelectorAll("a")];
          const posts = as.filter((a) => {
            const t = (a.textContent || "").trim();
            const link = (a.getAttribute("href") || "") + (a.getAttribute("onclick") || "");
            return t.length > 6 && /(view|seq=|idx=|no=|num=|nttSn|articleNo|bIdx|bbsIdx|\d{3,})/i.test(link);
          });
          return { posts: posts.length, supports: posts.filter((a) => KW.test(a.textContent || "")).length,
            sample: posts.filter((a) => KW.test(a.textContent || "")).slice(0, 2).map((a) => (a.textContent || "").trim().slice(0, 38)) };
        }, KW.source);
        if (info.supports > 0) { found.push({ u: c.u, ...info }); console.log(`  ✓[지원 ${info.supports}] ${c.u}`); info.sample.forEach((s) => console.log(`       · ${s}`)); }
      } catch {}
    }
  } catch (e) { console.log(`  ✗ 홈 접속 실패: ${clip(e.message, 50)}`); }
  found.sort((a, b) => b.supports - a.supports);
  results[region] = found.slice(0, 6).map((f) => f.u);
  await ctx.close();
}

console.log(`\n\n================ REGISTRY 등록용 ================`);
for (const [region, urls] of Object.entries(results)) {
  if (!urls.length) { console.log(`  // ${region}: (지원공고 게시판 미발견)`); continue; }
  console.log(`  { region: "${region}", boards: [`);
  urls.forEach((u) => console.log(`    "${u}",`));
  console.log(`  ] },`);
}
await browser.close();
