import type { DaemonOptions } from "../../src/daemon/daemon-types";
import { IDLE_HOST_LOAD } from "../../src/ops/host-resources";
import { ROOMY_STATFS } from "../../src/ops/test-host-hooks";

export { ROOMY_STATFS };

/** Host-independent defaults for `new Daemon(...)` in tests; spread first so explicit `hostLoad`/`statfs` overrides. */
export function daemonTestOptions(): Pick<DaemonOptions, "hostLoad" | "statfs"> {
	return { hostLoad: IDLE_HOST_LOAD, statfs: ROOMY_STATFS };
}
