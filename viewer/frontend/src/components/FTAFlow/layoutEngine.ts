import {
  prepareWithSegments,
  layoutNextLine,
  layout,
  layoutWithLines,
  type LayoutCursor,
  type PreparedTextWithSegments,
  type LayoutLine,
} from '@chenglou/pretext';
import type { NodeType } from '../../types';

const COMPONENT_FONT = '600 10px/14px "Hiragino Sans", "Noto Sans JP", sans-serif';
const TITLE_FONT = '500 12px/17px "Hiragino Sans", "Noto Sans JP", sans-serif';
const DETAIL_FONT = '400 10px/16px "Hiragino Sans", "Noto Sans JP", sans-serif';

const COMPONENT_LINE_HEIGHT = 14;
const TITLE_LINE_HEIGHT = 17;
const DETAIL_LINE_HEIGHT = 16;

const PADDING_X = 20;

/** 矩形・楕円のノード最大幅（探索・折返し上限の基準）。 */
const NODE_MAX_WIDTH = 350;
const DIAMOND_MAX_WIDTH_SCALE = 1.2;

/** 長方形（TOP / 個々の事象）のノード高さ下限。楕円・ひし形はこれにスケールを掛ける。 */
const NODE_MIN_HEIGHT = TITLE_LINE_HEIGHT * 3;
const ELLIPSE_MIN_HEIGHT_SCALE = 1.5;
const DIAMOND_MIN_HEIGHT_SCALE = 2.0;

/** 長方形の事象ノード（TOP / 個々の事象）の上下に足す余白 */
export const INDIVIDUAL_NODE_VERTICAL_PAD = 10;

/** タイトル1行目で詳細トグルを配置するために確保する横幅。 */
export const TITLE_DETAIL_CHEVRON_RESERVE = 20;

/**
 * トグル左の余白に合わせ、タイトル列の右側にも足すバランス用の余白。
 * （折返し幅・スロット検証・1行目コンテナ幅と一致させること）
 */
export const TITLE_DETAIL_TITLE_TRAILING_PAD = 6;

/**
 * レイアウト定数・フォントを変えたときに `FTAFlow` の `useMemo` が再実行されるよう依存に載せる。
 * （モジュールの `CACHE` だけでは React がノードを作り直さないため、定数を弄っても見た目が更新されないことがある。）
 */
export const NODE_LAYOUT_PARAM_FINGERPRINT = [
  PADDING_X,
  NODE_MAX_WIDTH,
  DIAMOND_MAX_WIDTH_SCALE,
  NODE_MIN_HEIGHT,
  DIAMOND_MIN_HEIGHT_SCALE,
  ELLIPSE_MIN_HEIGHT_SCALE,
  INDIVIDUAL_NODE_VERTICAL_PAD,
  COMPONENT_FONT,
  TITLE_FONT,
  DETAIL_FONT,
  TITLE_DETAIL_CHEVRON_RESERVE,
  TITLE_DETAIL_TITLE_TRAILING_PAD,
  'ar:2.5,2,1.5',
].join('|');

export type LayoutLineKind = 'component' | 'title' | 'detail';

export interface LayoutLineData {
  text: string;
  x: number;
  y: number;
  width: number;
  lineHeight: number;
  font: string;
  color: string;
  lineKind: LayoutLineKind;
  /** 詳細トグル付きタイトルの1行目。 */
  leadingDetailToggle?: boolean;
  /** 2行目以降のタイトル。1行目のテキスト開始位置に揃える。 */
  titleDetailCont?: boolean;
}

export interface NodeLayoutResult {
  width: number;
  height: number;
  lines: LayoutLineData[];
}

type ShapeType = 'rectangle' | 'ellipse' | 'diamond';

function getShapeType(nodeType: NodeType): ShapeType {
  if (nodeType === 'basic') return 'ellipse';
  if (nodeType === 'undeveloped') return 'diamond';
  return 'rectangle';
}

function nodeMinHeightForNode(nodeType: NodeType): number {
  const base = NODE_MIN_HEIGHT;
  switch (nodeType) {
    case 'basic':
      return Math.ceil(base * ELLIPSE_MIN_HEIGHT_SCALE);
    case 'undeveloped':
      return Math.ceil(base * DIAMOND_MIN_HEIGHT_SCALE);
    case 'top':
    case 'individual':
      return base;
  }
}

function nodeMaxWidthForShape(shape: ShapeType): number {
  return shape === 'diamond' ? Math.ceil(NODE_MAX_WIDTH * DIAMOND_MAX_WIDTH_SCALE) : NODE_MAX_WIDTH;
}

