# 스펙: 위임 전 위험 검사 (handoff risk scan)

상태: main에 구현됨(T-20261104-01, 마지막 `50e613f`). 원래 표기: 설계 확정, 구현 전(2026-11-04). plan 브랜치 `plan/handoff-risk-scan`.

## 배경

- 무인 코딩 위임 직전에 최종 지시문(브리프)과 저장소를 훑어 위험 신호를 `clear / advisory / high_risk`로 판정하고, strict 모드에서는 high_risk면 자동화를 멈춘다.
- jabbu는 herdr 워커에 사람 없이 돌 지시를 넘긴다. 지금 이 경로에는 지시문 내용 검사가 없다. taskSpec `risk`(L0~L4)는 위임하는 세션이 스스로 적는 값일 뿐이고, 지시문에 되돌릴 수 없는 명령(강제 push, 하드 리셋, 서비스 재시작 등)이 들어 있어도 그대로 워커에 전달된다.
- 워커에게 "하지 마라"고 적는 금지 줄(예: "머지·push·데몬 재시작은 하지 않는다")은 정상 지시이므로 고위험으로 보면 안 된다. 기존 스펙·위임 지시문이 전부 이런 금지 줄을 갖고 있다.

## 원인 (코드 경로)

- `src/dispatch/tool.ts` `executeDispatch`: herdr 경로 4갈래가 지시문을 검사 없이 내보낸다.
  1. `params.taskSpec` 신규 → `startTask(taskDeps, { spec, task, host })` (`src/tasks/dispatch.ts`, 내부 `startAgent`).
  2. `params.taskSpec` 재개 → `resumeTask(taskDeps, { id, task, host })` (살아있는 에이전트는 `herdrPromptExisting`, 없으면 `startAgent`).
  3. `host` 지정 + `task` → `herdrRemoteStart`.
  4. `mode=herdr` + `name` + `task` → `herdrPromptExisting` (후속 지시).
- `src/safety/host-tools.ts` `buildHostTools`: `dispatchDeps = { ...deps, ompExecutable }`로 만들어 `buildDispatchTool`에 넘긴다. `deps.broker`(`ApprovalBroker`)와 `deps.threadTs`가 이미 이 객체 안에 있지만 `DispatchToolDeps`에 선언돼 있지 않아 dispatch 쪽에서 쓰지 않는다.
- 승인 카드: `jabbu_request_approval`의 `execute`가 `deps.broker.ask(target, summary, { signal, detail, origin: { originKey, channel, threadTs } })`를 부른다. 결과는 `"approved" | "denied" | "timeout" | { replied }`.
- `HostToolDef.execute(params, context: { signal })`. dispatch 도구의 `execute(params)`는 지금 `context`를 받지 않는다.

## 목표

herdr 경로로 나가는 지시문을 내보내기 전에 순수 함수로 검사한다. high_risk면 오너 승인 카드를 띄워 `approved`일 때만 내보내고, 그 밖(거부·시간 초과·답장·승인 장치 없음)에는 워커를 띄우거나 지시를 보내지 않고 이유를 돌려준다. advisory면 그대로 내보내되 결과 문자열과 로그에 발견 내용을 남긴다. simple 모드는 바꾸지 않는다.

## 설계

### 1. 검사기 (신규 `src/safety/handoff-risk.ts`)

```ts
export type HandoffVerdict = "clear" | "advisory" | "high_risk";
export interface HandoffFinding { rule: string; line: number; excerpt: string; severity: "advisory" | "high_risk" }
export interface HandoffScan { verdict: HandoffVerdict; findings: HandoffFinding[]; truncated: boolean }
export function scanHandoffBrief(brief: string, options?: { protectedBranches?: readonly string[] }): HandoffScan;
```

