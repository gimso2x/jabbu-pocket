// Windows 네이티브 스모크 테스트 실행기: POSIX·systemd·유닉스 소켓에 기대지 않는 핵심 테스트 묶음을 돌린다.
// 제외 사유:
// - test/origin-key.test.ts: readdirSync(..., { recursive: true }) 결과가 Windows에서 역슬래시를 돌려줘 "core/origin-key.ts" 단언과 어긋남
// - test/store.test.ts: line 100에서 연 readonly Database 핸들을 닫지 않아 afterEach의 rmSync가 Windows에서 EBUSY로 실패할 수 있음
export const WINDOWS_SMOKE_TESTS = [
	"test/agy-quota-bounds.test.ts",
	"test/channel-card.test.ts",
	"test/channel-shared.test.ts",
	"test/channel-text-edges.test.ts",
	"test/chat-commands.test.ts",
	"test/check-loc.test.ts",
	"test/ci-workflow.test.ts",
	"test/cost-cap.test.ts",
	"test/delivery-platform.test.ts",
	"test/discord-card.test.ts",
	"test/discord-code-spans.test.ts",
	"test/discord-format.test.ts",
	"test/failure-kind.test.ts",
	"test/guard-code.test.ts",
	"test/monitor-cron.test.ts",
	"test/normalize.test.ts",
	"test/opref.test.ts",
	"test/redact.test.ts",
	"test/time.test.ts",
] as const;

if (import.meta.main) {
	const proc = Bun.spawnSync([process.execPath, "test", "--parallel=3", ...WINDOWS_SMOKE_TESTS], {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	process.exit(proc.exitCode ?? 1);
}