function getShapeLineSlot(
  shape: ShapeType,
  width: number,
  height: number,
  y: number,
  lineHeight: number,
  paddingX: number,
): { x: number; width: number } | null {
  const cx = width / 2;
  const cy = height / 2;
  const rx = width / 2;
  const ry = height / 2;

  const yTop = y;
  const yBot = y + lineHeight;

  if (yTop < 0 || yBot > height) return null;

  if (shape === 'rectangle') {
    return { x: paddingX, width: width - paddingX * 2 };
  }

  if (shape === 'ellipse') {
    const dyTop = Math.abs(yTop - cy);
    const dyBot = Math.abs(yBot - cy);
    const dyMax = Math.max(dyTop, dyBot);

    if (dyMax >= ry) return null;

    const halfChord = rx * Math.sqrt(1 - (dyMax / ry) ** 2);
    const usableHalfChord = halfChord - paddingX;
    if (usableHalfChord <= 0) return null;

    return {
      x: cx - usableHalfChord,
      width: usableHalfChord * 2,
    };
  }

  if (shape === 'diamond') {
    const dyTop = Math.abs(yTop - cy);
    const dyBot = Math.abs(yBot - cy);
    const dyMax = Math.max(dyTop, dyBot);

    if (dyMax >= ry) return null;

    const halfWidth = rx * (1 - dyMax / ry) - paddingX;
    if (halfWidth <= 0) return null;

    return { x: cx - halfWidth, width: halfWidth * 2 };
  }

  return null;
}

/**
 * 楕円・ひし形: `layoutWithLines` の一定幅 W（二分探索で最大）と各行のスロット内中央寄せ。
 * 矩形の `layoutBlock` が行ごとに変わる弦幅で `layoutNextLine` するのと差し替え用の単一路。
 */
function largestFittingWrapWidthCurved(
  shape: ShapeType,
  width: number,
  height: number,
  bandStartY: number,
  lineHeight: number,
  prepared: PreparedTextWithSegments,
): number {
  const maxSteps = Math.floor((height - bandStartY) / lineHeight) + 24;
  let hi0 = 0;
  for (let i = 0; i < Math.max(1, maxSteps); i++) {
    const yi = bandStartY + i * lineHeight;
    if (yi + lineHeight > height) break;
    const slot = getShapeLineSlot(shape, width, height, yi, lineHeight, PADDING_X);
    if (!slot) break;
    hi0 = Math.max(hi0, slot.width);
  }
  if (hi0 < 20) return -1;

  let lo = 20;
  let hi = Math.min(nodeMaxWidthForShape(shape), Math.floor(hi0));
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const lw = layoutWithLines(prepared, mid, lineHeight).lines;
    if (lw.length === 0) {
      hi = mid - 1;
      continue;
    }
    if (bandStartY + lw.length * lineHeight > height + 0.5) {
      hi = mid - 1;
      continue;
    }
    if (!verifyCurvedLinesInSlots(shape, width, height, bandStartY, lineHeight, lw)) {
      hi = mid - 1;
      continue;
    }
    best = mid;
    lo = mid + 1;
  }
  return best;
}

function verifyCurvedLinesInSlots(
  shape: ShapeType,
  width: number,
  height: number,
  bandStartY: number,
  lineHeight: number,
  lw: LayoutLine[],
): boolean {
  for (let i = 0; i < lw.length; i++) {
    const yi = bandStartY + i * lineHeight;
    if (yi + lineHeight > height + 0.5) return false;
    const slot = getShapeLineSlot(shape, width, height, yi, lineHeight, PADDING_X);
    if (!slot) return false;
    const x = slot.x + (slot.width - lw[i].width) / 2;
    if (lw[i].width > slot.width + 1 || x < slot.x - 1 || x + lw[i].width > slot.x + slot.width + 1) return false;
  }
  return true;
}

/**
 * 部品・詳細なしでタイトルだけの曲線ノード: 先頭 y を上端固定にすると先端の狭い弦だけで折り返されがちなので、
 * 縦位置候補を走査し「弦が使える最大幅・行数・バランス」が最も良い帯の開始 y を選ぶ。
 */
