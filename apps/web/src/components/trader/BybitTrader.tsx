import TradingPanel from "../TradingPanel";

const InfoBox = () => (
  <div style={{
    background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 4,
    padding: 14, marginBottom: 18, fontFamily: "var(--mono)", fontSize: 11,
    color: "var(--muted)", lineHeight: 1.7,
  }}>
    <strong style={{ color: "var(--text)" }}>Bybit Futures — manuális kereskedés.</strong> Saját
    API kulcsoddal közvetlen order leadás (Market / Limit), balances + nyitott pozíciók
    lekérdezése. Az élesítés előtt mindig <code style={{ color: "var(--accent2)" }}>BYBIT_TESTNET=true</code>{" "}
    env-vel teszteld; az UI piros LIVE / zöld TESTNET tag-et mutat hogy mindig láss melyik módon vagy.
    Ez NEM auto-trader — minden ordert te adsz le, a rendszer csak a kapcsolatot biztosítja.
  </div>
);

export default function BybitTrader() {
  return (
    <TradingPanel
      defaultExchange="bybit"
      lockExchange="bybit"
      title="Bybit Futures"
      subtitle="Manuális order leadás · perpetual futures · v5 API"
      infoBox={<InfoBox />}
    />
  );
}
