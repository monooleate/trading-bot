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
