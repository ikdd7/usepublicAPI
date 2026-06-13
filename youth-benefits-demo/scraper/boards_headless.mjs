#!/usr/bin/env node
/**
 * 소스 E-2 — JS 렌더 게시판 헤드리스 수집기 (.jsp eGov 등)
 * ------------------------------------------------------------------
 * 정적 fetch로 글이 안 나오는(SPA/JS) 지자체 게시판을 Playwright로 렌더 후 수집.
 * 무거우므로 메인 파이프라인과 분리된 boards-headless.yml(하루 1회)에서 실행하고,
 * 결과를 data/boards_headless.json 으로 커밋 → 메인 수집이 합류.
 *
 * 실행(러너): npx playwright install --with-deps chromium && node scraper/boards_headless.mjs
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { playwrightProxy } from "./net.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "..", "data", "boards_headless.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// 정적수집 안 되는(JS 렌더) 지자체 게시판
const REGISTRY = [
  { region: "인천광역시 부평구", boards: [
    "https://www.icbp.go.kr/main/civil/property/youth.jsp",
    "https://www.icbp.go.kr/main/participation/news/incheon.jsp",
  ] },
  { region: "인천광역시 서구", boards: [
    "https://www.seo.incheon.kr/open_content/main/community/news/notice.jsp",
    "https://www.seo.incheon.kr/open_content/main/community/news/company.jsp",
  ] },
  { region: "인천광역시 강화군", boards: [
    "https://www.ganghwa.go.kr/open_content/main/part/job/aid.jsp",
    "https://www.ganghwa.go.kr/open_content/main/ganghwa/news/notice.jsp",
  ] },
  { region: "인천광역시 옹진군", boards: [
    "https://www.ongjin.go.kr/open_content/main/environment/economic/store.jsp",
    "https://www.ongjin.go.kr/open_content/main/community/board/notice.jsp",
  ] },
  { region: "인천광역시 동구", boards: [
    "https://www.icdonggu.go.kr/main/community/budget/notice.jsp",
  ] },
];

const KW = /지원|보조금|지원금|모집|신청|지급|바우처|선착순|수당|장려금|구입비|설치비|교부/;
const NOT_BENEFIT = /결과\s*공개|정산\s*(현황|결과)|심의\s*결과|선정\s*(결과|자)|발표|명단|현황$/;
const clip = (s, n) => (s ? `${s}`.replace(/\s+/g, " ").trim().slice(0, n) : "");
const won = (t = "") => { t = t.replace(/,/g, ""); const m = t.match(/(\d+)\s*억/) || t.match(/(\d{2,})\s*만/); return m ? (t.includes("억") ? +m[1] * 1e8 : +m[1] * 1e4) : 0; };
function need(t = "") { const s = new Set(); if (/청년/.test(t)) s.add("구직중"); if (/소상공인|자영업|창업/.test(t)) s.add("자영업·창업"); if (/무주택|월세|임차/.test(t)) s.add("무주택"); if (/출산|임신|육아|보육|영유아/.test(t)) s.add("육아"); if (/장애/.test(t)) s.add("장애인"); if (/저소득|기초생활|차상위/.test(t)) s.add("저소득"); return [...s]; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const _pxy = playwrightProxy();
if (_pxy) console.log(`  [proxy] 헤드리스 프록시 활성: ${_pxy.server}`);
const browser = await chromium.launch({ args: ["--no-sandbox"], ...(_pxy ? { proxy: _pxy } : {}) });
const out = [];
for (const { region, boards } of REGISTRY) {
  for (const url of boards) {
    const ctx = await browser.newContext({ userAgent: UA, locale: "ko-KR" });
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(1000);
      const posts = await page.$$eval("a", (as) => as.map((a) => ({
        t: (a.textContent || "").trim(),
        h: a.href || "",
        oc: a.getAttribute("onclick") || "",
      })));
      const picked = posts.filter((p) => p.t.length > 6 &&
        /(view|seq=|idx=|no=|num=|nttSn|articleNo|bIdx|bbsIdx|\d{3,})/i.test(p.h + p.oc));
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
      console.log(`  · ${region} ${url.split("/").pop()}: 후보 ${n}`);
    } catch (e) { console.log(`  ✗ ${region} ${url}: ${clip(e.message, 50)}`); }
    await ctx.close();
    await sleep(800);
  }
}
writeFileSync(OUT, JSON.stringify({ meta: { source: "구청공고(헤드리스)", snapshot_date: new Date().toISOString().slice(0, 10), count: out.length }, benefits: out }, null, 2));
console.log(`\n수집 ${out.length}건 (규칙기반)`);

/* ---------- 제미나이 본문 구조화 (선택) ---------- */
const gkey = process.env.GEMINI_API_KEY;
if (gkey && out.length) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  async function gemini(system, user) {
    for (let a = 0; ; a++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "x-goog-api-key": gkey, "content-type": "application/json" },
        body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 600, responseMimeType: "application/json", ...(model.includes("2.5") ? { thinkingConfig: { thinkingBudget: 0 } } : {}) } }) });
      if (res.ok) { const j = await res.json(); return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""); }
      const t = await res.text(); if (res.status === 429 && a < 2) { await sleep(8000 * 2 ** a); continue; } throw new Error(`Gemini ${res.status}: ${clip(t, 100)}`);
    }
  }
  const sys = `너는 한국 지자체 공고를 구조화한다. 본문이 '주민이 신청해 돈/현물을 받는 지원사업'이면 JSON, 아니면 {"benefit":false}.
형식: {"benefit":true,"amount_label":"금액(예 최대 30만원, 미상이면 빈칸)","summary":"45자 이내 핵심(대상·금액)"} 추측 금지.`;
  const ctx = await browser.newContext({ userAgent: UA, locale: "ko-KR" }); const p = await ctx.newPage();
  let ok = 0;
  for (const b of out.slice(0, 40)) {
    try {
      await p.goto(b.source, { waitUntil: "domcontentloaded", timeout: 20000 }); await p.waitForTimeout(500);
      const body = clip(await p.evaluate(() => document.body.innerText), 2500);
      const o = JSON.parse(await gemini(sys, `[제목] ${b.title}\n[본문] ${body}`));
      if (o.benefit === false) { b._drop = true; }
      else { if (o.amount_label) { b.amount_label = clip(o.amount_label, 80) || b.amount_label; b.amount = won(o.amount_label) || b.amount; } if (o.summary) b.summary = clip(o.summary, 60); b.llm = true; ok++; }
      await sleep(4000);
    } catch (e) { console.log(`  [LLM] ${clip(b.title, 20)} 스킵: ${clip(e.message, 60)}`); }
  }
  await ctx.close();
  const finalOut = out.filter((b) => !b._drop).map(({ _drop, ...b }) => b);
  writeFileSync(OUT, JSON.stringify({ meta: { source: "구청공고(헤드리스·AI보강)", snapshot_date: new Date().toISOString().slice(0, 10), count: finalOut.length, llm: ok }, benefits: finalOut }, null, 2));
  console.log(`✓ AI보강 ${ok}건, 최종 ${finalOut.length}건 → ${OUT}`);
} else {
  console.log(`✓ 저장: ${OUT} (${out.length}건, 규칙기반 — GEMINI_API_KEY 없음)`);
}
await browser.close();
