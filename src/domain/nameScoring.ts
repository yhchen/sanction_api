export interface SearchableNameForScoring {
  normalizedName: string;
  normalizedTokens: string[];
}

export interface NameScore {
  score: number;
  matchReason: string;
}

export const DEFAULT_MIN_FUZZY_SCORE = 0.55;

const LATIN_ALPHA_TOKEN = /^[a-z]+$/u;

export function normalizedTokens(normalizedName: string): string[] {
  return normalizedName.split(' ').filter(Boolean);
}

export function scoreSearchableName(
  normalizedQuery: string,
  queryTokens: string[],
  candidate: SearchableNameForScoring,
  minFuzzyScore = DEFAULT_MIN_FUZZY_SCORE,
): NameScore | undefined {
  if (!candidate.normalizedName) return undefined;
  if (candidate.normalizedName === normalizedQuery) return { score: 1, matchReason: 'exact-name-candidate' };
  if (candidate.normalizedName.includes(normalizedQuery)) {
    const score = 0.95;
    return score < minFuzzyScore ? undefined : { score, matchReason: 'contains-query' };
  }

  const candidateTokens = candidate.normalizedTokens;
  if (queryTokens.length === 0 || candidateTokens.length === 0) return undefined;

  const exactTokenMatches = queryTokens.filter((queryToken) => candidateTokens.includes(queryToken)).length;
  const prefixTokenMatches = queryTokens.filter((queryToken) =>
    candidateTokens.some((candidateToken) => candidateToken.startsWith(queryToken) || queryToken.startsWith(candidateToken)),
  ).length;
  const substringTokenMatches = queryTokens.filter((queryToken) =>
    candidateTokens.some((candidateToken) => candidateToken.includes(queryToken) || queryToken.includes(candidateToken)),
  ).length;
  const typoTokenMatches = queryTokens.filter((queryToken) =>
    !candidateTokens.includes(queryToken) &&
    candidateTokens.some((candidateToken) => isTypoTolerantTokenMatch(queryToken, candidateToken)),
  ).length;

  const tokenCoverage = (exactTokenMatches + typoTokenMatches) / queryTokens.length;
  const prefixCoverage = prefixTokenMatches / queryTokens.length;
  const substringCoverage = substringTokenMatches / queryTokens.length;
  const orderBonus = appearsInOrder(queryTokens, candidateTokens) ? 0.08 : 0;
  const score = Math.min(0.94, tokenCoverage * 0.65 + prefixCoverage * 0.20 + substringCoverage * 0.10 + orderBonus);
  if (score < minFuzzyScore) return undefined;

  const scoreWithoutTypos = Math.min(
    0.94,
    (exactTokenMatches / queryTokens.length) * 0.65 + prefixCoverage * 0.20 + substringCoverage * 0.10 + orderBonus,
  );

  return {
    score,
    matchReason: typoTokenMatches > 0 && scoreWithoutTypos < minFuzzyScore
      ? 'similar-name-typo'
      : exactTokenMatches === queryTokens.length ? 'token-match' : 'similar-name',
  };
}

function isTypoTolerantTokenMatch(queryToken: string, candidateToken: string): boolean {
  if (!allowsTypoTolerance(queryToken) || !allowsTypoTolerance(candidateToken)) return false;
  const maxDistance = Math.min(maxAllowedDistance(queryToken), maxAllowedDistance(candidateToken));
  return damerauLevenshteinDistance(queryToken, candidateToken, maxDistance) <= maxDistance;
}

function allowsTypoTolerance(token: string): boolean {
  return token.length >= 5 && LATIN_ALPHA_TOKEN.test(token);
}

function maxAllowedDistance(token: string): number {
  return token.length >= 8 ? 2 : 1;
}

function appearsInOrder(queryTokens: string[], candidateTokens: string[]): boolean {
  let candidateIndex = 0;
  for (const queryToken of queryTokens) {
    const nextIndex = candidateTokens.findIndex((candidateToken, index) => index >= candidateIndex && candidateToken.includes(queryToken));
    if (nextIndex < 0) return false;
    candidateIndex = nextIndex + 1;
  }
  return true;
}

function damerauLevenshteinDistance(left: string, right: string, maxDistance: number): number {
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;

  const distances: number[][] = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let leftIndex = 0; leftIndex <= left.length; leftIndex += 1) distances[leftIndex]![0] = leftIndex;
  for (let rightIndex = 0; rightIndex <= right.length; rightIndex += 1) distances[0]![rightIndex] = rightIndex;

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let rowMinimum = Number.POSITIVE_INFINITY;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      let distance = Math.min(
        distances[leftIndex - 1]![rightIndex]! + 1,
        distances[leftIndex]![rightIndex - 1]! + 1,
        distances[leftIndex - 1]![rightIndex - 1]! + substitutionCost,
      );

      if (
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        distance = Math.min(distance, distances[leftIndex - 2]![rightIndex - 2]! + 1);
      }

      distances[leftIndex]![rightIndex] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > maxDistance) return maxDistance + 1;
  }

  return distances[left.length]![right.length]!;
}
