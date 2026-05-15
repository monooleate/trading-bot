import { getTelegramConfig } from "./config.mts";
import type { AlertType, Position, ClosedTrade, SessionState } from "./types.mts";

const TG_API = "https://api.telegram.org";

async function sendMessage(text: string): Promise<boolean> {
  const { botToken, chatId } = getTelegramConfig();
  if (!botToken || !chatId) return false;

  try {
    const res = await fetch(`${TG_API}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    console.error("[telegram] Failed to send message");
    return false;
  }
}

// ─── Alert formatters ─────────────────────────────────────

export function alertTradeOpen(
  paper: boolean,
  market: string,
  direction: "YES" | "NO",
  entryPrice: number,
  sizeUSDC: number,
  bankroll: number,
  edge: number,
  kelly: number,
  signals: string,
): Promise<boolean> {
  const pct = ((sizeUSDC / bankroll) * 100).toFixed(1);
  const tag = paper ? "PAPER" : "LIVE";
  const text =
    `🟢 <b>TRADE OPEN [${tag}]</b>\n` +
    `Market: ${market}\n` +
    `Direction: ${direction}\n` +
    `Entry: $${entryPrice.toFixed(2)}\n` +
    `Size: $${sizeUSDC.toFixed(2)} (${pct}% bankroll)\n` +
    `Edge: ${(edge * 100).toFixed(1)}% | Kelly: ${(kelly * 100).toFixed(1)}%\n` +
    `Signals: ${signals}\n` +
    `─────────────────`;
  return sendMessage(text);
}

export function alertTradeClosed(
  paper: boolean,
  trade: ClosedTrade,
  sessionPnL: number,
  openCount: number,
): Promise<boolean> {
  const tag = paper ? "PAPER" : "LIVE";
  const emoji = trade.pnl >= 0 ? "💰" : "🔴";
  const sign = trade.pnl >= 0 ? "+" : "";
  const text =
    `${emoji} <b>TRADE CLOSED [${tag}]</b>\n` +
    `Market: ${trade.market}\n` +
    `Result: ${sign}$${trade.pnl.toFixed(2)} (${sign}${trade.pnlPct.toFixed(1)}%)\n` +
    `Session PnL: ${sign}$${sessionPnL.toFixed(2)}\n` +
    `Open positions: ${openCount}`;
  return sendMessage(text);
}

export function alertSessionStop(
  paper: boolean,
  reason: string,
  session: SessionState,
): Promise<boolean> {
  const tag = paper ? "PAPER" : "LIVE";
  const text =
    `🛑 <b>SESSION STOPPED [${tag}]</b>\n` +
    `Reason: ${reason}\n` +
    `Trades: ${session.tradeCount}\n` +
    `PnL: $${session.sessionPnL.toFixed(2)}\n` +
    `Bankroll: $${session.bankrollCurrent.toFixed(2)}`;
  return sendMessage(text);
}

export function alertError(message: string): Promise<boolean> {
  return sendMessage(`⚠️ <b>ERROR</b>\n${message}`);
}

// Sprint 42B (2026-05-15): audit trail for the `topup` action — non-
// destructive bankroll injection. Sends one Telegram message per topup,
// regardless of paper/live mode, so the operator has a reliable record of
// when the bankroll was grown and by how much.
export function alertTopup(
  paper: boolean,
  category: string,
  amount: number,
  bankrollBefore: number,
  bankrollAfter: number,
  bankrollStartAfter: number,
): Promise<boolean> {
  const tag = paper ? "PAPER" : "LIVE";
  const text =
    `💰 <b>BANKROLL TOPPED UP [${tag}]</b>\n` +
    `Category: ${category}\n` +
    `Added: +$${amount.toFixed(2)}\n` +
    `Bankroll: $${bankrollBefore.toFixed(2)} → $${bankrollAfter.toFixed(2)}\n` +
    `New start basis: $${bankrollStartAfter.toFixed(2)}`;
  return sendMessage(text);
}

export function alertCalibrationNoise(
  paper: boolean,
  message: string,
  tradeCount: number,
  maxAbsIC: number,
): Promise<boolean> {
  const tag = paper ? "PAPER" : "LIVE";
  const text =
    `⚠️ <b>CALIBRATION ALARM [${tag}]</b>\n` +
    `Trades: ${tradeCount}\n` +
    `Max |IC|: ${(maxAbsIC * 100).toFixed(2)}%\n` +
    `${message}\n` +
    (paper
      ? `(paper continues; tune signals or rerun with /auto-trader reset before going live)`
      : `Live trading auto-suspended.`);
  return sendMessage(text);
}

export function alertLiveBlocked(
  category: string,
  reason: string,
  failedGates: string[],
): Promise<boolean> {
  const text =
    `🚦 <b>LIVE TRADING BLOCKED [${category.toUpperCase()}]</b>\n` +
    `${reason}\n` +
    (failedGates.length > 0 ? `Failed gates: ${failedGates.join(", ")}\n` : "") +
    `Run reverted to PAPER for this tick. ` +
    `Reach the thresholds in Settings → Live readiness, then re-enable PAPER_MODE=false.`;
  return sendMessage(text);
}
