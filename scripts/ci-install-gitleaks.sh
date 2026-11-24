#!/usr/bin/env bash
# gitleaks를 고정 버전·체크섬으로 내려받아 BIN_DIR에 설치한다(Linux x64·arm64 CI 전용).
# 태그 설치나 파이프 다운로드 대신, 검증한 바이트만 옮긴다.
set -euo pipefail

VERSION=8.28.0

# 아키텍처마다 자산과 체크섬이 따로다. 목록에 없는 아키텍처는 내려받기 전에 실패한다.
machine=$(uname -m)
case "$machine" in
x86_64 | amd64)
	ASSET=linux_x64
	SHA256=a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb
	;;
aarch64 | arm64)
	ASSET=linux_arm64
	SHA256=eff65261156100e5d94a6b3dec313d532fddfe19ae1590bf7a2b4f2699128356
	;;
*)
	echo "ci-install-gitleaks: unsupported architecture: $machine" >&2
	exit 3
	;;
esac
URL="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_${ASSET}.tar.gz"

if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
	echo "usage: ci-install-gitleaks.sh BIN_DIR" >&2
	exit 2
fi

bin_dir=$1
mkdir -p "$bin_dir"
work=$(mktemp -d "$bin_dir/.gitleaks-download.XXXXXX")
trap 'rm -rf "$work"' EXIT

# 세 번까지, 20→40초 쉬며 받는다. 재시도 사이에는 부분 바이트를 지운다.
delay=20
for attempt in 1 2 3; do
	if timeout --kill-after=5s 60s curl -sSfL -o "$work/gitleaks.tar.gz" "$URL"; then
		break
	fi
	rm -f "$work/gitleaks.tar.gz"
	if [ "$attempt" = 3 ]; then
		echo "ci-install-gitleaks: download failed after 3 attempts" >&2
		exit 22
	fi
	sleep "$delay"
	delay=$((delay * 2))
done

echo "$SHA256  $work/gitleaks.tar.gz" | sha256sum -c - >/dev/null
tar -xzf "$work/gitleaks.tar.gz" -C "$work" gitleaks
mv "$work/gitleaks" "$bin_dir/gitleaks"
echo "ci-install-gitleaks: gitleaks $VERSION installed at $bin_dir/gitleaks"
