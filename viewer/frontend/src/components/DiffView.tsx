type DiffLine = { text: string; type: 'same' | 'added' | 'removed' };

function computeLineDiff(original: string, modified: string): DiffLine[] {
  const a = original.split('\n');
  const b = modified.split('\n');
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const result: DiffLine[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
      result.unshift({ text: a[i-1], type: 'same' }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      result.unshift({ text: b[j-1], type: 'added' }); j--;
    } else {
      result.unshift({ text: a[i-1], type: 'removed' }); i--;
    }
  }
  return result;
}

export default function DiffView({ original, modified }: { original: string; modified: string }) {
  const lines = computeLineDiff(original.trimEnd(), modified.trimEnd());
  const hasChanges = lines.some(l => l.type !== 'same');
  if (!hasChanges) return null;
  return (
    <div className="mt-1 rounded border border-neutral-200 bg-neutral-50 p-2 font-mono text-[10px] leading-relaxed max-h-40 overflow-y-auto">
      <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-neutral-400">差分プレビュー</p>
      {lines.map((line, i) =>
        line.type === 'same' ? null : (
          <div
            key={i}
            className={`whitespace-pre-wrap rounded px-1 ${
              line.type === 'added'
                ? 'bg-green-100 text-green-800'
                : 'bg-red-100 text-red-600 line-through opacity-70'
            }`}
          >
            {line.type === 'added' ? '＋ ' : '－ '}{line.text || '\u00a0'}
          </div>
        )
      )}
    </div>
  );
}