- 순수 함수. 파일·git·네트워크를 읽지 않는다.
- 입력은 UTF-8 기준 앞 65536바이트만 본다. 넘으면 `truncated: true`. truncated면 verdict는 최소 advisory다(잘린 뒤쪽을 검사하지 못했으므로 clear로 내지 않는다).
- 줄 단위로 검사한다. `line`은 1부터 센다. `excerpt`는 그 줄을 공백 정리 후 160자 이내로 자른다.
- 대소문자 무시.
- **high_risk 규칙** (rule 이름은 그대로 쓴다):
  - `git_reset_hard`: `git reset --hard`
  - `git_clean_force`: `git clean` 뒤에 `-f`가 들어간 플래그 (`-f`, `-fd`, `-xdf`, `--force`)
  - `git_push_force`: `git push` 뒤에 `--force`, `--force-with-lease`, `-f`
  - `git_push_protected`: `git push` 뒤에 보호 브랜치 이름이 단어 경계로 나옴(기본 `main`, `master`. `protectedBranches`가 주어지면 기본값을 대체한다)
  - `git_branch_force_delete`: `git branch -D`
  - `rm_rf_absolute`: `rm` 뒤에 `-rf`/`-fr`/`-r -f` 등 재귀+강제 플래그와 `/`·`~`·`$HOME`으로 시작하는 대상
  - `sql_destructive`: `DROP TABLE`, `DROP DATABASE`, `TRUNCATE TABLE`
  - `service_control`: `systemctl`(`--user` 포함) 뒤에 `restart|stop|start|disable|kill`, `docker`·`podman` 뒤에 `rm|stop|kill|restart`, `pm2` 뒤에 `restart|stop|delete`
  - `disk_destructive`: `mkfs`, `dd ` … `of=/dev/`
  - `secret_path`: `.jabbu/secrets`
- **advisory 규칙**:
  - `package_install`: `npm install`/`npm i `, `bun add`, `bun install`, `pip install`, `apt install`/`apt-get install`
  - `owner_gate_skip`: `OMP_OWNER_APPROVED`
- **금지 문맥 하향**: high_risk 규칙이 맞은 줄에 금지 표지가 있으면 그 발견은 advisory로 내린다. 표지: `하지 마`, `하지 않`, `않는다`, `금지`, `말 것`, `말고`, `never`, `do not`, `don't`, `must not`, `forbidden`, `no `로 시작하는 목록 항목(`- no `). 같은 줄만 본다.
- verdict: 발견 중 하나라도 high_risk면 `high_risk`, 아니면 발견이 있거나 truncated면 `advisory`, 그 밖은 `clear`.

### 2. 검사 대상 텍스트

- taskSpec 신규: `task` + `title` + `goal` + `scope[]` + `background` (exclusions·acceptance는 금지·검증 문장이라 제외).
- taskSpec 재개·후속 지시·원격 시작: `task`.
- 조회만 하는 호출(`task` 없음)은 검사하지 않는다.

### 3. 연결 (`src/dispatch/tool.ts`)

- `DispatchToolDeps`에 선택 필드 `approve?: (summary: string, detail: ApprovalDetail, signal?: AbortSignal) => Promise<ApprovalResult>`를 추가한다.
- `src/safety/host-tools.ts`가 `dispatchDeps`를 만들 때 `approve`를 채운다: `deps.broker.ask(channel, summary, { signal, detail, origin: { originKey, channel, threadTs: deps.threadTs?.() } })`. 채널은 `jabbu_request_approval`과 같은 규칙(`needChannel`)으로 정한다.
- dispatch 도구 `execute(params, context)`가 `context.signal`을 `executeDispatch`로 넘긴다.
- herdr 4갈래 각각에서, 지시문을 내보내는 함수를 부르기 **전에** `gateHandoff(text, signal)`을 부른다.
  - `clear`: 그대로 진행.
  - `advisory`: 진행. `dispatch_risk_advisory { origin, rules }` info 로그 1줄. 반환 문자열 끝에 `위험 검사: advisory (<rule, …>)` 한 줄.
  - `high_risk`: `dispatch_risk_high { origin, rules }` warn 로그. 승인 카드를 띄운다. summary는 `herdr 위임 지시문에 고위험 명령이 있습니다`, detail.action은 발견 최대 5개를 `L<line> <rule>: <excerpt>`로 줄바꿈해 넣고, detail.impact는 `승인하면 이 지시문이 사람 없이 워커에서 실행됩니다`.
    - `approved`: 진행. `dispatch_risk_approved` info 로그. taskSpec 신규면 `spec.risk`가 L0~L2일 때 L3으로 올려 등록한다. 반환 문자열 끝에 `위험 검사: high_risk 승인됨 (<rule, …>)`.
    - 그 밖(`denied`, `timeout`, `{ replied }`): 워커 기동·지시 전달·worktree 생성·레지스트리 행 예약을 하지 않는다. `dispatch_risk_refused { origin, outcome }` warn 로그. `Error`를 던진다: `위험 검사에서 막혔습니다(<outcome>): <rule, …>. 지시문에서 해당 명령을 빼거나 금지 문장으로 바꾸고 다시 시도하세요`.
    - `approve`가 없으면(테스트·비 Slack 경로) 승인 불가로 보고 위와 같이 거부한다(outcome `no_approver`).
