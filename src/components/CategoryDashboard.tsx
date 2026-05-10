import DashboardShell from "./shared/DashboardShell";
import AuthGate from "./shared/AuthGate";
import CryptoTrader from "./trader/CryptoTrader";
import WeatherTrader from "./trader/WeatherTrader";
import HyperliquidTrader from "./trader/HyperliquidTrader";
import FundingArbPanel from "./trader/FundingArbPanel";
import SportsTrader from "./trader/SportsTrader";
import BybitTrader from "./trader/BybitTrader";
import BinanceTrader from "./trader/BinanceTrader";
import PolymarketManualTrader from "./trader/PolymarketManualTrader";
import EdgeTrackerPanel from "./EdgeTrackerPanel";
import SettingsPanel from "./SettingsPanel";

// Each /trade/<venue>/ page owns its own context (auto-trader UI, edge
// tracker, venue-scoped settings). Diagnostic tools live under /tools.
const CATEGORY_TABS: Record<string, [string, string][]> = {
  crypto: [
    ["autotrader",   "Auto-Trader"],
    ["edge-tracker", "Edge Tracker"],
    ["settings",     "⚙ Beállítások"],
  ],
  weather: [
    ["autotrader",   "Weather Trader"],
    ["edge-tracker", "Edge Tracker"],
    ["settings",     "⚙ Beállítások"],
  ],
  hyperliquid: [
    ["autotrader",   "Perp Trader"],
    ["edge-tracker", "Edge Tracker"],
    ["settings",     "⚙ Beállítások"],
  ],
  "funding-arb": [
    ["autotrader",   "Funding Arb"],
    ["edge-tracker", "Edge Tracker"],
    ["settings",     "⚙ Beállítások"],
  ],
  sports: [
    ["autotrader",   "Sports Bot"],
    ["edge-tracker", "Edge Tracker"],
    ["settings",     "⚙ Beállítások"],
  ],
  bybit: [
    ["trader",       "Manuális Trade"],
    ["settings",     "⚙ Beállítások"],
  ],
  binance: [
    ["trader",       "Manuális Trade"],
    ["settings",     "⚙ Beállítások"],
  ],
  "polymarket-manual": [
    ["trader",       "Manual + Auto-Claim"],
    ["settings",     "⚙ Beállítások"],
  ],
};

function renderCryptoTab(tab: string, bankroll: number) {
  switch (tab) {
    case "autotrader":   return <CryptoTrader bankroll={bankroll} />;
    case "edge-tracker": return <EdgeTrackerPanel defaultCategory="crypto" />;
    case "settings":     return <SettingsPanel category="crypto" title="Crypto Auto-Trader paraméterek" subtitle="BTC short markets · runtime override · Netlify Blobs" />;
    default:             return <CryptoTrader bankroll={bankroll} />;
  }
}

function renderWeatherTab(tab: string, bankroll: number) {
  switch (tab) {
    case "autotrader":   return <WeatherTrader bankroll={bankroll} />;
    case "edge-tracker": return <EdgeTrackerPanel defaultCategory="weather" />;
    case "settings":     return <SettingsPanel category="weather" title="Weather Trader paraméterek" subtitle="Hőmérséklet piacok · GFS ensemble · station fix" />;
    default:             return <WeatherTrader bankroll={bankroll} />;
  }
}

function renderHyperliquidTab(tab: string, bankroll: number) {
  switch (tab) {
    case "autotrader":   return <HyperliquidTrader bankroll={bankroll} />;
    case "edge-tracker": return <EdgeTrackerPanel defaultCategory="hyperliquid" />;
    case "settings":     return <SettingsPanel category="hyperliquid" title="Hyperliquid Perp paraméterek" subtitle="Directional perp execution · paper-only Netlify-on" />;
    default:             return <HyperliquidTrader bankroll={bankroll} />;
  }
}

function renderFundingArbTab(tab: string, bankroll: number) {
  switch (tab) {
    case "autotrader":   return <FundingArbPanel bankroll={bankroll} />;
    case "edge-tracker": return <EdgeTrackerPanel defaultCategory="funding-arb" />;
    case "settings":     return <SettingsPanel category="hyperliquid" title="Funding Arb paraméterek" subtitle="Delta-neutral carry · SHORT HL perp + LONG Binance spot" />;
    default:             return <FundingArbPanel bankroll={bankroll} />;
  }
}

function renderSportsTab(tab: string, bankroll: number) {
  switch (tab) {
    case "autotrader":   return <SportsTrader bankroll={bankroll} />;
    case "edge-tracker": return <EdgeTrackerPanel defaultCategory="sports" />;
    case "settings":     return <SettingsPanel category="sports" title="Sports Bot paraméterek" subtitle="Contrarian fan-bias fade · Polymarket sports markets" />;
    default:             return <SportsTrader bankroll={bankroll} />;
  }
}

function renderBybitTab(tab: string) {
  switch (tab) {
    case "trader":   return <BybitTrader />;
    case "settings": return <SettingsPanel category="bybit" title="Bybit paraméterek" subtitle="Manuális venue · nincs auto-trader" />;
    default:         return <BybitTrader />;
  }
}

function renderBinanceTab(tab: string) {
  switch (tab) {
    case "trader":   return <BinanceTrader />;
    case "settings": return <SettingsPanel category="binance" title="Binance paraméterek" subtitle="Manuális venue · nincs auto-trader" />;
    default:         return <BinanceTrader />;
  }
}

function renderPolymarketManualTab(tab: string) {
  switch (tab) {
    case "trader":   return <PolymarketManualTrader />;
    case "settings": return <SettingsPanel category="polymarket-manual" title="Polymarket Manual paraméterek" subtitle="Read-only piac scan · intent generátor · Auto-Claim" />;
    default:         return <PolymarketManualTrader />;
  }
}

export default function CategoryDashboard({ category }: { category: string }) {
  const tabs = CATEGORY_TABS[category] || CATEGORY_TABS.crypto;

  const render = (tab: string, bankroll: number) => {
    switch (category) {
      case "crypto":             return renderCryptoTab(tab, bankroll);
      case "weather":            return renderWeatherTab(tab, bankroll);
      case "hyperliquid":        return renderHyperliquidTab(tab, bankroll);
      case "funding-arb":        return renderFundingArbTab(tab, bankroll);
      case "sports":             return renderSportsTab(tab, bankroll);
      case "bybit":              return renderBybitTab(tab);
      case "binance":            return renderBinanceTab(tab);
      case "polymarket-manual":  return renderPolymarketManualTab(tab);
      default:                   return renderCryptoTab(tab, bankroll);
    }
  };

  const defaultTab = tabs[0]?.[0] || "trader";
  return (
    <AuthGate
      title={`Bejelentkezés — ${category}`}
      subtitle="Trader vezérléshez (indítás, megállítás, reset, paraméter mentés) belépés kell. Read-only nézet alább."
    >
      <DashboardShell tabs={tabs} defaultTab={defaultTab} category={category}>{(tab, bankroll) => render(tab, bankroll)}</DashboardShell>
    </AuthGate>
  );
}
