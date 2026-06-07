/* UI 로직: 폼 → 엔진 → 결과 렌더 + 프리미엄 깔때기 */
(function () {
  "use strict";
  const cfg = window.SITE_CONFIG || {};
  const E = window.GyeongjosaEngine;
  const $ = (s, r = document) => r.querySelector(s);

  // 분석(선택)
  if (cfg.GA_MEASUREMENT_ID) {
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + cfg.GA_MEASUREMENT_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { dataLayer.push(arguments); };
    gtag("js", new Date());
    gtag("config", cfg.GA_MEASUREMENT_ID);
  }
  function track(name, params) {
    if (window.gtag) gtag("event", name, params || {});
  }

  const form = $("#calc-form");
  const resultBox = $("#result");

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const data = {
      event: $("#event").value,
      relation: $("#relation").value,
      intimacy: $("#intimacy").value,
      attend: $("#attend").value === "yes",
      guests: $("#guests").value,
      venue: $("#venue").value,
    };
    const r = E.recommend(data);
    renderResult(r);
    track("recommend", { event: data.event, amount: r.recommended });
    resultBox.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  function renderResult(r) {
    const env = r.envelope;
    resultBox.hidden = false;
    resultBox.innerHTML = `
      <div class="result-card">
        <p class="result-eyebrow">${r.eventLabel} · 추천 금액</p>
        <p class="result-amount">${E.won(r.recommended)}</p>
        <p class="result-range">적정 범위 ${E.won(r.range.low)} ~ ${E.won(r.range.high)}</p>
        <p class="result-reason">${r.reason}</p>
        ${r.mealNote ? `<p class="result-note">💡 ${r.mealNote}</p>` : ""}
      </div>

      <div class="grid-2">
        <div class="mini-card">
          <h3>✍️ 봉투 문구 (${env.title})</h3>
          <div class="envelope-preview" id="env-preview">
            <span class="env-front">${env.front}</span>
          </div>
          <p class="mini-label">대표 문구를 봉투 앞면 중앙에 세로/가로로 적으세요.</p>
          <p class="alts"><strong>다른 표현:</strong> ${env.alts.join(" · ")}</p>
          <p class="alts"><strong>한글:</strong> ${env.ko}</p>
          <p class="alts back-note">📌 ${env.back}</p>
          <button class="btn-ghost" id="print-btn" type="button">🖨️ 무료 봉투 1장 인쇄/저장</button>
        </div>

        <div class="mini-card">
          <h3>💬 전달 메시지</h3>
          <ul class="msg-list">
            ${r.message.map((m) => `<li><button class="msg-copy" type="button" data-msg="${escapeAttr(m)}">${m}</button></li>`).join("")}
          </ul>
          <p class="mini-label">문구를 누르면 복사됩니다.</p>
        </div>
      </div>

      ${renderUpsell()}
      ${renderAffiliate(r)}
    `;

    $("#print-btn").addEventListener("click", () => {
      track("print_free_envelope", {});
      printEnvelope(env);
    });
    resultBox.querySelectorAll(".msg-copy").forEach((b) => {
      b.addEventListener("click", () => {
        navigator.clipboard?.writeText(b.dataset.msg);
        b.classList.add("copied");
        b.textContent = "✅ 복사됨!";
        setTimeout(() => { b.classList.remove("copied"); b.textContent = b.dataset.msg; }, 1200);
        track("copy_message", {});
      });
    });
    const cta = $("#upsell-cta");
    if (cta) cta.addEventListener("click", () => track("checkout_click", {}));
  }

  function renderUpsell() {
    const hasLink = cfg.CHECKOUT_URL && cfg.CHECKOUT_URL.length > 5;
    const orig = cfg.PRICE_ORIGINAL && cfg.PRICE_ORIGINAL !== cfg.PRICE
      ? `<span class="price-original">${cfg.PRICE_ORIGINAL}</span>` : "";
    return `
      <div class="upsell">
        <div class="upsell-badge">PREMIUM</div>
        <h3>🎁 경조사 봉투 PDF 풀팩 + 에티켓 가이드</h3>
        <ul class="upsell-list">
          <li>상황별 <strong>봉투 인쇄 템플릿 30종</strong> (결혼·장례·돌·환갑·개업, 고급 디자인)</li>
          <li>실수 없는 <strong>한자 문구 & 호칭 사전</strong></li>
          <li>관계별 <strong>경조사 메시지 100선</strong> (바로 복사)</li>
          <li><strong>경조사 에티켓 가이드 e북</strong> (복장·조문 예절·축의금 매너)</li>
        </ul>
        <p class="upsell-price">${orig} <strong>${cfg.PRICE || "4,900원"}</strong> · 1회 결제 / 즉시 다운로드</p>
        ${hasLink
          ? `<a id="upsell-cta" class="btn-primary btn-buy" href="${cfg.CHECKOUT_URL}" target="_blank" rel="noopener">지금 받기 →</a>`
          : `<button class="btn-primary btn-buy" type="button" disabled>준비중 (결제 링크 연결 전)</button>`}
        <p class="guarantee">🔒 안전 결제 · 마음에 안 들면 환불</p>
      </div>`;
  }

  function renderAffiliate(r) {
    const aff = cfg.AFFILIATE || {};
    const items = [];
    if (r.envelope.title.includes("부의") && aff.flower) {
      items.push(`<a href="${aff.flower}" target="_blank" rel="noopener nofollow sponsored" class="aff-link">🌼 근조화환 보내기</a>`);
    }
    if (!r.envelope.title.includes("부의") && aff.flower) {
      items.push(`<a href="${aff.flower}" target="_blank" rel="noopener nofollow sponsored" class="aff-link">💐 축하화환 보내기</a>`);
    }
    if (aff.gift) {
      items.push(`<a href="${aff.gift}" target="_blank" rel="noopener nofollow sponsored" class="aff-link">🎫 모바일 상품권 보내기</a>`);
    }
    if (!items.length) return "";
    return `<div class="affiliate"><p class="aff-title">함께 준비하면 좋아요</p>${items.join("")}<p class="aff-disc">* 일부 링크는 제휴(파트너스) 링크일 수 있습니다.</p></div>`;
  }

  function printEnvelope(env) {
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
      <title>${env.title}</title>
      <style>
        @page { size: A4; margin: 0; }
        body { margin:0; font-family: 'Nanum Myeongjo', serif; }
        .sheet { width:210mm; height:297mm; display:flex; align-items:center; justify-content:center; }
        .env { width:120mm; height:60mm; border:2px solid #222; display:flex;
               align-items:center; justify-content:center; position:relative; }
        .front { font-size:34pt; letter-spacing:14px; font-weight:700; }
        .name-hint { position:absolute; bottom:6mm; left:8mm; font-size:9pt; color:#888; }
        @media print { .no-print { display:none; } }
      </style></head><body>
      <div class="no-print" style="padding:12px;text-align:center;font-family:sans-serif">
        Ctrl/⌘+P 로 인쇄하거나 'PDF로 저장'을 선택하세요.
      </div>
      <div class="sheet"><div class="env">
        <span class="front">${env.front}</span>
        <span class="name-hint">↳ 뒷면 왼쪽 아래에 이름·소속</span>
      </div></div>
      </body></html>`);
    w.document.close();
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }
})();
