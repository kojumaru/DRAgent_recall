import { toCanvas } from 'html-to-image';
import { jsPDF } from 'jspdf';
import type { NodeType, PdfProductSnapshot } from '../../types';
import { NODE_COLORS } from './FTAFailureNode';

/**
 * 定数
 */

// PDF 枠線・区切り線・凡例縦線（jsPDF は線幅 mm）
const PDF_STROKE = {
  r: 100,
  g: 105,
  b: 115,
  frameLineWidthMm: 0.22,
} as const;

// A4 横のフレーム・各帯の寸法（mm)
const PDF_PAGE_LAYOUT = {
  frameMarginMm: 9, // 用紙端から外枠までの余白
  innerPadMm: 2, // 外枠と中身の隙間
  treeSectionPadMm: 5, // ツリー帯内の上下左右余白
  maxHeaderBandHeightMm: 34, // ヘッダー帯の高さ上限
  minTreeBandHeightMm: 24, // ツリー帯の最小高さ
  minHeaderBandWhenShrunkMm: 18, // ツリー優先で縮めたときのヘッダー下限
} as const;

// ヘッダー／凡例ラスタの論理幅（px）
const PDF_STRIP_CAPTURE = {
  header: {
    contentWidthPx: 1070, // ヘッダー本文の論理幅
    sideBleedPx: 50, // キャプチャ幅拡張と wrap 左右余白
    horizontalPaddingPx: 10, // キャンバス縁から本文までの退避
  },
  legendWidthPx: 480, // 凡例ラスタの論理幅
} as const;

const JP_FONT_STACK =
  '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic UI",Meiryo,sans-serif';

/**
 * ヘルパー関数
 */

function formatJapaneseCreationDate(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatListLine(items: string[], maxList = 14): string {
  if (!items.length) return '—';
  const shown = items.slice(0, maxList);
  const rest = items.length - shown.length;
  return shown.join('、') + (rest > 0 ? ` （他 ${rest} 件）` : '');
}

async function waitForFonts(): Promise<void> {
  if (document.fonts?.ready) {
    await document.fonts.ready.catch(() => {});
  }
}

async function awaitDoubleRaf(): Promise<void> {
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));
}

type RasterStripDims = { width: number; height: number };

/** 帯（bandY〜bandY+bandH）内にラスタを等比で収め、内側 innerPad を除いた領域に中央配置（mm）。 */
function layoutRasterInBand(
  strip: RasterStripDims,
  imgX: number,
  imgW: number,
  bandY: number,
  bandH: number,
  innerPad: number,
  /** imgW 上の自然高さ mm（帯幅計算と一致させるときに渡す） */
  naturalHmmOverride?: number,
): { x: number; y: number; drawW: number; drawH: number } {
  const maxInnerH = bandH - innerPad * 2;
  const naturalH =
    naturalHmmOverride ?? (strip.height / strip.width) * imgW;
  const scale = Math.min(1, maxInnerH / naturalH);
  const drawW = imgW * scale;
  const drawH = naturalH * scale;
  const x = imgX + (imgW - drawW) / 2;
  const y = bandY + innerPad + (maxInnerH - drawH) / 2;
  return { x, y, drawW, drawH };
}

/**
 * 製品情報ブロック（日本語）をブラウザフォントでラスタ化。
 * 画面外配置では toCanvas が真っ白になることがあるため、一時的にビューポート左上に載せる。
 */