function pickBestCurvedBandStartForPrepared(
  shape: ShapeType,
  width: number,
  height: number,
  prepared: PreparedTextWithSegments,
  lineHeight: number,
): number | null {
  let bestY: number | null = null;
  let bestW = -1;
  let bestN = 1e9;
  let bestScore = -1e18;
  const step = lineHeight;
  for (let tryY = 0; tryY + lineHeight <= height; tryY += step) {
    const Wraw = largestFittingWrapWidthCurved(shape, width, height, tryY, lineHeight, prepared);
    if (Wraw < 20) continue;
    let W = pickBalancedWrapWidth(prepared, Wraw, lineHeight);
    let lw = layoutWithLines(prepared, W, lineHeight).lines;
    if (!verifyCurvedLinesInSlots(shape, width, height, tryY, lineHeight, lw)) {
      W = Wraw;
      lw = layoutWithLines(prepared, W, lineHeight).lines;
      if (!verifyCurvedLinesInSlots(shape, width, height, tryY, lineHeight, lw)) continue;
    }
    const n = lw.length;
    const sc = titleBalanceScore(lw);
    if (W > bestW || (W === bestW && n < bestN) || (W === bestW && n === bestN && sc > bestScore)) {
      bestW = W;
      bestN = n;
      bestScore = sc;
      bestY = tryY;
    }
  }
  return bestY;
}

/** @returns ブロック直後の y、失敗時は null */
function appendCurvedTextBand(
  shape: ShapeType,
  width: number,
  height: number,
  bandStartY: number,
  prepared: PreparedTextWithSegments,
  lineHeight: number,
  font: string,
  color: string,
  lineKind: LayoutLineKind,
  lines: LayoutLineData[],
): number | null {
  const Wraw = largestFittingWrapWidthCurved(shape, width, height, bandStartY, lineHeight, prepared);
  if (Wraw < 20) return null;
  let W = pickBalancedWrapWidth(prepared, Wraw, lineHeight);
  let lw = layoutWithLines(prepared, W, lineHeight).lines;
  if (!verifyCurvedLinesInSlots(shape, width, height, bandStartY, lineHeight, lw)) {
    W = Wraw;
    lw = layoutWithLines(prepared, W, lineHeight).lines;
    if (!verifyCurvedLinesInSlots(shape, width, height, bandStartY, lineHeight, lw)) return null;
  }
  for (let i = 0; i < lw.length; i++) {
    const yi = bandStartY + i * lineHeight;
    const slot = getShapeLineSlot(shape, width, height, yi, lineHeight, PADDING_X);
    if (!slot) return null;
    const x = slot.x + (slot.width - lw[i].width) / 2;
    lines.push({
      text: lw[i].text,
      x,
      y: yi,
      width: lw[i].width,
      lineHeight,
      font,
      color,
      lineKind,
    });
  }
  return bandStartY + lw.length * lineHeight;
}

function lineBottomY(l: LayoutLineData): number {
  return l.y + l.lineHeight;
}

function linesFitShapeAfterShift(
  shape: ShapeType,
  width: number,
  height: number,
  lines: LayoutLineData[],
  dy: number,
): boolean {
  for (const l of lines) {
    const y = l.y + dy;
    const slot = getShapeLineSlot(shape, width, height, y, l.lineHeight, PADDING_X);
    if (!slot) return false;
    if (l.x < slot.x - 1 || l.x + l.width > slot.x + slot.width + 1) return false;
  }
  return true;
}

/** テキストブロックをノード高さ内で縦中央へ平行移動。楕円・ひし形では形状内に収まるよう `dy` をクランプ。 */
function centerLinesVerticallyInNode(shape: ShapeType, result: NodeLayoutResult): NodeLayoutResult {
  if (result.lines.length === 0) return result;

  const minY = Math.min(...result.lines.map((l) => l.y));
  const maxBottom = Math.max(...result.lines.map(lineBottomY));
  const contentH = maxBottom - minY;
  let targetDy = (result.height - contentH) / 2 - minY;
  if (Math.abs(targetDy) < 0.5) return result;

  if (shape === 'rectangle') {
    return {
      ...result,
      lines: result.lines.map((l) => ({ ...l, y: l.y + targetDy })),
    };
  }

  if (linesFitShapeAfterShift(shape, result.width, result.height, result.lines, targetDy)) {
    return {
      ...result,
      lines: result.lines.map((l) => ({ ...l, y: l.y + targetDy })),
    };
  }

  const rounded = Math.round(targetDy);
  if (rounded > 0) {
    for (let dy = rounded; dy >= 0; dy--) {
      if (linesFitShapeAfterShift(shape, result.width, result.height, result.lines, dy)) {
        return {
          ...result,
          lines: result.lines.map((l) => ({ ...l, y: l.y + dy })),
        };
      }
    }
  } else if (rounded < 0) {
    for (let dy = rounded; dy <= 0; dy++) {
      if (linesFitShapeAfterShift(shape, result.width, result.height, result.lines, dy)) {
        return {
          ...result,
          lines: result.lines.map((l) => ({ ...l, y: l.y + dy })),
        };
      }
    }
  }

  return result;
}

function countTitleLines(lines: LayoutLineData[]): number {
  return lines.filter((l) => l.lineKind === 'title').length;
}

