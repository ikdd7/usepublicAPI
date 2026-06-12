#!/usr/bin/env node
/**
 * 연수구 게시판 내부 API 역설계 (헤드리스 네트워크 캡처)
 * ------------------------------------------------------------------
 * 게시판이 JS로 렌더되어 정적 HTML엔 글이 없음 → 브라우저로 띄워
 * XHR/fetch 요청을 가로채 "글 목록을 주는 실제 API URL"을 찾는다.
 * 찾은 API를 이후 boards.mjs에서 가볍게 직접 호출(헤드리스 불필요).
 *
 * 실행(러너): npx playwright install --with-deps chromium && node scraper/probe_api.mjs
 */
import { chromium } from "playwright";

const HOME = "https://www.yeonsu.go.kr/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const clip = (s, n) => (s ? `${s}`.replace(/\s+/g, " ").trim().slice(0, n) : "");
const BOARDKW = /고시|공고|공지|새소식|알림|모집|공모/;
const APIHINT = /list|bbs|ntt|board|ajax|json|select|gosi|notice|article|post|cms|saeol|egov/i;

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({ userAgent: UA, locale: "ko-KR" });
const page = await ctx.newPage();

const hits = new Map(); // url -> {status, ct, method, post}
page.on("request", (req) => { req._post = req.postData(); });
page.on("response", async (res) => {
  const url = res.url();
  const ct = res.headers()["content-type"] || "";
  if (ct.includes("json") || (APIHINT.test(url) && res.request().resourceType() !== "document")) {
    if (!hits.has(url)) {
      let sample = "";
      try { sample = clip(await res.text(), 180); } catch {}
      hits.set(url, { status: res.status(), ct, method: res.request().method(), post: clip(res.request()._post, 120), sample });
    }
  }
});

console.log("== 연수구 게시판 API 캡처 ==");
await page.goto(HOME, { waitUntil: "networkidle", timeout: 30000 }).catch((e) => console.log("home goto:", e.message));

// 홈에서 게시판(고시/공고/공지/새소식) 링크 수집
const links = await page.$$eval("a", (as) => as.map((a) => ({ t: (a.textContent || "").trim(), h: a.href })));
const boards = [...new Map(links.filter((l) => /고시|공고|공지|새소식|알림|모집|공모/.test(l.t) && l.h.startsWith("http")).map((l) => [l.h, l])).values()].slice(0, 6);
console.log(`게시판 링크 후보 ${boards.length}개:`);
boards.forEach((b) => console.log(`   - ${clip(b.t, 24)} :: ${b.h}`));

for (const b of boards) {
  console.log(`\n>>> 방문: ${clip(b.t, 20)} ${b.h}`);
  await page.goto(b.h, { waitUntil: "networkidle", timeout: 30000 }).catch((e) => console.log("  goto:", e.message));
  await page.waitForTimeout(1500);
}

console.log("\n== 캡처된 JSON/XHR 엔드포인트 ==");
let n = 0;
for (const [url, info] of hits) {
  console.log(`\n[${++n}] ${info.method} ${info.status} (${clip(info.ct,30)})`);
  console.log(`   URL: ${url}`);
  if (info.post) console.log(`   POST: ${info.post}`);
  if (info.sample) console.log(`   샘플: ${info.sample}`);
}
console.log(`\n총 ${hits.size}개 후보 엔드포인트`);
await browser.close();
