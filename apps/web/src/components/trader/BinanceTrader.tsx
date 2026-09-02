import TradingPanel from "../TradingPanel";

const InfoBox = () => (
  <div style={{
    background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 4,
    padding: 14, marginBottom: 18, fontFamily: "var(--mono)", fontSize: 11,
    color: "var(--muted)", lineHeight: 1.7,
  }}>
    <strong style={{ color: "var(--text)" }}>Binance Futures — manuális kereskedés.</strong> Saját
    API kulcsoddal USDM perpetual order leadás (Market / Limit), balances + pozíciók. Élesítés
    előtt <code style={{ color: "var(--accent2)" }}>BINANCE_TESTNET=true</code> kötelező.
    Manuális venue — a rendszer csak az API hívásokat orchestrálja, döntést te hozol.
  </div>
);

export default function BinanceTrader() {
  return (
    <TradingPanel
      defaultExchange="binance"
      lockExchange="binance"
      title="Binance Futures"
      subtitle="Manuális order leadás · USDM perpetual"
      infoBox={<InfoBox />}
    />
  );
}
