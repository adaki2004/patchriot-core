#!/bin/sh
set -eu
# Railway supplies PORT. An explicit bind remains available for local tests.
export PATCHRIOT_CORE_BIND="${PATCHRIOT_CORE_BIND:-[::]:${PORT:-8080}}"
exec /usr/local/bin/patchriot-core "$@"
