import { getKaimeRule } from "./kaime-rules.js";

const PLAN_PHASE_PRIORITY = {
  honmei: {
    primary: ["main-narrow"],
    fallback: ["main-wide", "cover-narrow", "hole-narrow", "cover-wide", "hole-wide"],
    note: "決まり手ルールから本線を固定"
  },
  ana: {
    primary: ["cover-narrow", "hole-narrow", "main-wide"],
    fallback: ["cover-wide", "hole-wide", "main-narrow"],
    note: "決まり手ルールから押さえを固定"
  }
};
const TYPE_RISK_WEIGHT = {
  差し: 1,
  捲り: 1.15,
  捲り差し: 1.1
};
const BOAT_RISK_WEIGHT = {
  2: 1,
  3: 1.08,
  4: 1.15,
  5: 1.05,
  6: 0.95
};
const PRIMARY_MAKURI_SCORE_GAP_THRESHOLD = 5;

function getReasonScore(reason) {
  return reason.attack - reason.defense;
}

function getMakuriPrimaryBias(reason) {
  if (reason?.type !== "捲り") {
    return 0;
  }

  switch (reason.boat) {
    case 4:
      return 2.5;
    case 3:
      return 2;
    case 5:
      return 1;
    case 2:
      return 0;
    case 6:
      return -0.5;
    default:
      return 0;
  }
}

export function calculateEscapeRisk(matchReasons) {
  if (!Array.isArray(matchReasons) || matchReasons.length === 0) {
    return {
      score: 0,
      label: "C",
      summary: "条件一致なし"
    };
  }

  const weighted = matchReasons
    .map((reason) => {
      const margin = Math.max(0, reason.attack - reason.defense);
      const pressure = Math.max(0, reason.defense - 10);
      const attackPower = Math.max(0, reason.attack - 10);
      const typeWeight = TYPE_RISK_WEIGHT[reason.type] || 1;
      const boatWeight = BOAT_RISK_WEIGHT[reason.boat] || 1;
      const score = ((margin * 2.2) + attackPower + (pressure * 0.8)) * typeWeight * boatWeight;

      return {
        ...reason,
        score
      };
    })
    .sort((left, right) => right.score - left.score);

  const topScores = weighted.slice(0, 2).reduce((sum, reason) => sum + reason.score, 0);
  const multiMatchBonus = weighted.length > 1 ? (weighted.length - 1) * 1.5 : 0;
  const score = Number.parseFloat((topScores + multiMatchBonus).toFixed(1));
  const label = score >= 60 ? "S" : score >= 35 ? "A" : score >= 18 ? "B" : "C";
  const strongest = weighted[0];

  return {
    score,
    label,
    summary: `${strongest.type} ${strongest.boat}号艇`
  };
}

function uniqueNumbers(values) {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value >= 1 && value <= 6))];
}

function buildTickets(headBoat, secondBoats, thirdBoats) {
  const tickets = [];

  for (const secondBoat of uniqueNumbers(secondBoats)) {
    if (secondBoat === headBoat) {
      continue;
    }

    for (const thirdBoat of uniqueNumbers(thirdBoats)) {
      if (thirdBoat === headBoat || thirdBoat === secondBoat) {
        continue;
      }

      tickets.push(`${headBoat}-${secondBoat}-${thirdBoat}`);
    }
  }

  return [...new Set(tickets)];
}

function buildPhaseDefinitions(rule, headBoat) {
  return [
    {
      key: "main-narrow",
      label: "本線2着 × 3着候補(狭)",
      tickets: buildTickets(headBoat, rule.secondMain, rule.thirdNarrow)
    },
    {
      key: "main-wide",
      label: "本線2着 × 3着候補(広)",
      tickets: buildTickets(headBoat, rule.secondMain, rule.thirdWide)
    },
    {
      key: "cover-narrow",
      label: "押さえ2着 × 3着候補(狭)",
      tickets: buildTickets(headBoat, rule.secondCover, rule.thirdNarrow)
    },
    {
      key: "hole-narrow",
      label: "穴2着 × 3着候補(狭)",
      tickets: buildTickets(headBoat, rule.secondHole, rule.thirdNarrow)
    },
    {
      key: "cover-wide",
      label: "押さえ2着 × 3着候補(広)",
      tickets: buildTickets(headBoat, rule.secondCover, rule.thirdWide)
    },
    {
      key: "hole-wide",
      label: "穴2着 × 3着候補(広)",
      tickets: buildTickets(headBoat, rule.secondHole, rule.thirdWide)
    }
  ].filter((phase) => phase.tickets.length > 0);
}

