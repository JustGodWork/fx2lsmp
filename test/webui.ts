import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** A webui folder with the prelude, an index.html and one page script. */
export function makeWebui(pageScript: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fxwebui-"));
  mkdirSync(join(dir, "_fxcompat"), { recursive: true });
  copyFileSync(resolve(import.meta.dirname, "../shim/nui-prelude.js"), join(dir, "_fxcompat", "nui-prelude.js"));
  copyFileSync(resolve(import.meta.dirname, "../shim/kvp-page.html"), join(dir, "_fxcompat", "kvp.html"));
  writeFileSync(join(dir, "page.js"), pageScript);
  writeFileSync(
    join(dir, "index.html"),
    '<html><body><script src="/_fxcompat/nui-prelude.js"></script><script src="page.js"></script></body></html>',
  );
  return dir;
}
