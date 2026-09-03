// services/worker/src/pillars/shared/portfolio-exposure.mts
//
// Cross-bot loader for the crypto-beta exposure cap (B49 #2 / T2). Reads the
// crypto + HL sessions (the two crypto-directional bots) and returns each side's
// committed capital + bankroll, so a runner can enforce the AGGREGATE cap. The
// pure math lives in @core/portfolio-exposure.mts. Funding-arb is intentionally
// excluded (delta-neutral → zero directional beta). Read-only, exception-safe.

import { loadSession } from "../crypto/session-manager.mts";
import { loadHlSession } from "../hyperliquid/session-manager.mts";
import { cryptoExposureUsd, hlExposureUsd } from "@core/portfolio-exposure.mts";

export interface BetaSnapshot {
  crypto: { exposureUsd: number; bankrollUsd: number };
  hl:     { exposureUsd: number; bankrollUsd: number };
}

const CRYPTO_DEFAULT_BANKROLL = 250; // only used if no crypto session exists yet

/**
 * Snapshot the crypto + HL committed capital + bankrolls from persisted state.
 * A runner combines this with its OWN live (in-tick) session for the side it is
 * trading, so intra-tick opens count toward the cap. Never throws.
 */
export async function loadPortfolioBetaSnapshot(paperMode: boolean): Promise<BetaSnapshot> {
  const [c, h] = await Promise.all([
    loadSession(paperMode, CRYPTO_DEFAULT_BANKROLL).catch(() => null),
    loadHlSession(paperMode).catch(() => null),
  ]);
  return {
    crypto: {
      exposureUsd: c ? cryptoExposureUsd((c.openPositions as any) ?? []) : 0,
      bankrollUsd: c?.bankrollCurrent ?? 0,
    },
    hl: {
      exposureUsd: h ? hlExposureUsd((h.openPositions as any) ?? []) : 0,
      bankrollUsd: h?.bankrollCurrent ?? 0,
    },
  };
}
