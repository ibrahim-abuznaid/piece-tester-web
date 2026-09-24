import { toPng } from 'html-to-image';
import { CARD_BG } from './palette';

/** Captures the whole card (title, KPIs, both charts, footnote) at 2x and downloads it. */
export async function downloadCardPng(node: HTMLElement, fileName: string): Promise<void> {
  const dataUrl = await toPng(node, { pixelRatio: 2, backgroundColor: CARD_BG, cacheBust: true });
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = fileName;
  link.click();
}
