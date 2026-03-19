import { getKaimeRule } from "./kaime-rules.js";

function getReasonScore(reason) {
  return reason.attack - reason.defense;
}

function normalizeOddsEntries(oddsByCombination) {
  if (!oddsByCombination) {
    return new Map();
  }

  if (oddsByCombination instanceof Map) {
    return oddsByCombination;
  }

  return new Map(Object.entries(oddsByCombination));
}

function normalizeOddsValue(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/[,\s円¥]/g, "").trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
      return right.score - left.score;
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
  const oddsMap = normalizeOddsEntries(oddsByCombination);
  if (tickets.length === 0) {
    return null;
  }

  let inverseSum = 0;

  for (const ticket of tickets) {
    const odds = normalizeOddsValue(oddsMap.get(ticket));
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

export function buildKaimePlan({
  race,
  oddsByCombination = null,
  minCombinedOdds = null,
  maxCombinedOdds = null,
  minTicketOdds = 0
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
  const oddsMap = normalizeOddsEntries(oddsByCombination);
  const hasOdds = oddsMap.size > 0;
  const acceptedPhases = [];
  const acceptedTickets = [];
  let acceptedSyntheticOdds = null;
  let rangeMatched = false;

  for (const phase of phases) {
    const filteredTickets = hasOdds
      ? phase.tickets.filter((ticket) => {
          const odds = normalizeOddsValue(oddsMap.get(ticket));
          return odds !== null && odds >= minTicketOdds;
        })
      : phase.tickets;

    if (filteredTickets.length === 0) {
      continue;
    }

    const proposedTickets = [...new Set([...acceptedTickets, ...filteredTickets])];

    if (!hasOdds) {
      acceptedPhases.push({ ...phase, tickets: filteredTickets });
      acceptedTickets.push(...filteredTickets.filter((ticket) => !acceptedTickets.includes(ticket)));
      continue;
    }

    const proposedSyntheticOdds = calculateSyntheticOdds(proposedTickets, oddsMap);
    if (proposedSyntheticOdds === null) {
      break;
    }

    if (maxCombinedOdds !== null && proposedSyntheticOdds > maxCombinedOdds) {
      continue;
    }

    if (minCombinedOdds !== null && proposedSyntheticOdds < minCombinedOdds) {
      break;
    }

    acceptedPhases.push({
      ...phase,
      tickets: filteredTickets,
      syntheticOdds: proposedSyntheticOdds
    });
    acceptedTickets.push(...filteredTickets.filter((ticket) => !acceptedTickets.includes(ticket)));
    acceptedSyntheticOdds = proposedSyntheticOdds;

    if (maxCombinedOdds !== null) {
      rangeMatched = true;
      break;
    }
  }

  if (!hasOdds) {
    return {
      status: acceptedTickets.length > 0 ? "draft" : "no-tickets",
      prediction: primaryReason,
      phases: acceptedPhases,
      tickets: acceptedTickets,
      syntheticOdds: null,
      note: "Odds not provided; returned the full candidate set by priority"
    };
  }

  if (acceptedTickets.length === 0) {
    const firstPhase = phases[0];
    const firstSyntheticOdds = firstPhase
      ? calculateSyntheticOdds(
          firstPhase.tickets.filter((ticket) => {
            const odds = normalizeOddsValue(oddsMap.get(ticket));
            return odds !== null && odds >= minTicketOdds;
          }),
          oddsMap
        )
      : null;

    return {
      status: "no-match",
      prediction: primaryReason,
      phases: [],
      tickets: [],
      syntheticOdds: maxCombinedOdds !== null ? null : firstSyntheticOdds,
      note: maxCombinedOdds !== null
        ? "指定した合成オッズ帯に収まる買い目なし"
        : "The narrowest ticket set does not satisfy the odds constraints"
    };
  }

  if (maxCombinedOdds !== null && !rangeMatched) {
    return {
      status: "no-match",
      prediction: primaryReason,
      phases: [],
      tickets: [],
      syntheticOdds: null,
      note: "指定した合成オッズ帯に収まる買い目なし"
    };
  }

  return {
    status: "buy",
    prediction: primaryReason,
    phases: acceptedPhases,
    tickets: acceptedTickets,
    syntheticOdds: acceptedSyntheticOdds,
    note: null
  };
}

export function buildDualKaimePlans({
  race,
  oddsByCombination = null,
  minTicketOdds = 0,
  anaMinCombinedOdds = 10,
  honmeiMinCombinedOdds = 3,
  honmeiMaxCombinedOdds = 5
}) {
  return {
    ana: buildKaimePlan({
      race,
      oddsByCombination,
      minCombinedOdds: anaMinCombinedOdds,
      minTicketOdds
    }),
    honmei: buildKaimePlan({
      race,
      oddsByCombination,
      minCombinedOdds: honmeiMinCombinedOdds,
      maxCombinedOdds: honmeiMaxCombinedOdds,
      minTicketOdds
    })
  };
}
