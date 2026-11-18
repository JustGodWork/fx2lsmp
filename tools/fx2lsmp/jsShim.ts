import { build } from "esbuild";
import { join } from "node:path";

/** Bundles shim/js into one script for LS:MP (the client JS has no module system). */
export async function buildJsShim(shimDir: string, withHashes = true): Promise<string> {
  const result = await build({
    entryPoints: [join(shimDir, "js", "index.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "neutral",
    target: "es2022",
    legalComments: "none",
    minifyWhitespace: true,
    logLevel: "silent",
    define: { __FX_HASHES__: String(withHashes) },
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error("fxcompat: esbuild produced no output for the JS shim");
  return output.text;
}
