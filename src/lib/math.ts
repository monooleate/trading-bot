export const calcEV = (tp: number, mp: number) => tp * (1 - mp) - (1 - tp) * mp;

export const calcKelly = (tp: number, mp: number): number => {
  if (mp <= 0 || mp >= 1) return 0;
  const b = 1 / mp - 1;
  return Math.max(0, (tp * b - (1 - tp)) / b);
};

export interface KellyBinaryOpts {
  fraction?: number;
  hardCapPct?: number;
}

export interface KellyBinaryResult {
  fStar: number;
  size: number;
  capped: boolean;
}

export const kellyBinary = (
  p: number,
  price: number,
  bankroll: number,
  opts: KellyBinaryOpts = {}
): KellyBinaryResult => {
  const fraction = opts.fraction ?? 0.25;
  const hardCapPct = opts.hardCapPct ?? 0.08;
  const safePrice = Math.max(price, 0.01);
  if (safePrice >= 1 || bankroll <= 0) return { fStar: 0, size: 0, capped: false };
  const b = (1 - safePrice) / safePrice;
  const q = 1 - p;
  const fStar = Math.max(0, (p * b - q) / b);
  const raw = fStar * fraction * bankroll;
  const hardCap = hardCapPct * bankroll;
  const size = Math.min(raw, hardCap);
  return { fStar, size, capped: size < raw };
};

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const rand = (a: number, b: number) => a + Math.random() * (b - a);

export const randNorm = (mu = 0, sigma = 1) => {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
