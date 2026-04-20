import DashboardShell from "./shared/DashboardShell";
import CryptoTrader from "./trader/CryptoTrader";
import WeatherTrader from "./trader/WeatherTrader";
import HyperliquidTrader from "./trader/HyperliquidTrader";
import FundingArbPanel from "./trader/FundingArbPanel";
import EdgeTrackerPanel from "./EdgeTrackerPanel";

// Only trading-essential tabs per category.
// Diagnostic / analytical tools are available under /tools.
const CATEGORY_TABS: Record<string, [string, string][]> = {
  crypto: [
    ["autotrader",   "Auto-Trader"],
    ["edge-tracker", "Edge Tracker"],
  ],
  weather: [
    ["autotrader",   "Weather Trader"],
    ["edge-tracker", "Edge Tracker"],
  ],
  hyperliquid: [
    ["autotrader",   "Perp Trader"],
    ["funding-arb",  "Funding Arb"],
  ],
};

function renderCryptoTab(tab: string, _bankroll: number) {
  switch (tab) {
    case "autotrader":    return <CryptoTrader />;
    case "edge-tracker":  return <EdgeTrackerPanel defaultCategory="crypto" />;
    default:              return <CryptoTrader />;
  }
}

function renderWeatherTab(tab: string, _bankroll: number) {
  switch (tab) {
    case "autotrader":    return <WeatherTrader />;
    case "edge-tracker":  return <EdgeTrackerPanel defaultCategory="weather" />;
    default:              return <WeatherTrader />;
  }
}

function renderHyperliquidTab(tab: string, _bankroll: number) {
  switch (tab) {
    case "autotrader":    return <HyperliquidTrader />;
    case "funding-arb":   return <FundingArbPanel />;
    default:              return <HyperliquidTrader />;
  }
}

export default function CategoryDashboard({ category }: { category: string }) {
  const tabs = CATEGORY_TABS[category] || CATEGORY_TABS.crypto;

  const render = (tab: string, bankroll: number) => {
    switch (category) {
      case "crypto":      return renderCryptoTab(tab, bankroll);
      case "weather":     return renderWeatherTab(tab, bankroll);
      case "hyperliquid": return renderHyperliquidTab(tab, bankroll);
      default:            return renderCryptoTab(tab, bankroll);
    }
  };

  return <DashboardShell tabs={tabs} defaultTab="autotrader">{render}</DashboardShell>;
}
