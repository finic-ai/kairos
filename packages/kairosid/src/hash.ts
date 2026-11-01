function mix(text: string, seed: number): number {
  let h = seed ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 15;
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// Not Web Crypto: an http page does not have it.
export function hash(text: string): string {
  return [mix(text, 0x2f6b1d3), mix(text, 0x7c159e47)].map((h) => h.toString(16).padStart(8, "0")).join("");
}