export function selectPrimaryMatchReason(matchReasons) {
  if (!Array.isArray(matchReasons) || matchReasons.length === 0) {
    return null;
  }

  const candidates = matchReasons
    .map((reason, index) => ({
      reason,
      index,
      rule: getKaimeRule(reason.type, reason.boat),
      score: getReasonScore(reason)
    }))
    .filter((item) => item.rule);

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      const scoreGap = Math.abs(right.score - left.score);
      if (scoreGap <= PRIMARY_MAKURI_SCORE_GAP_THRESHOLD) {
        const biasGap = getMakuriPrimaryBias(right.reason) - getMakuriPrimaryBias(left.reason);
        if (biasGap !== 0) {
          return biasGap;
        }
      }
      return right.score - left.score;
    }
    const biasGap = getMakuriPrimaryBias(right.reason) - getMakuriPrimaryBias(left.reason);
    if (biasGap !== 0) {
      return biasGap;
    }
    if (right.reason.attack !== left.reason.attack) {
      return right.reason.attack - left.reason.attack;
    }
    return left.index - right.index;
  });

  return {
    ...candidates[0].reason,
    score: candidates[0].score
  };
}

export function calculateSyntheticOdds(tickets, oddsByCombination) {
  const oddsMap = oddsByCombination instanceof Map ? oddsByCombination : new Map(Object.entries(oddsByCombination || {}));
  if (tickets.length === 0) {
    return null;
  }

  let inverseSum = 0;

  for (const ticket of tickets) {
    const value = oddsMap.get(ticket);
    const odds = typeof value === "number" ? value : null;
    if (odds === null) {
      return null;
    }
    inverseSum += 1 / odds;
  }

  if (inverseSum <= 0) {
    return null;
  }

  return 1 / inverseSum;
}

function selectPlanPhases(phases, phaseKeys) {
  return phaseKeys
    .map((key) => phases.find((phase) => phase.key === key))
    .filter(Boolean);
}

function appendUniqueTickets(target, source) {
  for (const ticket of source) {
    if (!target.includes(ticket)) {
      target.push(ticket);
    }
  }
}

function buildFixedPlan({ primaryReason, phases, planType }) {
  const planDefinition = PLAN_PHASE_PRIORITY[planType];
  const selectedPhases = selectPlanPhases(phases, planDefinition.primary);

  if (selectedPhases.length === 0) {
    selectedPhases.push(...selectPlanPhases(phases, planDefinition.fallback).slice(0, 1));
  }

  const tickets = [];
  for (const phase of selectedPhases) {
    appendUniqueTickets(tickets, phase.tickets);
  }

  return {
    status: tickets.length > 0 ? "buy" : "no-tickets",
    prediction: primaryReason,
    phases: selectedPhases,
    tickets,
    syntheticOdds: null,
    note: tickets.length > 0 ? planDefinition.note : "固定ルールから買い目を組めませんでした"
  };
}

function removePlanOverlap(primaryPlan, secondaryPlan) {
  if (primaryPlan.status !== "buy" || secondaryPlan.status !== "buy") {
    return secondaryPlan;
  }

  const filteredPhases = secondaryPlan.phases
    .map((phase) => ({
      ...phase,
      tickets: phase.tickets.filter((ticket) => !primaryPlan.tickets.includes(ticket))
    }))
    .filter((phase) => phase.tickets.length > 0);

  const filteredTickets = secondaryPlan.tickets.filter((ticket) => !primaryPlan.tickets.includes(ticket));
  if (filteredTickets.length === 0) {
    return secondaryPlan;
  }

  return {
    ...secondaryPlan,
    phases: filteredPhases,
    tickets: filteredTickets,
    note: secondaryPlan.note ? `${secondaryPlan.note} (本線重複を除外)` : "本線重複を除外"
  };
}

export function buildKaimePlan({
  race,
  planType = "honmei"
}) {
  const primaryReason = selectPrimaryMatchReason(race?.matchReasons || []);
  if (!primaryReason) {
    return {
      status: "no-rule",
      prediction: null,
      phases: [],
      tickets: [],
      syntheticOdds: null,
      note: "No supported head boat / kimarite combination found in matchReasons"
    };
  }

  const rule = getKaimeRule(primaryReason.type, primaryReason.boat);
  const phases = buildPhaseDefinitions(rule, primaryReason.boat);
  return buildFixedPlan({
    primaryReason,
    phases,
    planType
  });
}

export function buildDualKaimePlans({
  race
}) {
  const honmei = buildKaimePlan({
    race,
    planType: "honmei"
  });
  const ana = removePlanOverlap(honmei, buildKaimePlan({
    race,
    planType: "ana"
  }));

  return {
    ana,
    honmei
  };
}