async function rasterizePdfHeader(
  product: PdfProductSnapshot | null | undefined,
  pixelRatio = 2,
): Promise<HTMLCanvasElement> {
  const p = product ?? {
    product_name: '',
    purpose: '',
    top_event: '',
    components: [],
    functions: [],
  };

  const titleText = p.product_name.trim() ? `${p.product_name.trim()} FTAツリー` : 'FTAツリー';
  const createdLine = `作成: ${formatJapaneseCreationDate(new Date())}`;
  const componentsLine = `構成部品: ${formatListLine(p.components)}`;
  const functionsLine = `機能: ${formatListLine(p.functions)}`;

  const { header: hcap } = PDF_STRIP_CAPTURE;
  const headerStripWidthPx = hcap.contentWidthPx + hcap.sideBleedPx * 2;
  const bleed = hcap.sideBleedPx;
  const hPad = hcap.horizontalPaddingPx;

  const wrap = document.createElement('div');
  wrap.setAttribute('data-pdf-header-capture', '1');
  wrap.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    `width:${headerStripWidthPx}px`,
    'max-width:none',
    'box-sizing:border-box',
    `padding:8px ${bleed}px 6px ${bleed}px`,
    'margin:0',
    'background:#ffffff',
    'color:#111111',
    `font:13px/1.5 ${JP_FONT_STACK}`,
    'z-index:2147483647',
    'pointer-events:none',
    'overflow:visible',
    '-webkit-font-smoothing:antialiased',
  ].join(';');

  const titleEl = document.createElement('div');
  titleEl.style.cssText =
    'font-weight:700;font-size:18px;margin-bottom:28px;padding:0 12px;text-align:center;color:#111111;letter-spacing:0.02em;width:100%;box-sizing:border-box;';
  titleEl.textContent = titleText;
  wrap.appendChild(titleEl);

  const bottomRow = document.createElement('div');
  bottomRow.style.cssText =
    'display:grid;grid-template-columns:1fr max-content;column-gap:0;align-items:end;width:100%;box-sizing:border-box;';

  const leftCol = document.createElement('div');
  leftCol.style.cssText = `min-width:0;text-align:left;color:#111111;padding:0;margin:0;margin-left:-${bleed - hPad}px;`;
  const line1 = document.createElement('div');
  line1.style.cssText = 'word-break:break-word;margin-bottom:3px;';
  line1.textContent = componentsLine;
  const line2 = document.createElement('div');
  line2.style.cssText = 'word-break:break-word;';
  line2.textContent = functionsLine;
  leftCol.appendChild(line1);
  leftCol.appendChild(line2);

  const rightCol = document.createElement('div');
  rightCol.style.cssText = [
    'justify-self:end',
    'text-align:right',
    'color:#111111',
    'font-size:12px',
    'white-space:nowrap',
    'padding:0',
    'margin:0',
    `margin-right:-${bleed - hPad}px`,
  ].join(';');
  rightCol.textContent = createdLine;

  bottomRow.appendChild(leftCol);
  bottomRow.appendChild(rightCol);
  wrap.appendChild(bottomRow);

  document.body.appendChild(wrap);
  try {
    await waitForFonts();
    await awaitDoubleRaf();

    const capH = Math.ceil(Math.max(wrap.scrollHeight, wrap.getBoundingClientRect().height, 72));
    const canvas = await toCanvas(wrap, {
      pixelRatio,
      backgroundColor: '#ffffff',
      width: headerStripWidthPx,
      height: capH,
    });
    return canvas;
  } finally {
    document.body.removeChild(wrap);
  }
}

const LEGEND_ORDER: { key: NodeType; label: string }[] = [
  { key: 'top', label: 'トップ事象' },
  { key: 'individual', label: '事象' },
  { key: 'basic', label: '基本事象' },
  { key: 'undeveloped', label: '否展開事象' },
];

async function rasterizePdfLegend(pixelRatio = 2): Promise<HTMLCanvasElement> {
  const legendW = PDF_STRIP_CAPTURE.legendWidthPx;
  const wrap = document.createElement('div');
  wrap.setAttribute('data-pdf-legend-capture', '1');
  wrap.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    `width:${legendW}px`,
    'box-sizing:border-box',
    'padding:0',
    'margin:0',
    'background:#ffffff',
    'color:#111111',
    `font:10px/1.45 ${JP_FONT_STACK}`,
    'z-index:2147483647',
    'pointer-events:none',
    '-webkit-font-smoothing:antialiased',
  ].join(';');

  const row = document.createElement('div');
  row.style.cssText =
    'display:flex;flex-direction:row;align-items:stretch;width:100%;min-height:36px;';

  LEGEND_ORDER.forEach(({ key, label }) => {
    const cell = document.createElement('div');
    cell.style.cssText = [
      'flex:1 1 0',
      'display:flex',
      'flex-direction:row',
      'align-items:center',
      'justify-content:center',
      'gap:8px',
      'min-width:0',
      'box-sizing:border-box',
      'padding:5px 4px',
    ].join(';');

    const colors = NODE_COLORS[key];
    const glyphHost = document.createElement('div');
    glyphHost.style.cssText = 'flex-shrink:0;display:flex;align-items:center;justify-content:center;';

    if (key === 'top') {
      const el = document.createElement('div');
      el.style.cssText = `width:30px;height:14px;background:${colors.bg};border:2px solid ${colors.border};box-sizing:border-box;`;
      glyphHost.appendChild(el);
    } else if (key === 'individual') {
      const el = document.createElement('div');
      el.style.cssText = `width:28px;height:14px;background:${colors.bg};border:1.5px solid ${colors.border};box-sizing:border-box;`;
      glyphHost.appendChild(el);
    } else if (key === 'basic') {
      const ow = 28;
      const oh = 14;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', String(ow));
      svg.setAttribute('height', String(oh));
      svg.setAttribute('viewBox', `0 0 ${ow} ${oh}`);
      const ell = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
      ell.setAttribute('cx', String(ow / 2));
      ell.setAttribute('cy', String(oh / 2));
      ell.setAttribute('rx', String(ow / 2 - 1));
      ell.setAttribute('ry', String(oh / 2 - 1));
      ell.setAttribute('fill', colors.bg);
      ell.setAttribute('stroke', colors.border);
      ell.setAttribute('stroke-width', '1');
      svg.appendChild(ell);
      glyphHost.appendChild(svg);
    } else {
      const dw = 20;
      const dh = 14;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', String(dw));
      svg.setAttribute('height', String(dh));
      svg.setAttribute('viewBox', `0 0 ${dw} ${dh}`);
      const pts = `${dw / 2},1 ${dw - 1},${dh / 2} ${dw / 2},${dh - 1} 1,${dh / 2}`;
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', pts);
      poly.setAttribute('fill', colors.bg);
      poly.setAttribute('stroke', colors.border);
      poly.setAttribute('stroke-width', '1');
      poly.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(poly);
      glyphHost.appendChild(svg);
    }

    const lab = document.createElement('span');
    lab.style.cssText = 'font-weight:400;font-size:10px;color:#111;white-space:nowrap;';
    lab.textContent = label;

    cell.appendChild(glyphHost);
    cell.appendChild(lab);
    row.appendChild(cell);
  });

  wrap.appendChild(row);

  document.body.appendChild(wrap);
  try {
    await waitForFonts();
    await awaitDoubleRaf();

    const capH = Math.ceil(Math.max(wrap.scrollHeight, wrap.getBoundingClientRect().height, 36));
    return await toCanvas(wrap, {
      pixelRatio,
      backgroundColor: '#ffffff',
      width: legendW,
      height: capH,
    });
  } finally {
    document.body.removeChild(wrap);
  }
}

