#!/usr/bin/env node
/**
 * 구청 공고게시판 수집 가능성 진단 (GitHub Actions 러너에서 실행)
 * ------------------------------------------------------------------
 * 목적: "공식 API에 없는 지자체 공고(예: 연수구 음식물처리기 지원)"를
 *       러너(개방 인터넷)에서 직접 수집할 수 있는지 실측.
 * 원칙: robots.txt 확인, 일반 브라우저 UA, 요청 간 지연(예의 있는 수집).
 * 출력: 각 대상의 HTTP 상태/크기/<title>/공고 링크 감지 여부 → 빌드 로그로 판정.
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const TARGETS = [
  ["연수구청 robots.txt",        "https://www.yeonsu.go.kr/robots.txt"],
  ["연수구청 메인",              "https://www.yeonsu.go.kr/"],
  ["연수구청 고시공고 게시판",    "https://www.yeonsu.go.kr/main/board/list.asp?board_code=notice02"],
  ["연수구청 공지사항 게시판",    "https://www.yeonsu.go.kr/main/board/list.asp?board_code=notice"],
  ["연수구청 새소식(알림광장)",   "https://www.yeonsu.go.kr/main/news/notice/list.asp"],
  ["인천시 고시공고",            "https://www.incheon.go.kr/IC010205"],
  ["인천시 보도·공지",           "https://www.incheon.go.kr/IC010101"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => (s ? `${s}`.replace(/\s+/g, " ").trim().slice(0, n) : "");

async function probe(name, url) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" }, signal: ctrl.signal, redirect: "follow" });
    clearTimeout(to);
    const body = await res.text();
    const title = (body.match(/<title[^>]*>([^<]{0,80})/i) || [])[1] || "";
    // 게시판 글 링크 패턴 감지 (view/detail/seq/idx 류)
    const links = (body.match(/href="[^"]*(view|View|detail|seq=|idx=|bbs)[^"]*"/g) || []).length;
    const support = /지원|보조금|신청|모집/.test(body);
    console.log(`${res.ok ? "✅" : "❌"} [${res.status}] ${name}`);
    console.log(`     ${(body.length/1024).toFixed(1)}KB · title="${clip(title,50)}" · 글링크 ${links}개 · 지원/공고 키워드 ${support ? "있음" : "없음"}`);
    if (name.includes("robots")) console.log(`     robots: ${clip(body, 200) || "(빈 파일=수집 제한 없음)"}`);
  } catch (e) {
    console.log(`❌ [ERR] ${name} :: ${clip(e.message, 80)}`);
  }
  await sleep(1200); // 예의 있는 간격
}

console.log("== 구청 공고게시판 접근성 진단 (러너 환경) ==");
for (const [name, url] of TARGETS) await probe(name, url);
console.log("== 진단 끝 ==");
