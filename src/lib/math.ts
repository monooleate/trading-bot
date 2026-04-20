export const calcEV = (tp: number, mp: number) => tp * (1 - mp) - (1 - tp) * mp;

export const calcKelly = (tp: number, mp: number): number => {
  if (mp <= 0 || mp >= 1) return 0;
  const b = 1 / mp - 1;
  return Math.max(0, (tp * b - (1 - tp)) / b);
};

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const rand = (a: number, b: number) => a + Math.random() * (b - a);

export const randNorm = (mu = 0, sigma = 1) => {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
