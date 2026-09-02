// src/components/shared/ToolInfoBox.tsx
// Egységes "Mi ez az eszköz / hogyan kell használni" info-doboz a Tools dashboard
// minden tabján. Egy helyen tartja a leírásokat, hogy ne kerüljön szét a 9 panel
// közé. A "marketScope" mező jelöli, melyik Polymarket piacokat hívja a tool —
// így a felhasználó látja, mely market-ekkel dolgozik.

import type { ReactNode } from "react";

export interface ToolInfoBoxProps {
  /** Rövid title, pl. "Polymarket Scanner". */
  title: string;
  /** 1-2 mondatos magyarázat, mit csinál a tool. */
  what: ReactNode;
  /** Lépésről lépésre, hogyan kell használni. Egy lépés = egy bejegyzés. */
  howToUse: ReactNode[];
  /** A Polymarket piac(ok), amit a tool ténylegesen hív. */
  marketScope: ReactNode;
  /** Opcionális: melyik bot kapcsolódik (ha van) — link a /trade/<cat>/-re. */
  relatedBot?: { label: string; href: string };
  /** Opcionális: háttér API endpoint (debug / transparency). */
  endpoint?: string;
}

const css = `
.tib-wrap{
  background:linear-gradient(180deg,#0c1410 0%,var(--surface) 100%);
  border:1px solid var(--border);
  border-left:3px solid var(--accent);
  border-radius:4px;
  padding:14px 16px;
  margin-bottom:16px;
  font-family:var(--mono);
}
.tib-title{
  font-family:var(--sans);font-size:13px;font-weight:800;
  color:var(--accent);letter-spacing:.02em;margin:0 0 4px 0;
  display:flex;align-items:center;gap:8px;
}
.tib-title::before{
  content:"ℹ";
  display:inline-flex;align-items:center;justify-content:center;
  width:18px;height:18px;border-radius:50%;
  background:#0f1f00;border:1px solid var(--accent);
  color:var(--accent);font-size:10px;font-weight:700;
}
.tib-what{
  font-size:11px;color:var(--text);line-height:1.6;margin-bottom:10px;
}
.tib-section{margin-top:8px}
.tib-section-lbl{
  font-size:9px;color:var(--muted);text-transform:uppercase;
  letter-spacing:.12em;margin-bottom:4px;
}
.tib-steps{
  margin:0;padding-left:18px;font-size:10.5px;color:var(--muted);
  line-height:1.7;
}
.tib-steps li{margin-bottom:2px}
.tib-steps li strong{color:var(--text)}
.tib-scope{
  font-size:10.5px;color:var(--accent2);line-height:1.6;
  background:var(--surface2);border:1px dashed var(--border);
  border-radius:2px;padding:6px 9px;
}
.tib-meta{
  display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;
  font-size:9.5px;color:var(--muted);
}
.tib-meta a{
  color:var(--accent);text-decoration:none;
  border-bottom:1px dashed var(--accent);
}
.tib-meta a:hover{color:var(--accent2);border-bottom-color:var(--accent2)}
.tib-meta code{
  color:var(--accent2);background:#0a0a0c;
  border:1px solid var(--border);border-radius:2px;
  padding:1px 6px;font-size:9.5px;
}
`;

export default function ToolInfoBox(props: ToolInfoBoxProps) {
  return (
    <>
      <style>{css}</style>
      <section className="tib-wrap">
        <h2 className="tib-title">{props.title}</h2>
        <div className="tib-what">{props.what}</div>

        <div className="tib-section">
          <div className="tib-section-lbl">Hogyan kell használni</div>
          <ol className="tib-steps">
            {props.howToUse.map((step, i) => <li key={i}>{step}</li>)}
          </ol>
        </div>

        <div className="tib-section">
          <div className="tib-section-lbl">Polymarket piac(ok)</div>
          <div className="tib-scope">{props.marketScope}</div>
        </div>

        {(props.relatedBot || props.endpoint) && (
          <div className="tib-meta">
            {props.relatedBot && (
              <span>
                Bot párja: <a href={props.relatedBot.href}>{props.relatedBot.label}</a>
              </span>
            )}
            {props.endpoint && <span>API: <code>{props.endpoint}</code></span>}
          </div>
        )}
      </section>
    </>
  );
}
