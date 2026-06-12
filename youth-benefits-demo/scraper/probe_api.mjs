#!/usr/bin/env node
/**
 * 연수구 게시판 "넓게" 발견 (헤드리스)
 * ------------------------------------------------------------------
 * 메인+전체메뉴의 모든 .asp 링크를 훑어, 각 페이지가 '글 목록 게시판'인지
 * (지원/모집/공고성 글 링크가 있는지) 판정해 등록 후보를 출력한다.
 * 출력된 URL을 boards.mjs REGISTRY에 추가하면 수집 범위가 넓어짐.
 */
import { chromium } from "playwright";

const HOME = "https://www.yeonsu.go.kr/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const KW = /지원|보조금|지원금|모집|신청|지급|바우처|선착순|수당|장려금|구입비|설치비|교부/;
const clip = (s, n) => (s ? `${s}`.replace(/\s+/g, " ").trim().slice(0, n) : "");

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newContext({ userAgent: UA, locale: "ko-KR" }).then((c) => c.newPage());

console.log("== 연수구 게시판 넓게 발견 ==");
await page.goto(HOME, { waitUntil: "networkidle", timeout: 30000 }).catch((e) => console.log("home:", e.message));

// 전체메뉴 열기 시도 (있으면 더 많은 링크 노출)
for (const sel of ["#allmenu", ".allmenu", "[href*='allmenu']", ".btn_all", "#gnbAll"]) {
  try { await page.click(sel, { timeout: 1500 }); await page.waitForTimeout(500); } catch {}
}

// .asp 게시판류 링크 수집
let urls = await page.$$eval("a", (as) =>
  as.map((a) => a.href).filter((h) => /\.asp(\?|$)/.test(h) && /yeonsu\.go\.kr\/main\/part\//.test(h)));
urls = [...new Set(urls)].slice(0, 40);
console.log(`.asp 게시판 후보 ${urls.length}개 점검...\n`);

const boards = [];
for (const u of urls) {
  try {
    await page.goto(u, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(800);
    const info = await page.evaluate((kwSrc) => {
      const KW = new RegExp(kwSrc);
      const as = [...document.querySelectorAll("a")];
      const posts = as.filter((a) => {
        const t = (a.textContent || "").trim();
        const link = (a.getAttribute("href") || "") + (a.getAttribute("onclick") || "");
        return t.length > 6 && /(view|seq=|idx=|no=|num=|nttSn|articleNo|bIdx|\d{3,})/i.test(link);
      });
      const supports = posts.filter((a) => KW.test((a.textContent || "")));
      return { posts: posts.length, supports: supports.length, sample: supports.slice(0, 2).map((a) => (a.textContent || "").trim().slice(0, 40)), title: document.title };
    }, KW.source);
    if (info.posts >= 3) boards.push({ u, ...info });
    console.log(`[글 ${String(info.posts).padStart(3)} / 지원 ${String(info.supports).padStart(2)}] ${u}`);
    if (info.sample.length) info.sample.forEach((s) => console.log(`        · ${s}`));
  } catch (e) { console.log(`[err] ${u} :: ${clip(e.message, 50)}`); }
}

boards.sort((a, b) => b.supports - a.supports);
console.log(`\n== 등록 추천(지원글 있는 게시판) ==`);
boards.filter((b) => b.supports > 0).forEach((b) => console.log(`"${b.u}",   // ${clip(b.title, 24)} (지원 ${b.supports})`));
console.log(`\n총 게시판 ${boards.length}개, 지원글 보유 ${boards.filter((b) => b.supports > 0).length}개`);
await browser.close();