- taskSpec 신규에서 검사는 `parseTaskSpecInput` 성공 뒤, `startTask` 호출 전에 한다(입력 오류가 먼저 보고된다).

### 4. 문서

- README의 dispatch/herdr 설명 근처에 한 단락: 위험 검사 규칙 요약, 금지 문맥 하향, high_risk는 승인 카드.

## 범위

- `src/safety/handoff-risk.ts` (신규)
- `src/dispatch/tool.ts`
- `src/safety/host-tools.ts`
- `test/handoff-risk.test.ts` (신규), `test/dispatch.test.ts` 또는 `test/task-dispatch.test.ts`
- `README.md` (한 단락)

## 제외

- simple 모드(`runOmpPrint`) 경로
- `src/omp/env.ts` 환경변수 정책 변경, 데몬 재시도 실패 분류(후속 별도 과제)
- 저장소 상태 검사(`--repo` 기능: 보호 브랜치 체크아웃 여부 등)
- `ApprovalBroker`·승인 카드 렌더링 변경
- 라이브 체크아웃(`<오너 체크아웃 경로>`) 편집
- 머지·push·데몬 재시작

## 수락기준

- AC-1: `scanHandoffBrief` 단위 테스트 — high_risk 규칙 10개(`git_reset_hard`, `git_clean_force`, `git_push_force`, `git_push_protected`, `git_branch_force_delete`, `rm_rf_absolute`, `sql_destructive`, `service_control`, `disk_destructive`, `secret_path`)마다 양성 1개 이상이 `high_risk`와 그 rule 이름을 낸다.
- AC-2: 금지 문맥 하향 테스트 — "머지·push·데몬 재시작(systemctl --user restart jabbu)는 하지 않는다", "never run git reset --hard" 같은 줄은 verdict가 `advisory`이고 `high_risk`가 아니다. 이 문서 전문을 넣어도 `high_risk`가 아니다.
- AC-3: 음성 테스트 — `git push origin task/T-20261104-01`, `git reset --soft HEAD~1`, `rm -rf node_modules`, `git branch -d task/x`, 일반 한국어 지시문은 해당 high_risk rule을 내지 않는다.
- AC-4: `protectedBranches: ["production"]`이면 `git push origin production`은 `git_push_protected`, `git push origin main`은 `git_push_protected`를 내지 않는다.
- AC-5: 65536바이트를 넘는 입력은 `truncated: true`이고 verdict가 `clear`가 아니다. 위험 명령이 65536바이트 뒤에만 있으면 그 rule을 내지 않는다.
- AC-6: dispatch 연결 테스트 — herdr 4갈래(taskSpec 신규, taskSpec 재개+task, host 원격 시작, mode=herdr+name 후속 지시) 각각에서 high_risk 지시문 + `approve`가 `denied`를 돌려주면 에러가 나고, 기동·전달 함수(주입한 `run` 대역 또는 herdr 호출)가 한 번도 불리지 않는다. taskSpec 신규는 worktree 생성·레지스트리 행도 생기지 않는다.
- AC-7: 같은 4갈래에서 `approve`가 `approved`면 기동·전달이 일어나고, taskSpec 신규의 등록 risk가 L2 입력에서 L3으로 올라간다. `timeout`, `{ replied: "응" }`, `approve` 없음은 `denied`와 같이 막힌다(각각 테스트).
- AC-8: clear 지시문은 `approve`를 부르지 않고 기존과 같은 반환 문자열로 진행한다. advisory 지시문은 `approve`를 부르지 않고 진행하며 반환 끝에 `위험 검사: advisory`가 붙는다. simple 모드는 high_risk 지시문이어도 `approve`를 부르지 않는다(테스트).
- AC-9: 회귀 테스트 AC-6 중 하나가 수정 전 코드에서 실패하는 것을 확인하고 그 실패 줄을 PROGRESS.md 증거에 남긴다.
- AC-10: `bun test` 실패 0, `bun run check` 통과.
- AC-11: 변경이 task 브랜치에 커밋돼 있고, 제외 파일(`src/omp/env.ts`, `src/safety/approval.ts`, `src/dispatch/omp.ts`)이 `git diff --stat <base>..HEAD`에 나오지 않는다.

## 반영

- (머지 후 기록)