/** 白・透明を背景としてキャンバスを矩形トリム（フロー用） */
export function trimCanvas(canvas: HTMLCanvasElement, padding = 16): HTMLCanvasElement {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const d = ctx.getImageData(0, 0, width, height).data;

  let minX = width,
    minY = height,
    maxX = 0,
    maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2],
        a = d[i + 3];
      if (a > 10 && !(r > 245 && g > 245 && b > 245)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX) return canvas;

  const sx = Math.max(0, minX - padding);
  const sy = Math.max(0, minY - padding);
  const sw = Math.min(width - sx, maxX - sx + padding * 2);
  const sh = Math.min(height - sy, maxY - sy + padding * 2);

  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  out.getContext('2d')!.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return out;
}

type ViewportLike = { x: number; y: number; zoom: number };

export interface FtaFlowPdfViewportActions {
  fitView: (options?: { padding?: number; duration?: number }) => void;
  getViewport: () => ViewportLike;
  setViewport: (viewport: ViewportLike, options?: { duration?: number }) => void;
}

function fitRectPreservingAspect(
  contentW: number,
  contentH: number,
  maxW: number,
  maxH: number,
): { w: number; h: number } {
  if (contentW <= 0 || contentH <= 0) return { w: maxW, h: maxH };
  const scale = Math.min(maxW / contentW, maxH / contentH);
  return { w: contentW * scale, h: contentH * scale };
}

