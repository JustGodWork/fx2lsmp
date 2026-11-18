import { installB1 } from "./b1.ts";
import { installClient } from "./client.ts";
import { installCore } from "./core.ts";
import { installEntities } from "./entities.ts";
import { installEvents } from "./events.ts";
import { installExports } from "./exports.ts";
import { installKvp } from "./kvp.ts";
import { installMsgpack } from "./msgpack.ts";
import { installNatives } from "./natives.ts";
import { installServer } from "./server.ts";
import { installStateBags } from "./statebags.ts";
import { side } from "./runtime.ts";

installCore();
installEvents();
installExports();
installMsgpack();
installStateBags();
if (side === "server") {
  installServer();
  installEntities();
  installB1();
} else {
  installNatives();
  installClient();
  installKvp();
  installEntities();
  installB1();
}
