// Real-process stand-in for $.process.run / $.fs, used only by the engine suite.
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";

export function createIo(warnings = []) {
  return {
    warn: (m) => warnings.push(String(m)),
    run(argv, init = {}) {
      // $.process.run runs git with repo hooks off; mirror that here.
      const gi = argv.indexOf("git");
      if (gi >= 0 && gi <= 40) argv = [...argv.slice(0, gi + 1), "-c", "core.hooksPath=/dev/null", ...argv.slice(gi + 1)];
      return new Promise((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), {
          cwd: init.cwd,
          env: { ...process.env, ...(init.env ?? {}) },
          stdio: ["pipe", "pipe", "pipe"],
        });
        const out = [], err = [];
        child.stdout.on("data", (d) => out.push(d));
        child.stderr.on("data", (d) => err.push(d));
        child.on("error", reject);
        child.on("close", (code) =>
          resolve({
            exitCode: code ?? 1,
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(err).toString("utf8"),
            isStdoutTruncated: false,
            isStderrTruncated: false,
          }));
        child.stdin.on("error", () => {});
        child.stdin.end(init.stdin ?? "");
      });
    },
    async fileSize(file) {
      try { const s = await stat(file); return s.isFile() ? s.size : null; } catch { return null; }
    },
    async readBase64(file) { return (await readFile(file)).toString("base64"); },
  };
}
