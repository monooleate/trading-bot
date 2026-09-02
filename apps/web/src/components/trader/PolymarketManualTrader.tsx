import TradingPanel from "../TradingPanel";

const InfoBox = () => (
  <div style={{
    background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 4,
    padding: 14, marginBottom: 18, fontFamily: "var(--mono)", fontSize: 11,
    color: "var(--muted)", lineHeight: 1.7,
  }}>
    <strong style={{ color: "var(--text)" }}>Polymarket — manuális trade + Auto-Claim.</strong>
    <ul style={{ margin: "8px 0 8px 18px", padding: 0 }}>
      <li><strong style={{ color: "var(--accent2)" }}>Manuális trade:</strong> a top piacok read-only
        listájából választasz, Buy YES / Buy NO + összeg, a rendszer egy <em>intent JSON-t</em>{" "}
        generál. Az ordert a <code style={{ color: "var(--accent2)" }}>polymarket_trade.py</code>{" "}
        script futtatja le LOKÁLISAN — a privát kulcs sosem kerül a szerverre.</li>
      <li style={{ marginTop: 6 }}><strong style={{ color: "var(--accent)" }}>Auto-Claim:</strong> a Polymarket binary
        piacok lezárása után a nyertes pozíciókat <em>kézzel kell redeemelni</em>, különben a $1/share
        nem kerül vissza a wallet egyenlegbe. Itt megnézheted hány USDC begyűjthető (Data API
        scan), és a redeem intent-et szintén lokálisan futtatod le. Ha a auto-trader live mode-ban
        van (<code style={{ color: "var(--accent2)" }}>POLY_PRIVATE_KEY</code> env-ben), akkor
        a redeem-et server-side-ra is portolható egy következő iterációban.</li>
    </ul>
    <em>Az auto-trader (BTC short markets, /trade/crypto/) NEM ezt a flow-t használja —
    az közvetlenül a CLOB-ot hívja a kulccsal env-ből.</em>
  </div>
);

export default function PolymarketManualTrader() {
  return (
    <TradingPanel
      defaultExchange="polymarket"
      lockExchange="polymarket"
      title="Polymarket Manual + Auto-Claim"
      subtitle="Read-only piac lista · Intent generátor · Nyertes pozíció redeem"
      infoBox={<InfoBox />}
    />
  );
}
