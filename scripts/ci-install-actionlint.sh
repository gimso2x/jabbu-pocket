#!/usr/bin/env bash
# actionlint를 고정 버전·체크섬으로 내려받아 BIN_DIR에 설치한다(Linux x64·arm64 CI 전용).
# 태그 설치나 파이프 다운로드 대신 검증한 바이트만 옮긴다.
set -euo pipefail

VERSION=1.7.12

# 아키텍처마다 자산과 체크섬이 따로다. 목록에 없는 아키텍처는 내려받기 전에 실패한다.
machine=$(uname -m)
case "$machine" in
x86_64 | amd64)
	ASSET=linux_amd64
	SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
	;;
aarch64 | arm64)
	ASSET=linux_arm64
	SHA256=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6
	;;
*)
	echo "ci-install-actionlint: unsupported architecture: $machine" >&2
	exit 3
	;;
esac
URL="https://github.com/rhysd/actionlint/releases/download/v${VERSION}/actionlint_${VERSION}_${ASSET}.tar.gz"

if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
	echo "usage: ci-install-actionlint.sh BIN_DIR" >&2
	exit 2
fi

bin_dir=$1
mkdir -p "$bin_dir"
work=$(mktemp -d "$bin_dir/.actionlint-download.XXXXXX")
trap 'rm -rf "$work"' EXIT

# 세 번까지 20→40초 쉬며 받는다. 재시도 사이에는 부분 바이트를 지운다.
delay=20
for attempt in 1 2 3; do
	if timeout --kill-after=5s 60s curl -sSfL -o "$work/actionlint.tar.gz" "$URL"; then
		break
	fi
	rm -f "$work/actionlint.tar.gz"
	if [ "$attempt" = 3 ]; then
		echo "ci-install-actionlint: download failed after 3 attempts" >&2
		exit 22
	fi
	sleep "$delay"
	delay=$((delay * 2))
done

echo "$SHA256  $work/actionlint.tar.gz" | sha256sum -c - >/dev/null
tar -xzf "$work/actionlint.tar.gz" -C "$work" actionlint
mv "$work/actionlint" "$bin_dir/actionlint"
echo "ci-install-actionlint: actionlint $VERSION installed at $bin_dir/actionlint"
