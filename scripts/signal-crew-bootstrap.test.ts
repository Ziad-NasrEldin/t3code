// @effect-diagnostics nodeBuiltinImport:off - Runs the packaged launcher in an isolated VM.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { expect, it } from "@effect/vitest";

it.each([false, true])("keeps explicit sandbox paths when configured: %s", (sandbox) => {
  const base = NodePath.join(
    NodeOS.homedir(),
    "Library",
    "Application Support",
    "t3code-signal-crew",
  );
  const env: Record<string, string> = sandbox
    ? { T3CODE_HOME: "/sandbox/home", T3CODE_DESKTOP_USER_DATA_DIR: "/sandbox/electron" }
    : {};
  const expected = sandbox
    ? { ...env }
    : {
        T3CODE_HOME: NodePath.join(base, "home"),
        T3CODE_DESKTOP_USER_DATA_DIR: NodePath.join(base, "electron"),
      };
  NodeVM.runInNewContext(
    NodeFS.readFileSync(new URL("./signal-crew-bootstrap.cjs", import.meta.url), "utf8"),
    {
      process: { env },
      require: (id: string) =>
        id === "node:path" ? NodePath : id === "node:os" ? NodeOS : undefined,
    },
  );
  expect(env).toMatchObject(expected);
});
