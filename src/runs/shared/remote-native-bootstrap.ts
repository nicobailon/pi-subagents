import * as sdk from "@earendil-works/pi-coding-agent";
import { createDefaultChildSessionFactory } from "./child-session.ts";
import { writeNativeRemoteRpcRecordSync } from "./native-remote-rpc.ts";
import { runRemoteNativeHost } from "./remote-native-host.ts";

/**
 * Runs inside Pi's extension loader so Pi's embedded/npm SDK and peer aliases own
 * every SDK import. Awaiting the host here and exiting prevents the outer Pi RPC
 * loop from competing for stdin or writing its own protocol records.
 */
export default async function runRemoteNativeBootstrap(): Promise<never> {
	try {
		await runRemoteNativeHost({
			factory: createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk }),
			piVersion: sdk.VERSION,
			sendRecord: writeNativeRemoteRpcRecordSync,
		});
		process.exit(0);
	} catch (error) {
		process.stderr.write(`Remote native Pi host failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
}
