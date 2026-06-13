/**
 * 프록시 경로(한국 IP) 지원 — PROXY_URL 시크릿이 있을 때만 활성.
 *  - 게시판 fetch에만 적용(공공 API 대량 스캔은 직결 유지 → 프록시 대역폭 절약).
 *  - undici(ProxyAgent)를 동적 import. 미설치/미설정이면 조용히 직결로 폴백.
 *  형식 예: PROXY_URL="http://user:pass@host:port" 또는 "http://host:port"
 */
let _mod; let _tried = false;

// 프록시 활성 시 {fetch, agent} 반환(설치된 undici의 fetch+ProxyAgent를 '한 쌍'으로 사용
// — Node 내장 fetch에 외부 undici의 dispatcher를 넘기면 인식 안 되는 문제 회피). 없으면 null.
export async function proxyFetch() {
  if (_tried) return _mod;
  _tried = true;
  const url = process.env.PROXY_URL;
  if (!url) { _mod = null; return null; }
  try {
    const u = await import("undici");
    _mod = { fetch: u.fetch, agent: new u.ProxyAgent(url) };
    console.log(`  [proxy] 활성: ${maskUrl(url)}`);
  } catch (e) {
    console.log(`  [proxy] 비활성(undici 없음/오류 → 직결): ${e.message}`);
    _mod = null;
  }
  return _mod;
}

// Playwright launch용 proxy 객체(없으면 null)
export function playwrightProxy() {
  const url = process.env.PROXY_URL;
  if (!url) return null;
  try {
    const u = new URL(url);
    const p = { server: `${u.protocol}//${u.host}` };
    if (u.username) p.username = decodeURIComponent(u.username);
    if (u.password) p.password = decodeURIComponent(u.password);
    return p;
  } catch { return null; }
}

export const hasProxy = () => !!process.env.PROXY_URL;
function maskUrl(u) { return `${u}`.replace(/\/\/[^@/]*@/, "//***@"); }