function countComponentLines(lines: LayoutLineData[]): number {
  return lines.filter((l) => l.lineKind === 'component').length;
}

/** 最終行が極端に短くならない改行位置を優先する。行数が多いほど最終行の短さに厳しくなる。 */
function titleBalanceScore(layoutLines: LayoutLine[]): number {
  if (layoutLines.length <= 1) return 1e9;
  const lens = layoutLines.map((l) => {
    const t = l.text.replace(/\s+$/u, '');
    return [...t].length;
  });
  const minLen = Math.min(...lens);
  const maxLen = Math.max(...lens);
  const last = lens[lens.length - 1] ?? 0;
  const prevMean = lens.length >= 2 ? lens.slice(0, -1).reduce((a, b) => a + b, 0) / (lens.length - 1) : last;
  let penalty = 0;
  // 最終行がこれ未満なら、1 文字短いごとに同額のペナルティ（線形）。
  const lastLenSoftCap = 6;
  const shortLastPenaltyPerChar = 2400;
  if (last < lastLenSoftCap) {
    penalty -= (lastLenSoftCap - last) * shortLastPenaltyPerChar;
  }
  if (layoutLines.length >= 3 && last <= 5 && last < prevMean * 0.5) {
    penalty -= 7500;
  }
  if (layoutLines.length >= 2 && last <= minLen + 1) {
    penalty -= 3500;
  }
  return minLen * 120 - (maxLen - minLen) * 40 + penalty;
}

/**
 * 最大幅で折り返したとき最終行が短すぎる場合だけ、行数を変えずに幅を少し狭めて改行位置を整える。
 * 曲線帯・矩形タイトル共通。
 */
function pickBalancedWrapWidth(
  prepared: PreparedTextWithSegments,
  Wmax: number,
  lineHeight: number,
): number {
  if (Wmax < 8) return Wmax;
  const linesAtMax = layoutWithLines(prepared, Wmax, lineHeight).lines;
  if (linesAtMax.length <= 1) return Wmax;

  const lastLen = [...linesAtMax[linesAtMax.length - 1].text.replace(/\s+$/u, '')].length;
  if (lastLen >= 6) return Wmax;

  const lineCountAtMax = layout(prepared, Wmax, lineHeight).lineCount;
  let bestW = Wmax;
  let bestScore = titleBalanceScore(linesAtMax);

  const scanDown = Math.min(Wmax - 8, 180);
  for (let d = 1; d < scanDown; d++) {
    const W = Wmax - d;
    if (W < 8) break;
    if (layout(prepared, W, lineHeight).lineCount !== lineCountAtMax) break;
    const { lines } = layoutWithLines(prepared, W, lineHeight);
    const s = titleBalanceScore(lines);
    if (s > bestScore) {
      bestScore = s;
      bestW = W;
    }
  }
  return bestW;
}

