import type { AdapterDeps, ChannelAdapter, ChannelBinding } from "../channel/adapter";
import { WebAdapter } from "./adapter";
import { WebChannel } from "./channel";

/** Web channel plug into the daemon: port and adapter backed by `web_messages` in `jabbu.db`. */
export class WebBinding implements ChannelBinding {
	readonly port: WebChannel = new WebChannel();

	createAdapter(deps: AdapterDeps): ChannelAdapter {
		this.port.attach(deps.store.web);
		return new WebAdapter({
			channel: this.port,
			webStore: deps.store.web,
			core: deps.core,
			deliveries: deps.deliveries,
			clock: deps.clock,
			log: deps.log,
		});
	}
}
