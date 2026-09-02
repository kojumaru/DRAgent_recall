"""
デプロイ時に DATA_DIR（永続ディスク）へバンドルデータを同期する。

- raw.json / spec_FTA.md / label.json / input.yaml / recall.pdf は常に上書き
- review.json 系ファイルは永続ディスク上の既存ファイルを保持（専門家レビューを消さない）
- DATA_DIR が未設定またはローカルパスの場合は何もしない
"""
import os
import shutil
from pathlib import Path

# 常に上書きする管理ファイル
SYNC_FILES = {"raw.json", "spec_FTA.md", "label.json", "input.yaml", "output.yaml", "recall.pdf", "diagram.pdf"}

data_dir_env = os.environ.get("DATA_DIR", "")
if not data_dir_env or not Path(data_dir_env).is_absolute():
    print("[init] DATA_DIR not set or not absolute — skipping.")
    raise SystemExit(0)

data_dir = Path(data_dir_env)
bundled = Path(__file__).parent.parent.parent / "data"

if not bundled.exists():
    print(f"[init] Bundled data not found at {bundled} — skipping.")
    raise SystemExit(0)

data_dir.mkdir(parents=True, exist_ok=True)
updated = 0
added = 0

for src_recall in sorted(bundled.iterdir()):
    if not src_recall.is_dir():
        continue
    dst_recall = data_dir / src_recall.name
    dst_recall.mkdir(exist_ok=True)
    for src_file in src_recall.iterdir():
        if src_file.name not in SYNC_FILES:
            continue
        dst_file = dst_recall / src_file.name
        if dst_file.exists():
            shutil.copy2(str(src_file), str(dst_file))
            updated += 1
        else:
            shutil.copy2(str(src_file), str(dst_file))
            added += 1

print(f"[init] Sync complete: {added} added, {updated} updated → {data_dir}")
