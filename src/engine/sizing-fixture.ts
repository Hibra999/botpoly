import {sizingPolicy,type SizingEvidence} from './sizing.js';
/** Synthetic boundary data for deterministic tests only; never used by the running bot. */
export function sizingFixture(now:number):SizingEvidence {
  return {version:sizingPolicy.version,computedAt:now,gammaCount:12,recentGamma:12,returns:60,gammaFrom:now-3300000,gammaTo:now,midpointFrom:now-3600000,midpointTo:now,liquidityP10:1e9,volatilityYesBps:0,volatilityNoBps:0,liquiditySha256:'a'.repeat(64),midpointsSha256:'b'.repeat(64),source:'SYNTHETIC TEST ONLY — no observed profitability'};
}
