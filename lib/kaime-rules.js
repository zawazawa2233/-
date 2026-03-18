// Rule table for future Discord buy-ticket generation.
// Assumptions applied from the provided notes:
// - "差し / 5頭 / 3着候補(広): 1,2,3,46" is interpreted as [1, 2, 3, 4, 6].
// - Trailing commas are ignored.
// - Missing categories are stored as empty arrays.

export const KAIME_RULES = {
  差し: {
    2: {
      secondMain: [1, 4],
      secondHole: [6],
      secondCover: [],
      thirdNarrow: [1, 4, 6],
      thirdWide: [1, 3, 4, 5, 6]
    },
    3: {
      secondMain: [1, 2],
      secondHole: [],
      secondCover: [],
      thirdNarrow: [1, 2, 4],
      thirdWide: [1, 2, 4, 5, 6]
    },
    4: {
      secondMain: [1, 2],
      secondHole: [],
      secondCover: [],
      thirdNarrow: [1, 2, 5, 6],
      thirdWide: [1, 2, 3, 5, 6]
    },
    5: {
      secondMain: [1, 2],
      secondHole: [],
      secondCover: [],
      thirdNarrow: [1, 2, 6],
      thirdWide: [1, 2, 3, 4, 6]
    },
    6: {
      secondMain: [1, 2],
      secondHole: [],
      secondCover: [],
      thirdNarrow: [1, 2],
      thirdWide: [1, 2, 3, 4, 5]
    }
  },
  捲り: {
    2: {
      secondMain: [3, 4],
      secondHole: [5, 6],
      secondCover: [],
      thirdNarrow: [3, 4, 5],
      thirdWide: [1, 2, 3, 4, 5, 6]
    },
    3: {
      secondMain: [4, 5],
      secondHole: [2],
      secondCover: [],
      thirdNarrow: [2, 4, 5, 6],
      thirdWide: [1, 2, 3, 4, 5, 6]
    },
    4: {
      secondMain: [1, 5],
      secondHole: [3, 6],
      secondCover: [],
      thirdNarrow: [1, 5, 6],
      thirdWide: [1, 2, 3, 5, 6]
    },
    5: {
      secondMain: [1, 2],
      secondHole: [6],
      secondCover: [],
      thirdNarrow: [1, 2, 6],
      thirdWide: [1, 2, 3, 4, 6]
    },
    6: {
      secondMain: [1, 2],
      secondHole: [5],
      secondCover: [],
      thirdNarrow: [1, 2, 4],
      thirdWide: [1, 2, 3, 4, 5, 6]
    }
  },
  捲り差し: {
    3: {
      secondMain: [1],
      secondHole: [2],
      secondCover: [],
      thirdNarrow: [1, 2, 4],
      thirdWide: [1, 2, 3, 4, 5, 6]
    },
    4: {
      secondMain: [1],
      secondHole: [],
      secondCover: [2, 5],
      thirdNarrow: [1, 2, 3],
      thirdWide: [1, 2, 3, 5, 6]
    },
    5: {
      secondMain: [1],
      secondHole: [],
      secondCover: [2],
      thirdNarrow: [1, 2, 6],
      thirdWide: [1, 2, 3, 4, 6]
    },
    6: {
      secondMain: [1],
      secondHole: [],
      secondCover: [2],
      thirdNarrow: [1, 2, 3, 4],
      thirdWide: [1, 2, 3, 4, 5]
    }
  }
};

export function getKaimeRule(kimarite, headBoat) {
  const byKimarite = KAIME_RULES[kimarite];
  if (!byKimarite) {
    return null;
  }

  return byKimarite[headBoat] || null;
}
