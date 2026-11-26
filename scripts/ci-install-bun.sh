#!/usr/bin/env bash
# Bun을 고정 버전·체크섬으로 내려받아 BIN_DIR에 설치한다(WSL2 Linux x64·arm64 CI 전용).
# 태그 설치나 파이프 다운로드 대신, 검증한 바이트만 옮긴다.
set -euo pipefail

VERSION=1.4.4

# 아키텍처마다 자산과 체크섬이 따로다. 목록에 없는 아키텍처는 내려받기 전에 실패한다.
machine=$(uname -m)
case "$machine" in
x86_64 | amd64)
	ASSET=bun-linux-x64
	SHA256=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
	;;
aarch64 | arm64)
	ASSET=bun-linux-aarch64
	SHA256=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
	;;
*)
	echo "ci-install-bun: unsupported architecture: $machine" >&2
	exit 3
	;;
esac
URL="https://github.com/oven-sh/bun/releases/download/bun-v${VERSION}/${ASSET}.zip"

if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
	echo "usage: ci-install-bun.sh BIN_DIR" >&2
	exit 2
fi

bin_dir=$1
mkdir -p "$bin_dir"
work=$(mktemp -d "$bin_dir/.bun-download.XXXXXX")
trap 'rm -rf "$work"' EXIT

# 세 번까지, 20→40초 쉬며 받는다. 재시도 사이에는 부분 바이트를 지운다.
delay=20
for attempt in 1 2 3; do
	if timeout --kill-after=5s 60s curl -sSfL -o "$work/bun.zip" "$URL"; then
		break
	fi
	rm -f "$work/bun.zip"
	if [ "$attempt" = 3 ]; then
		echo "ci-install-bun: download failed after 3 attempts" >&2
		exit 22
	fi
	sleep "$delay"
	delay=$((delay * 2))
done

echo "$SHA256  $work/bun.zip" | sha256sum -c - >/dev/null
unzip -qo "$work/bun.zip" "${ASSET}/bun" -d "$work"
chmod 755 "$work/${ASSET}/bun"
mv "$work/${ASSET}/bun" "$bin_dir/bun"
echo "ci-install-bun: bun $VERSION installed at $bin_dir/bun"
