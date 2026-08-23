#!/bin/bash
set -e
python viewer/backend/init_data.py
exec uvicorn viewer.backend.main:app --host 0.0.0.0 --port "${PORT:-8001}"
