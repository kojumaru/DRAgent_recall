/** 文字列 `s` の先頭から `[内側]` 形式のセグメントを取り出す。 */
export function extractLeadingBracketGroups(s: string): { parts: string[]; rest: string } {
  const parts: string[] = [];
  let t = s.trimStart();
  const re = /^\[([^\]]*)\]\s*/;
  for (;;) {
    const m = t.match(re);
    if (!m) break;
    parts.push(m[1].trim());
    t = t.slice(m[0].length);
  }
  return { parts, rest: t.trim() };
}

function stripOuterBracketsLabel(raw: string): string {
  const { parts, rest } = extractLeadingBracketGroups(raw);
  if (parts.length >= 2 && rest === '') {
    return parts[parts.length - 1] ?? raw;
  }
  if (parts.length === 1 && rest === '') {
    return parts[0] ?? raw;
  }
  if (parts.length >= 2) {
    return `${parts[parts.length - 1]}${rest ? ` ${rest}` : ''}`.trim();
  }
  return raw.trim();
}

export interface FtaDisplayFields {
  label: string;
  label_detail: string | null;
  component: string | null;
}

export interface FtaDisplayNormalized {
  /** 非 null のとき、小さな色付き行として表示する部品名など */
  componentLine: string | null;
  /** メインの故障・事象タイトル（構造化 LLM 出力の生の `[]` を除いた文言） */
  titleLine: string;
  /** 折りたたみブロック内に表示する詳細本文 */
  detailBody: string | null;
  hasExpandableDetail: boolean;
}

/**
 * `label` / `label_detail` に `[部品][不具合モード]` のような記法が残っている
 * LLM 出力を、整ったタイトルと任意の詳細テキストへ正規化する。
 */
export function normalizeFtaNodeDisplay(data: FtaDisplayFields): FtaDisplayNormalized {
  const rawLabel = data.label.trim();
  const rawDetail = (data.label_detail ?? '').trim();
  const rawComp = data.component?.trim() || null;

  const lp = extractLeadingBracketGroups(rawLabel);
  const dp = extractLeadingBracketGroups(rawDetail);

  let titleLine = rawLabel;
  let implicitComp: string | null = null;

  if (lp.parts.length >= 2 && lp.rest === '') {
    implicitComp = lp.parts[0] ?? null;
    titleLine = lp.parts[lp.parts.length - 1] ?? rawLabel;
  } else if (lp.parts.length >= 2) {
    implicitComp = lp.parts[0] ?? null;
    titleLine = `${lp.parts[lp.parts.length - 1] ?? ''}${lp.rest ? ` ${lp.rest}` : ''}`.trim();
  } else if (lp.parts.length === 1 && lp.rest === '') {
    titleLine = lp.parts[0] ?? rawLabel;
  }

  let detailBody: string | null = null;

  if (rawDetail) {
    if (dp.parts.length >= 2) {
      const p0 = dp.parts[0] ?? '';
      const p1 = dp.parts[1] ?? '';
      const labelMatchesPart = rawLabel === p0 || titleLine === p0;
      const labelWasBracketForm =
        lp.parts.length >= 2 ||
        /^\s*\[[^\]]+\]\s*\[[^\]]+\]\s*$/.test(rawLabel);

      if (labelMatchesPart || labelWasBracketForm) {
        titleLine = p1;
        if (!implicitComp) implicitComp = p0;
      }
      if (dp.rest) {
        detailBody = dp.rest;
      }
    } else if (dp.parts.length === 0) {
      detailBody = rawDetail;
    } else {
      detailBody = rawDetail;
    }
  }

  let componentLine = rawComp ?? implicitComp;
  if (componentLine && componentLine === titleLine) {
    componentLine = null;
  }

  if (detailBody) {
    detailBody = detailBody.trim();
    if (detailBody === titleLine || detailBody === rawLabel) {
      detailBody = null;
    }
  }

  const hasExpandableDetail = Boolean(detailBody && detailBody.length > 0);

  titleLine = stripOuterBracketsLabel(titleLine);

  return {
    componentLine,
    titleLine,
    detailBody,
    hasExpandableDetail,
  };
}

/** ノードが開閉パネルに表示する本文テキストを持つとき true。 */
export function ftaNodeHasExpandableDetail(data: FtaDisplayFields): boolean {
  return normalizeFtaNodeDisplay(data).hasExpandableDetail;
}
