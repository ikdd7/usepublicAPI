/*
 * 경조사비 추천 엔진 (순수 함수, 백엔드 불필요)
 * 한국 경조사 관습을 휴리스틱으로 모델링합니다.
 * - 금액은 문화적으로 통용되는 단위로 스냅(snap)합니다: 3/5/7/10/15/20/30/50만 원
 * - 결혼식 등 식사 제공 행사는 "식대"를 반영해 참석 시 하한을 높입니다.
 * 주의: 어디까지나 참고용 가이드입니다. 최종 금액은 본인의 형편과 관계에 맞게 결정하세요.
 */
(function (global) {
  "use strict";

  // 통용 금액 단위(원)
  const STEPS = [30000, 50000, 70000, 100000, 150000, 200000, 300000, 500000, 1000000];

  function snap(amount) {
    // 가장 가까운(올림 우선) 통용 단위로 보정
    for (const s of STEPS) {
      if (amount <= s) return s;
    }
    return STEPS[STEPS.length - 1];
  }

  // 행사별 기본 금액(보통 관계 기준, 원)
  const BASE = {
    wedding:   { label: "결혼식 (축의금)",        base: 50000 },
    funeral:   { label: "장례식 (부의금)",        base: 50000 },
    firstbday: { label: "돌잔치 (축하금)",        base: 50000 },
    longevity: { label: "환갑·칠순·고희 (축하금)", base: 50000 },
    opening:   { label: "개업·승진·집들이",       base: 50000 },
  };

  // 관계별 배수
  const RELATION = {
    family:    { label: "가족·가까운 친척",   mult: 2.0 },
    relative:  { label: "친척",              mult: 1.4 },
    closefriend:{ label: "친한 친구",        mult: 1.4 },
    friend:    { label: "친구·동창",         mult: 1.0 },
    boss:      { label: "직장 상사",         mult: 1.1 },
    coworker:  { label: "직장 동료",         mult: 1.0 },
    junior:    { label: "직장 후배·부하",     mult: 1.0 },
    acquaint:  { label: "지인·이웃",         mult: 0.7 },
  };

  // 친밀도 가중
  const INTIMACY = {
    low:    { label: "데면데면함",   mult: 0.8 },
    normal: { label: "보통",        mult: 1.0 },
    high:   { label: "친함",        mult: 1.25 },
    veryhigh:{ label: "매우 친함",   mult: 1.6 },
  };

  // 식대(참석 시 하한) — 식사 제공 행사에만 적용
  const MEAL_FLOOR = {
    normal: 50000,  // 일반 예식장/식당
    premium: 100000, // 호텔·고급 뷔페
  };
  const SERVES_MEAL = new Set(["wedding", "firstbday", "longevity", "opening"]);

  /**
   * @param {Object} input
   * @param {string} input.event     - wedding|funeral|firstbday|longevity|opening
   * @param {string} input.relation  - RELATION 키
   * @param {string} input.intimacy  - INTIMACY 키
   * @param {boolean} input.attend   - 참석(식사) 여부
   * @param {number} input.guests    - 함께 가는 동반 인원(본인 제외, 식사 기준)
   * @param {string} input.venue     - normal|premium
   * @returns {Object} 추천 결과
   */
  function recommend(input) {
    const ev = BASE[input.event] || BASE.wedding;
    const rel = RELATION[input.relation] || RELATION.coworker;
    const inti = INTIMACY[input.intimacy] || INTIMACY.normal;
    const venue = input.venue === "premium" ? "premium" : "normal";
    const attend = !!input.attend;
    const guests = Math.max(0, parseInt(input.guests || 0, 10));

    // 1) 기본 계산
    let raw = ev.base * rel.mult * inti.mult;

    // 2) 식대 반영(식사 제공 행사 + 참석 시)
    let mealNote = "";
    if (SERVES_MEAL.has(input.event) && attend) {
      const floor = MEAL_FLOOR[venue] * (1 + guests); // 본인 + 동반인원 식대
      if (raw < floor) {
        raw = floor;
        mealNote = `참석 시 1인 식대(${venue === "premium" ? "호텔·고급" : "일반"} 기준)를 고려해 하한을 높였습니다.`;
      } else if (guests > 0) {
        raw += MEAL_FLOOR[venue] * guests;
        mealNote = `동반 ${guests}명의 식대를 반영했습니다.`;
      }
    }
    // 장례식은 식사를 하더라도 부의금 성격상 식대 가산을 강하게 두지 않음
    if (input.event === "funeral" && attend && guests > 0) {
      raw += 20000 * guests;
    }

    // 3) 통용 단위로 스냅 → 적정/하한/상한 범위 생성
    const mid = snap(raw);
    const idx = STEPS.indexOf(mid);
    const low = STEPS[Math.max(0, idx - 1)];
    const high = STEPS[Math.min(STEPS.length - 1, idx + 1)];

    return {
      eventLabel: ev.label,
      recommended: mid,
      range: { low, high },
      mealNote,
      reason: buildReason({ ev, rel, inti, attend, venue, guests, mid }),
      envelope: ENVELOPE[input.event] || ENVELOPE.wedding,
      message: pickMessage(input.event),
    };
  }

  function won(n) {
    return n.toLocaleString("ko-KR") + "원";
  }

  function buildReason(c) {
    const parts = [];
    parts.push(`${c.rel.label} · ${c.inti.label} 관계 기준`);
    if (c.attend) parts.push(`${c.venue === "premium" ? "호텔/고급" : "일반"} 장소 참석`);
    else parts.push("불참(봉투만 전달)");
    if (c.guests > 0) parts.push(`동반 ${c.guests}명`);
    return parts.join(" · ") + ` → 통용 단위로 보정한 적정 금액은 ${won(c.mid)} 입니다.`;
  }

  // 봉투 문구(한자/한글). 앞면 중앙 문구 + 대안.
  const ENVELOPE = {
    wedding: {
      title: "결혼 축의금 봉투",
      front: "祝 結婚",
      alts: ["祝 華婚", "祝 盛典", "賀 儀", "축 결혼"],
      ko: "결혼을 진심으로 축하합니다",
      back: "봉투 뒷면 왼쪽 아래에 본인 이름과 소속(회사/모임)을 세로로 적습니다.",
    },
    funeral: {
      title: "부의금 봉투",
      front: "賻 儀",
      alts: ["謹 弔", "弔 意", "追 慕", "삼가 조의를 표합니다"],
      ko: "삼가 고인의 명복을 빕니다",
      back: "봉투 뒷면 왼쪽 아래에 본인 이름과 소속을 세로로 적습니다. (부의는 단정하게)",
    },
    firstbday: {
      title: "돌잔치 축하 봉투",
      front: "祝 生日",
      alts: ["祝 돌", "첫 생일을 축하합니다", "祝 一週年"],
      ko: "건강하게 자라기를 바랍니다",
      back: "봉투 뒷면에 이름과 관계를 적습니다.",
    },
    longevity: {
      title: "환갑·칠순 축하 봉투",
      front: "祝 壽宴",
      alts: ["祝 回甲(환갑)", "祝 古稀(칠순)", "壽 (수)", "만수무강하세요"],
      ko: "만수무강하시고 건강하세요",
      back: "봉투 뒷면에 이름과 소속을 적습니다.",
    },
    opening: {
      title: "개업·승진 축하 봉투",
      front: "祝 發展",
      alts: ["祝 開業(개업)", "祝 昇進(승진)", "祝 榮轉(영전)", "번창을 기원합니다"],
      ko: "사업의 번창을 기원합니다",
      back: "봉투 뒷면에 이름과 소속을 적습니다.",
    },
  };

  const MESSAGES = {
    wedding: [
      "두 분의 앞날에 사랑과 행복이 가득하길 바랍니다. 결혼 축하해요!",
      "새로운 시작을 진심으로 축하합니다. 늘 서로 아끼며 행복하세요.",
    ],
    funeral: [
      "삼가 고인의 명복을 빕니다. 부디 힘내시길 바랍니다.",
      "갑작스러운 비보에 마음이 무겁습니다. 깊은 위로의 말씀을 전합니다.",
    ],
    firstbday: [
      "첫 생일을 축하합니다. 늘 건강하고 밝게 자라기를 바랍니다.",
      "예쁜 아기의 돌을 축하해요. 가정에 늘 웃음이 가득하길!",
    ],
    longevity: [
      "건강하게 오래오래 행복하세요. 진심으로 축하드립니다.",
      "만수무강하시길 기원합니다. 늘 건강하세요.",
    ],
    opening: [
      "새로운 시작을 축하합니다. 하시는 일 모두 번창하시길 바랍니다.",
      "진심으로 축하드립니다. 앞으로의 발전을 응원합니다.",
    ],
  };

  function pickMessage(event) {
    const arr = MESSAGES[event] || MESSAGES.wedding;
    return arr;
  }

  global.GyeongjosaEngine = { recommend, won, BASE, RELATION, INTIMACY };
})(window);