function tryLayout(
  shape: ShapeType,
  width: number,
  height: number,
  componentText: PreparedTextWithSegments | null,
  titleText: PreparedTextWithSegments,
  detailText: PreparedTextWithSegments | null,
  hasExpandableDetail: boolean,
  colors: { border: string; text: string; detail: string }
): NodeLayoutResult | null {
  const lines: LayoutLineData[] = [];
  let y = 0;

  const layoutBlock = (
    prepared: PreparedTextWithSegments,
    lineHeight: number,
    font: string,
    color: string,
    align: 'center' | 'left',
    lineKind: LayoutLineKind,
  ): boolean => {
    let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 };
    while (true) {
      const slot = getShapeLineSlot(shape, width, height, y, lineHeight, PADDING_X);
      if (!slot || slot.width < 20) {
        y += lineHeight;
        if (y > height) return false;
        continue;
      }

      const line = layoutNextLine(prepared, cursor, slot.width);
      if (line === null) break;

      let x = slot.x;
      if (align === 'center') {
        x = slot.x + (slot.width - line.width) / 2;
      }

      lines.push({
        text: line.text,
        x,
        y, // 行の上端座標
        width: line.width,
        lineHeight,
        font,
        color,
        lineKind,
      });

      cursor = line.end;
      y += lineHeight;
    }
    return true;
  };

  if (componentText) {
    if (shape === 'rectangle') {
      if (!layoutBlock(componentText, COMPONENT_LINE_HEIGHT, COMPONENT_FONT, colors.border, 'center', 'component'))
        return null;
    } else {
      const bandY = y;
      const nextY = appendCurvedTextBand(
        shape,
        width,
        height,
        bandY,
        componentText,
        COMPONENT_LINE_HEIGHT,
        COMPONENT_FONT,
        colors.border,
        'component',
        lines,
      );
      if (nextY == null) return null;
      y = nextY;
    }
    y += 4; // ブロック間隔
  }

  // 詳細トグル付きタイトルは「中央寄せのブロック内で左揃え」にする。
  if (hasExpandableDetail) {
    let titleStartY = y;
    if (shape !== 'rectangle') {
      const needSlotW = TITLE_DETAIL_CHEVRON_RESERVE + TITLE_DETAIL_TITLE_TRAILING_PAD + 40;
      while (titleStartY + TITLE_LINE_HEIGHT <= height) {
        const probe = getShapeLineSlot(
          shape,
          width,
          height,
          titleStartY,
          TITLE_LINE_HEIGHT,
          PADDING_X,
        );
        if (probe && probe.width >= needSlotW) break;
        titleStartY += TITLE_LINE_HEIGHT;
      }
      if (titleStartY + TITLE_LINE_HEIGHT > height) return null;
    }
    const slot0 = getShapeLineSlot(
      shape,
      width,
      height,
      titleStartY,
      TITLE_LINE_HEIGHT,
      PADDING_X,
    );
    if (!slot0 || slot0.width < TITLE_DETAIL_CHEVRON_RESERVE + TITLE_DETAIL_TITLE_TRAILING_PAD + 16)
      return null;

    const Wmax = slot0.width - TITLE_DETAIL_CHEVRON_RESERVE - TITLE_DETAIL_TITLE_TRAILING_PAD;
    let W = pickBalancedWrapWidth(titleText, Wmax, TITLE_LINE_HEIGHT);

    let fitted = false;
    for (let iter = 0; iter < 240; iter++) {
      const { lines: lw } = layoutWithLines(titleText, W, TITLE_LINE_HEIGHT);
      const textColW = lw.length ? Math.max(...lw.map((l) => l.width)) : 0;
      const blockW = TITLE_DETAIL_CHEVRON_RESERVE + textColW + TITLE_DETAIL_TITLE_TRAILING_PAD;
      const blockLeft = slot0.x + (slot0.width - blockW) / 2;
      const textX = blockLeft + TITLE_DETAIL_CHEVRON_RESERVE;

      let ok = true;
      if (blockLeft < slot0.x - 0.5 || blockLeft + blockW > slot0.x + slot0.width + 0.5) ok = false;

      for (let i = 0; i < lw.length && ok; i++) {
        const yi = titleStartY + i * TITLE_LINE_HEIGHT;
        const slot = getShapeLineSlot(shape, width, height, yi, TITLE_LINE_HEIGHT, PADDING_X);
        if (!slot) {
          ok = false;
          break;
        }
        if (textX + lw[i].width > slot.x + slot.width + 1) ok = false;
        if (textX + textColW + TITLE_DETAIL_TITLE_TRAILING_PAD > slot.x + slot.width + 1) ok = false;
        if (textX < slot.x - 1) ok = false;
      }

      if (ok) {
        fitted = true;
        break;
      }
      W -= 1;
      if (W < 8) return null;
    }

    if (!fitted) return null;

    const finalLines = layoutWithLines(titleText, W, TITLE_LINE_HEIGHT).lines;
    if (finalLines.length === 0) return null;

    const textColW = Math.max(...finalLines.map((l) => l.width), 0);
    const blockW = TITLE_DETAIL_CHEVRON_RESERVE + textColW + TITLE_DETAIL_TITLE_TRAILING_PAD;
    const blockLeft = slot0.x + (slot0.width - blockW) / 2;
    const textX = blockLeft + TITLE_DETAIL_CHEVRON_RESERVE;

    for (let i = 0; i < finalLines.length; i++) {
      lines.push({
        text: finalLines[i].text,
        x: textX,
        y: titleStartY + i * TITLE_LINE_HEIGHT,
        width: finalLines[i].width,
        lineHeight: TITLE_LINE_HEIGHT,
        font: TITLE_FONT,
        color: colors.text,
        lineKind: 'title',
        leadingDetailToggle: i === 0,
        titleDetailCont: i > 0,
      });
    }

    y = titleStartY + finalLines.length * TITLE_LINE_HEIGHT;
  } else if (shape === 'rectangle') {
    if (!layoutBlock(titleText, TITLE_LINE_HEIGHT, TITLE_FONT, colors.text, 'center', 'title')) return null;
  } else {
    const bandY =
      !componentText && !detailText
        ? pickBestCurvedBandStartForPrepared(
            shape,
            width,
            height,
            titleText,
            TITLE_LINE_HEIGHT,
          ) ?? y
        : y;
    const nextY = appendCurvedTextBand(
      shape,
      width,
      height,
      bandY,
      titleText,
      TITLE_LINE_HEIGHT,
      TITLE_FONT,
      colors.text,
      'title',
      lines,
    );
    if (nextY == null) return null;
    y = nextY;
  }

  if (detailText) {
    y += 6; // ブロック間隔
    if (shape === 'rectangle') {
      if (!layoutBlock(detailText, DETAIL_LINE_HEIGHT, DETAIL_FONT, colors.detail, 'left', 'detail')) return null;
    } else {
      const bandY = y;
      const nextY = appendCurvedTextBand(
        shape,
        width,
        height,
        bandY,
        detailText,
        DETAIL_LINE_HEIGHT,
        DETAIL_FONT,
        colors.detail,
        'detail',
        lines,
      );
      if (nextY == null) return null;
      y = nextY;
    }
  }

  return { width, height, lines };
}

