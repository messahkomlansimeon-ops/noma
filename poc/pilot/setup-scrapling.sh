#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
VENV_PATH=${NOMA_SCRAPLING_VENV:-"$PROJECT_ROOT/.venv-scrapling"}

python3 -m venv "$VENV_PATH"
"$VENV_PATH/bin/pip" install --requirement "$SCRIPT_DIR/requirements.lock.txt"
"$VENV_PATH/bin/python" -c "import scrapling; print('Scrapling parser ready')"