/** React Flow をキャプチャして A4 横 PDF を保存 */
export async function exportFtaFlowToPdf(
  rootEl: HTMLElement | null,
  product: PdfProductSnapshot | null | undefined,
  flow: FtaFlowPdfViewportActions,
): Promise<void> {
  if (!rootEl) return;

  const savedViewport = flow.getViewport();
  let trimmed: HTMLCanvasElement | null = null;
  const controls = rootEl.querySelector('.react-flow__controls') as HTMLElement | null;
  const flowBackground = rootEl.querySelector('.react-flow__background') as HTMLElement | null;
  const attribution = rootEl.querySelector('.react-flow__attribution') as HTMLElement | null;
  const prevBgVisibility = flowBackground?.style.visibility ?? '';
  const prevAttrVisibility = attribution?.style.visibility ?? '';

  try {
    flow.fitView({ padding: 0.05, duration: 0 });

    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 100));

    if (controls) controls.style.visibility = 'hidden';
    if (flowBackground) flowBackground.style.visibility = 'hidden';
    if (attribution) attribution.style.visibility = 'hidden';
    try {
      const canvas = await toCanvas(rootEl, {
        pixelRatio: 3,
        backgroundColor: '#ffffff',
      });
      trimmed = trimCanvas(canvas);
    } finally {
      if (controls) controls.style.visibility = '';
      if (flowBackground) flowBackground.style.visibility = prevBgVisibility;
      if (attribution) attribution.style.visibility = prevAttrVisibility;
    }
  } finally {
    flow.setViewport(savedViewport, { duration: 300 });
  }

  if (!trimmed || trimmed.width === 0 || trimmed.height === 0) return;

  const [headerStrip, legendStrip] = await Promise.all([
    rasterizePdfHeader(product),
    rasterizePdfLegend(),
  ]);

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const pl = PDF_PAGE_LAYOUT;
  const frameMargin = pl.frameMarginMm;
  const frameX = frameMargin;
  const frameY = frameMargin;
  const frameW = pageW - frameMargin * 2;
  const frameH = pageH - frameMargin * 2;
  const innerPad = pl.innerPadMm;
  /** Middle band only: breathing room between the flow capture and the section edges (mm). */
  const treeSectionPad = pl.treeSectionPadMm;

  const maxHeaderBandH = pl.maxHeaderBandHeightMm;
  const contentInnerW = frameW - innerPad * 2;

  const headerOk = headerStrip.width > 0 && headerStrip.height > 0;
  let headerNaturalHmm = 0;
  let headerBandH: number = maxHeaderBandH;
  if (headerOk) {
    headerNaturalHmm = (headerStrip.height / headerStrip.width) * contentInnerW;
    headerBandH = Math.min(maxHeaderBandH, headerNaturalHmm + innerPad * 2);
  }

  let treeBandH: number = frameH - headerBandH;
  const minTreeH = pl.minTreeBandHeightMm;
  if (treeBandH < minTreeH) {
    treeBandH = minTreeH;
    headerBandH = Math.max(pl.minHeaderBandWhenShrunkMm, frameH - treeBandH);
  }

  const lineY1 = frameY + headerBandH;

  const imgX = frameX + innerPad;
  const imgW = contentInnerW;

  if (headerOk) {
    const { x: hx, y: hy, drawW: headerDrawW, drawH: headerDrawH } = layoutRasterInBand(
      headerStrip,
      imgX,
      imgW,
      frameY,
      headerBandH,
      innerPad,
      headerNaturalHmm,
    );
    pdf.addImage(headerStrip.toDataURL('image/png'), 'PNG', hx, hy, headerDrawW, headerDrawH);
  }

  let legDrawW = 0;
  let legDrawH = 0;
  if (legendStrip.width > 0 && legendStrip.height > 0) {
    legDrawW = 120;
    legDrawH = (legendStrip.height / legendStrip.width) * legDrawW;
  }

  const treeBandInnerTop = lineY1 + treeSectionPad;
  const treeInnerX = imgX + treeSectionPad;
  const treeMaxW = imgW - treeSectionPad * 2;
  // Reduce available height by legend height so they don't overlap
  const treeMaxH = treeBandH - treeSectionPad * 2 - legDrawH;
  const { w: flowDrawW, h: flowDrawH } = fitRectPreservingAspect(
    trimmed.width,
    trimmed.height,
    treeMaxW,
    treeMaxH,
  );
  const flowX = treeInnerX + (treeMaxW - flowDrawW) / 2;
  const flowY = treeBandInnerTop + (treeMaxH - flowDrawH) / 2;
  pdf.addImage(trimmed.toDataURL('image/png'), 'PNG', flowX, flowY, flowDrawW, flowDrawH);

  if (legDrawW > 0 && legDrawH > 0) {
    const lx = frameX + frameW - legDrawW;
    const ly = frameY + frameH - legDrawH;

    pdf.setFillColor(255, 255, 255);
    pdf.rect(lx, ly, legDrawW, legDrawH, 'F');

    pdf.addImage(legendStrip.toDataURL('image/png'), 'PNG', lx, ly, legDrawW, legDrawH);

    pdf.setDrawColor(PDF_STROKE.r, PDF_STROKE.g, PDF_STROKE.b);
    pdf.setLineWidth(PDF_STROKE.frameLineWidthMm);
    pdf.line(lx, ly, lx + legDrawW, ly);
    pdf.line(lx, ly, lx, ly + legDrawH);

    for (let i = 1; i <= 3; i++) {
      const xSep = lx + (legDrawW * i) / 4;
      pdf.line(xSep, ly, xSep, ly + legDrawH);
    }
  }

  pdf.setDrawColor(PDF_STROKE.r, PDF_STROKE.g, PDF_STROKE.b);
  pdf.setLineWidth(PDF_STROKE.frameLineWidthMm);
  pdf.rect(frameX, frameY, frameW, frameH, 'S');
  pdf.line(frameX, lineY1, frameX + frameW, lineY1);

  const date = new Date().toISOString().slice(0, 10);
  pdf.save(`FTA_report_${date}.pdf`);
}
