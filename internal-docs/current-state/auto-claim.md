# Polymarket Auto-Claim — mit jelent és miért kell

## Mi az "Auto-Claim"?

A Polymarket binary outcome piacai (igen/nem kérdések) lezárása után **a
nyertes oldali tokenek nem konvertálódnak automatikusan USDC-re**. A piac
"resolve" eseménye annyit tesz, hogy az oracle deklarálja a winning
outcome-ot, és a winning side tokeneket **redeem-elhetővé** teszi.
Ehhez egy on-chain `redeemPositions(...)` tranzakciót kell küldeni a
Polygon hálózaton, amit a Polymarket conditional tokens framework
contract értelmez. Cserébe minden 1 winning share-ért $1 USDC-t kapsz.

**Ha nem redeem-eled a pozíciót, soha nem kapod meg a $1-t.** A token
ott marad a wallet-edben "WIN" outcome-ra szólóan, de USDC formában nem
látsz semmit. Ezért kell egy "auto-claim" mechanizmus.

## Példa

- 10 darab YES share-t vettél 0.45 áron egy "Will BTC be above 80k?"
  piacon → $4.50 költség
- A piac lezárul, BTC 85k → YES nyer
- A 10 share most 1 USD/share-t ér, **de ezt kézzel kell redeem-elni**
- Redeem után: $10.00 USDC visszakerül a wallet-edbe (+$5.50 PnL)

## Hogyan működik most az EdgeCalc-ben

A jelenlegi implementáció két részből áll:

1. **Scanner (server-side, Netlify Function)**:
   `polymarket-redeem.mts` `GET ?wallet=0x…` → lekéri a Data API-tól
   (`/positions?user=...&sizeThreshold=0.01`) az adott wallet **összes
   pozícióját**, kiszűri ahol `redeemable === true`, és listázza:
   - Melyik piacon
   - Outcome (YES/NO/győztes/nincs még)
   - Hány share van
   - Becsült claimable USDC (csak a győztes oldal kapja az 1$/share-t)
   - Összesített USDC, amit be lehet gyűjteni egy redeem művelettel

2. **Intent generálás + lokális futtatás**:
   `polymarket-redeem.mts` `POST { wallet, conditionIds }` → egy JSON
   intent-et ad vissza, amelyben a wallet, a redeem-elendő conditionId-k
   és a tx típus van. Ezt a lokális `polymarket_trade.py --redeem-intent`
   parancs olvassa be, aláírja és elküldi a Polygon hálózatra.

A privát kulcs **soha nem kerül szerverre** ebben a flow-ban. A scanner
csak read-only Data API hívás, az on-chain rész a felhasználó gépén megy.

## Hol találod a UI-on

`/trade/polymarket-manual/` → "Manual + Auto-Claim" tab → görgess le a
**Auto-Claim section-ig**:
1. Wallet 0x… cím beírása (localStorage-ben megjegyzi)
2. **🔍 Ellenőriz** → listázza a redeemable pozíciókat + összesített USDC
3. **📋 Intent generálás** → másold a parancsot, futtasd lokálisan

## Miért nem teljesen automata most

Két ok:
1. **Privát kulcs biztonság** — a manuál UI-on (Tab 5) nem akartuk
   szerver oldalra tenni a kulcsot, mert ez egy felhasználói akcióhoz
   kötött flow. Az auto-trader (BTC short markets) viszont env varral
   közvetlenül hív CLOB-ot — ez már egy másik kompromisszum.
2. **Cron nem elég gyakran fut** — a redeem nem időkritikus (a token
   ott marad amíg nem redeem-eled), tehát a kézi flow megfelelő, mert
   a felhasználó tudja mikor zárul a piac.

## Mikor kell külön kelni érte (vagyis: szervert csinálni rá)

Ha:
- Sok piacod van egyszerre lezárva
- Naponta többször ki kell gyűjteni
- Ha nem akarod a saját géped futtatni minden alkalommal
- Ha a Hetzner-re költözés után úgyis ott a privát kulcs (live execution)

Akkor érdemes server-side auto-claim function-t csinálni, ami:
1. Cron 1× naponta lefut
2. Lekéri a redeemable pozíciókat (ugyanaz az UMA scanner)
3. Ha van bármi → on-chain redeem közvetlenül (`POLY_PRIVATE_KEY` env)
4. Telegram alert: "Beclaim-ezve: $X USDC"

Ez ~2 óra fejlesztés és **most is megcsinálható Netlify-on** (nem kell
hozzá Hetzner) — ugyanis az `execution.mts` already kezeli a kulcs-alapú
CLOB hívásokat. Csak egy új `polymarket-redeem-execute.mts` kell, ami a
`viem` walletClient-tel közvetlenül `redeemPositions(...)`-t hív.

## Hetzner roadmap-ben hová kerül

A `internal-docs/roadmap/hetzner-migration.md` Fázis 2 (HL
execution port) után érdemes megcsinálni egy **server-side auto-claim
ütemezett process-t**: PM2 daemon napi 1× scan + redeem + Telegram
report. Postgres-be log: melyik piacot, mikor, mennyiért claim-eltünk.

De ez a **Hetzner-re NEM kötelező feltétel** — Netlify-on is ugyanúgy
megoldható, csak később mehet egy "pillér" PM2 process-be a többi auto-
trader mellé.

## Honnan származik a flow

A `internal-docs/changelog/CHANGELOG-2026-05-08.md` "A.2" szakasz
implementálta. A scanner a Polymarket Data API-t használja
(`https://data-api.polymarket.com/positions`), a redeem on-chain hívás
mintája a `polymarket_trade.py` (Python script) repo-ban van.

## Kapcsolódó fájlok

- `netlify/functions/polymarket-redeem.mts` — scanner + intent generátor
- `src/components/TradingPanel.tsx` `RedeemSection` — UI komponens
- `src/components/trader/PolymarketManualTrader.tsx` — kategória wrapper
  amelyik a `/trade/polymarket-manual/` route-on a Polymarket panelt
  rendereli az infóbox-szal együtt
- `polymarket_trade.py` (root) — lokális futtatható, kulccsal aláíró
  Python script
