export const BRAND_ORANGE = '#d4622a';

export const BRAND_CYAN = '#0891b2';

export interface BrandMark {
  prompt: string;

  cursor: string;
}

export function brandMark(opts?: { ascii?: boolean }): BrandMark {
  if (opts?.ascii) return { prompt: '>', cursor: '#' };
  return { prompt: '❯', cursor: '▪' };
}
