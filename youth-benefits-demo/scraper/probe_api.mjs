#!/usr/bin/env node
/**
 * 미발견 구(남동·계양·미추홀) 게시판 2단계 발견 (헤드리스)
 * ------------------------------------------------------------------
 * eGov(.do) 계열은 메뉴가 깊어 1단계로 안 잡힘 → 홈→섹션→게시판 2단계 크롤.
 * 각 후보 페이지가 '지원공고 보유'인지 판정해 구별 등록용 URL 출력.
 */
import { chromium } from "playwright";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const KW = /지원|보조금|지원금|모집|신청|지급|바우처|선착순|수당|장려금|구입비|설치비|교부/;
const BOARDISH = /(공고|공지|지원|모집|알림|소식|사업|게시|복지|보조|민원|행정)/;
const HREF_BOARD = /(bbs|board|notice|gosi|\.do|selectBoardList|artcl|nttList|cnts|cop\/bbs)/i;
const clip = (s, n) => (s ? `${s}`.replace(/\s+/g, " ").trim().slice(0, n) : "");

const SITES = [
  { region: "인천광역시 남동구", home: "https://www.namdong.go.kr/" },
  { region: "인천광역시 계양구", home: "https://www.gyeyang.go.kr/" },
  { region: "인천광역시 미추홀구", home: "https://www.michuhol.go.kr/" },
];

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = {};

async function postCheck(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForTimeout(600);
  return page.evaluate((kwSrc) => {
    const KW = new RegExp(kwSrc);
    const as = [...document.querySelectorAll("a")];
    const posts = as.filter((a) => {
      const t = (a.textContent || "").trim();
      const link = (a.getAttribute("href") || "") + (a.getAttribute("onclick") || "");
      return t.length > 6 && /(view|seq=|idx=|no=|num=|nttSn|articleNo|bbsIdx|mgr_seq|\d{3,})/i.test(link);
    });
    return { posts: posts.length, supports: posts.filter((a) => KW.test(a.textContent || "")).length,
      sample: posts.filter((a) => KW.test(a.textContent || "")).slice(0, 2).map((a) => (a.textContent || "").trim().slice(0, 38)) };
  }, kwSrc);
}

for (const { region, home } of SITES) {
  console.log(`\n##### ${region} (${home}) #####`);
  const ctx = await browser.newContext({ userAgent: UA, locale: "ko-KR" });
  const page = await ctx.newPage();
  const found = [];
  try {
    let loaded = false;
    for (let a = 0; a < 2 && !loaded; a++) {
      try { await page.goto(home, { waitUntil: "load", timeout: 55000 }); loaded = true; }
      catch (e) { console.log(`  …재시도(${a + 1}) ${clip(e.message, 40)}`); }
    }
    if (!loaded) throw new Error("홈 로드 타임아웃(55s×2)");
    await page.waitForTimeout(1500);
    for (const sel of ["#allmenu", ".allmenu", "[class*=all][class*=menu]", ".btn_total", ".total_menu", "a[href*='allmenu']", ".gnb_all"]) {
      try { await page.click(sel, { timeout: 1000 }); await page.waitForTimeout(400); } catch {}
    }
    const host = new URL(home).host;
    let links = await page.$$eval("a", (as, h) => as
      .filter((a) => { try { return new URL(a.href).host === h; } catch { return false; } })
      .map((a) => ({ t: (a.textContent || "").trim(), u: a.href.split("#")[0] })), host);
    let lv1 = [...new Map(links.filter((l) => l.t && (HREF_BOARD.test(l.u) || BOARDISH.test(l.t))).map((l) => [l.u, l])).values()].slice(0, 25);

    const visited = new Set();
    for (const c of lv1) {
      if (visited.has(c.u)) continue; visited.add(c.u);
      try {
        const info = await postCheck(page, c.u);
        if (info.supports > 0) { found.push({ u: c.u, ...info }); console.log(`  ✓[지원 ${info.supports}] ${c.u}`); info.sample.forEach((s) => console.log(`       · ${s}`)); continue; }
        const sub = await page.$$eval("a", (as, h) => as.filter((a) => { try { return new URL(a.href).host === h; } catch { return false; } }).map((a) => ({ t: (a.textContent || "").trim(), u: a.href.split("#")[0] })), host);
        const lv2 = [...new Map(sub.filter((l) => l.t && HREF_BOARD.test(l.u)).map((l) => [l.u, l])).values()].slice(0, 4);
        for (const s of lv2) {
          if (visited.has(s.u)) continue; visited.add(s.u);
          try { const info2 = await postCheck(page, s.u); if (info2.supports > 0) { found.push({ u: s.u, ...info2 }); console.log(`  ✓✓[지원 ${info2.supports}] ${s.u}`); info2.sample.forEach((x) => console.log(`       · ${x}`)); } } catch {}
        }
      } catch {}
    }
  } catch (e) { console.log(`  ✗ 홈 실패: ${clip(e.message, 50)}`); }
  found.sort((a, b) => b.supports - a.supports);
  results[region] = found.slice(0, 5).map((f) => f.u);
  await ctx.close();
}

console.log(`\n\n================ REGISTRY 등록용 ================`);
for (const [region, urls] of Object.entries(results)) {
  if (!urls.length) { console.log(`  // ${region}: 미발견(수동 확인 필요)`); continue; }
  console.log(`  { region: "${region}", boards: [`);
  urls.forEach((u) => console.log(`    "${u}",`));
  console.log(`  ] },`);
}
await browser.close();