/**
 * ノード幅の探索: レイアウト可能な最小幅 `wMin` と参照上端 `wTop`（`nodeMaxWidthForShape`）の間で、
 * `tryLayout` → `tightenHeightForWidth` 後の行数の最小値を求め、その行数を維持できる最小幅を二分探索する。
 * 改行数を抑える方向にスコアを寄せる。上端幅は `nodeMaxWidthForShape(shape)`。
 */
function binarySearchMinimalWidth(
  shape: ShapeType,
  aspectRatio: number,
  componentPrep: PreparedTextWithSegments | null,
  titlePrep: PreparedTextWithSegments,
  detailPrep: PreparedTextWithSegments | null,
  hasExpandableDetail: boolean,
  colors: { border: string; text: string; detail: string },
): NodeLayoutResult | null {
  const layoutTightenedAt = (w: number): NodeLayoutResult | null => {
    const h = w / aspectRatio;
    const raw = tryLayout(shape, w, h, componentPrep, titlePrep, detailPrep, hasExpandableDetail, colors);
    if (!raw) return null;
    return tightenHeightForWidth(
      shape,
      w,
      componentPrep,
      titlePrep,
      detailPrep,
      hasExpandableDetail,
      colors,
      raw,
    );
  };

  const wMax = nodeMaxWidthForShape(shape);
  let lo = 50;
  let hi = wMax;
  let wMin = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const h = mid / aspectRatio;
    if (tryLayout(shape, mid, h, componentPrep, titlePrep, detailPrep, hasExpandableDetail, colors)) {
      wMin = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (wMin < 0) return null;

  let wTop = wMax;
  while (wTop > wMin && !tryLayout(shape, wTop, wTop / aspectRatio, componentPrep, titlePrep, detailPrep, hasExpandableDetail, colors)) {
    wTop--;
  }

  let minLines = Infinity;
  for (let w = wMin; w <= wTop; w++) {
    const r = layoutTightenedAt(w);
    if (r) minLines = Math.min(minLines, r.lines.length);
  }

  lo = wMin;
  hi = wTop;
  let ans = wTop;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = layoutTightenedAt(mid);
    if (!r) {
      lo = mid + 1;
      continue;
    }
    if (r.lines.length <= minLines) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return layoutTightenedAt(ans);
}

/** 固定幅に対して、描画可能な最小高さを二分探索で求める。 */
function findMinHeightAtWidth(
  shape: ShapeType,
  width: number,
  componentPrep: PreparedTextWithSegments | null,
  titlePrep: PreparedTextWithSegments,
  detailPrep: PreparedTextWithSegments | null,
  hasExpandableDetail: boolean,
  colors: { border: string; text: string; detail: string },
  hMax = 1400,
): NodeLayoutResult | null {
  let lo = 24;
  let hi = hMax;
  let bestResult: NodeLayoutResult | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = tryLayout(shape, width, mid, componentPrep, titlePrep, detailPrep, hasExpandableDetail, colors);
    if (r) {
      bestResult = r;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return bestResult;
}

/** 幅探索後に高さだけ再探索し、余分な縦余白を削る。 */
function tightenHeightForWidth(
  shape: ShapeType,
  width: number,
  componentPrep: PreparedTextWithSegments | null,
  titlePrep: PreparedTextWithSegments,
  detailPrep: PreparedTextWithSegments | null,
  hasExpandableDetail: boolean,
  colors: { border: string; text: string; detail: string },
  prior: NodeLayoutResult,
): NodeLayoutResult {
  const t = findMinHeightAtWidth(
    shape,
    width,
    componentPrep,
    titlePrep,
    detailPrep,
    hasExpandableDetail,
    colors,
  );
  return t ?? prior;
}

function ensureMinimumHeight(
  nodeType: NodeType,
  shape: ShapeType,
  result: NodeLayoutResult,
  componentPrep: PreparedTextWithSegments | null,
  titlePrep: PreparedTextWithSegments,
  detailPrep: PreparedTextWithSegments | null,
  hasExpandableDetail: boolean,
  colors: { border: string; text: string; detail: string },
): NodeLayoutResult {
  const minH = nodeMinHeightForNode(nodeType);
  if (result.height >= minH) return result;

  return (
    tryLayout(
      shape,
      result.width,
      minH,
      componentPrep,
      titlePrep,
      detailPrep,
      hasExpandableDetail,
      colors,
    ) ?? { ...result, height: minH }
  );
}

/** 詳細を閉じた状態での「部品行/タイトル行」の行数を返す。 */
function componentTitleLineCountsWhenClosed(
  shape: ShapeType,
  width: number,
  componentPrep: PreparedTextWithSegments | null,
  titlePrep: PreparedTextWithSegments,
  hasExpandableDetail: boolean,
  colors: { border: string; text: string; detail: string },
): { component: number; title: number } | null {
  const lay = findMinHeightAtWidth(
    shape,
    width,
    componentPrep,
    titlePrep,
    null,
    hasExpandableDetail,
    colors,
  );
  if (!lay) return null;
  return {
    component: countComponentLines(lay.lines),
    title: countTitleLines(lay.lines),
  };
}

const CLOSED_WIDTH_SEARCH_LO = 50;

/**
 * 詳細を開いたときの行数を上限として、閉状態で必要な最小幅を粗く求める。
 * 1px 単位の詰めは行わず、トグル時に再折返しが起きない幅を優先する。
 */
function findClosedWidthForOpenLineCounts(
  shape: ShapeType,
  componentPrep: PreparedTextWithSegments | null,
  titlePrep: PreparedTextWithSegments,
  hasExpandableDetail: boolean,
  colors: { border: string; text: string; detail: string },
  targetComponent: number,
  targetTitle: number,
): number | null {
  let lo = CLOSED_WIDTH_SEARCH_LO;
  let hi = nodeMaxWidthForShape(shape);
  let candidate: number | null = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const counts = componentTitleLineCountsWhenClosed(
      shape,
      mid,
      componentPrep,
      titlePrep,
      hasExpandableDetail,
      colors,
    );
    if (counts == null) {
      lo = mid + 1;
      continue;
    }
    const fits = counts.component <= targetComponent && counts.title <= targetTitle;
    if (!fits) {
      lo = mid + 1;
    } else {
      candidate = mid;
      hi = mid - 1;
    }
  }

  return candidate;
}

/**
 * 詳細閉じ: `findClosedWidthForOpenLineCounts` → `findMinHeightAtWidth` だけだと、
 * 曲線ノードで幅が極端に狭いとき `ry` が小さく弦が足りず高さだけ膨らむ。
 * 幅を広げて `max(nodeMinHeight, w/aspectRatio)` 以下に収まる最小幅を二分探索する。
 */
function widenClosedCurvedNodeToHeightBudget(
  nodeType: NodeType,
  shape: ShapeType,
  wStart: number,
  aspectRatio: number,
  componentPrep: PreparedTextWithSegments | null,
  titlePrep: PreparedTextWithSegments,
  hasExpandableDetail: boolean,
  colors: { border: string; text: string; detail: string },
  current: NodeLayoutResult | null,
): NodeLayoutResult | null {
  if (!current || (shape !== 'ellipse' && shape !== 'diamond')) return current;

  const w0 = Math.max(CLOSED_WIDTH_SEARCH_LO, Math.ceil(wStart));
  const heightBudget = (w: number) => Math.max(nodeMinHeightForNode(nodeType), w / aspectRatio);

  if (current.height <= heightBudget(w0) + 0.5) return current;

  const wMax = nodeMaxWidthForShape(shape);
  let lo = w0;
  let hi = wMax;
  let bestLay: NodeLayoutResult | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const lay = findMinHeightAtWidth(
      shape,
      mid,
      componentPrep,
      titlePrep,
      null,
      hasExpandableDetail,
      colors,
    );
    if (!lay) {
      lo = mid + 1;
      continue;
    }
    if (lay.height <= heightBudget(mid) + 0.5) {
      bestLay = lay;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return bestLay ?? current;
}

const CACHE = new Map<string, NodeLayoutResult>();

export function computeNodeLayout(
  nodeId: string,
  nodeType: NodeType,
  componentLine: string | null,
  titleLine: string,
  detailBody: string | null,
  isDetailExpanded: boolean,
  hasExpandableDetail: boolean,
  colors: { border: string; text: string; detail: string }
): NodeLayoutResult {
  const cacheKey = `${nodeId}-${nodeType}-${componentLine}-${titleLine}-${hasExpandableDetail}-${isDetailExpanded ? detailBody : ''}`;
  const cached = CACHE.get(cacheKey);
  if (cached) return cached;

  const shape = getShapeType(nodeType);

  const componentPrep = componentLine ? prepareWithSegments(componentLine, COMPONENT_FONT) : null;
  const titlePrep = prepareWithSegments(titleLine, TITLE_FONT);
  const detailPrepFull = detailBody ? prepareWithSegments(detailBody, DETAIL_FONT) : null;

  const aspectRatio = shape === 'rectangle' ? 2.5 : shape === 'ellipse' ? 2 : 1.5;

  const detailPrepForLayout: PreparedTextWithSegments | null =
    isDetailExpanded ? detailPrepFull : null;

  let bestResult: NodeLayoutResult | null = null;

  // 詳細あり: 開状態は通常の最小サイズ探索、閉状態は行数維持を優先した幅探索を行う。
  if (hasExpandableDetail && detailPrepFull) {
    const openSizing = binarySearchMinimalWidth(
      shape,
      aspectRatio,
      componentPrep,
      titlePrep,
      detailPrepFull,
      hasExpandableDetail,
      colors,
    );
    const openLayoutBase = openSizing ?? null;

    const targetComponentLines = openLayoutBase ? countComponentLines(openLayoutBase.lines) : 0;
    const targetTitleLines = Math.max(1, openLayoutBase ? countTitleLines(openLayoutBase.lines) : 1);

    if (isDetailExpanded) {
      bestResult = openLayoutBase ?? openSizing ?? null;
    } else {
      const wClosed =
        findClosedWidthForOpenLineCounts(
          shape,
          componentPrep,
          titlePrep,
          hasExpandableDetail,
          colors,
          targetComponentLines,
          targetTitleLines,
        ) ?? openLayoutBase?.width ?? openSizing?.width ?? null;

      const wUse = wClosed ?? openSizing?.width ?? 200;
      bestResult =
        findMinHeightAtWidth(
          shape,
          wUse,
          componentPrep,
          titlePrep,
          null,
          hasExpandableDetail,
          colors,
        ) ??
        (openSizing
          ? tryLayout(
              shape,
              wUse,
              openSizing.height,
              componentPrep,
              titlePrep,
              null,
              hasExpandableDetail,
              colors,
            )
          : null);
      bestResult = widenClosedCurvedNodeToHeightBudget(
        nodeType,
        shape,
        wUse,
        aspectRatio,
        componentPrep,
        titlePrep,
        hasExpandableDetail,
        colors,
        bestResult,
      );
    }
  } else {
    bestResult = binarySearchMinimalWidth(
      shape,
      aspectRatio,
      componentPrep,
      titlePrep,
      detailPrepForLayout,
      hasExpandableDetail,
      colors,
    );
  }

  if (!bestResult) {
    const wLast = nodeMaxWidthForShape(shape);
    const hLast = wLast / aspectRatio;
    bestResult =
      tryLayout(
        shape,
        wLast,
        hLast,
        componentPrep,
        titlePrep,
        detailPrepForLayout,
        hasExpandableDetail,
        colors,
      ) ?? { width: 200, height: nodeMinHeightForNode(nodeType), lines: [] };
  }

  bestResult = ensureMinimumHeight(
    nodeType,
    shape,
    bestResult,
    componentPrep,
    titlePrep,
    detailPrepForLayout,
    hasExpandableDetail,
    colors,
  );

  if (shape === 'diamond' && bestResult.lines.length > 0) {
    const w0 = bestResult.width;
    const w1 = Math.ceil(w0 * DIAMOND_MAX_WIDTH_SCALE);
    if (w1 > w0) {
      const relaid = findMinHeightAtWidth(
        shape,
        w1,
        componentPrep,
        titlePrep,
        detailPrepForLayout,
        hasExpandableDetail,
        colors,
      );
      if (relaid) {
        bestResult = ensureMinimumHeight(
          nodeType,
          shape,
          relaid,
          componentPrep,
          titlePrep,
          detailPrepForLayout,
          hasExpandableDetail,
          colors,
        );
      }
    }
  }

  bestResult = centerLinesVerticallyInNode(shape, bestResult);

  bestResult.width = Math.ceil(bestResult.width);
  bestResult.height = Math.ceil(bestResult.height);

  if (nodeType === 'individual' || nodeType === 'top') {
    const p = INDIVIDUAL_NODE_VERTICAL_PAD;
    bestResult = {
      ...bestResult,
      height: bestResult.height + 2 * p,
      lines: bestResult.lines.map((l) => ({ ...l, y: l.y + p })),
    };
  }

  CACHE.set(cacheKey, bestResult);
  return bestResult;
}
