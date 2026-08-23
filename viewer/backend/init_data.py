"""
初回デプロイ時に DATA_DIR（永続ディスク）へバンドルデータをコピーする。
DATA_DIR が未設定またはローカルパスの場合は何もしない。
"""
import os
import shutil
from pathlib import Path

data_dir_env = os.environ.get("DATA_DIR", "")
if not data_dir_env or not Path(data_dir_env).is_absolute():
    print("[init] DATA_DIR not set or not absolute — skipping.")
    raise SystemExit(0)

data_dir = Path(data_dir_env)
bundled = Path(__file__).parent.parent.parent / "data"

if not bundled.exists():
    print(f"[init] Bundled data not found at {bundled} — skipping.")
    raise SystemExit(0)

if data_dir.exists() and any(data_dir.iterdir()):
    print(f"[init] {data_dir} already has data — skipping copy.")
    raise SystemExit(0)

data_dir.mkdir(parents=True, exist_ok=True)
shutil.copytree(str(bundled), str(data_dir), dirs_exist_ok=True)
print(f"[init] Copied initial data: {bundled} → {data_dir}")
