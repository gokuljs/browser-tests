// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fixture: string;
let upstream: string;
let webrtcV4: string;
let webrtcV5: string;
let mainCommit: string;
let featureCommit: string;

const git = async (directory: string, ...args: string[]) => {
  const { stdout } = await exec("git", ["-C", directory, ...args]);
  return stdout.trim();
};

const commit = async (directory: string) => {
  await git(directory, "add", ".");
  await git(directory, "-c", "user.name=Browser test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "test fixture");
};

const setSource = (marker: string) => writeFile(path.join(upstream, "source.go"),
  `package interceptor\nconst SourceMarker = ${JSON.stringify(marker)}\n`);

const createWebRTC = async (directory: string, version: string, marker: string) => {
  await mkdir(directory);
  await writeFile(path.join(directory, "go.mod"), `module github.com/pion/webrtc/${version}

go 1.24.0

require github.com/pion/interceptor v0.0.0
`);
  // Interceptor selection must affect WebRTC's transitive dependency, not just
  // an unrelated import added directly to the test server.
  await writeFile(path.join(directory, "source.go"), `package webrtc
import "github.com/pion/interceptor"
func SourceMarker() string { return ${JSON.stringify(marker)} + ":" + interceptor.SourceMarker }
`);
};

const run = async (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const env = { ...process.env };
  delete env.TEST_SERVER_URL;
  delete env.PION_WEBRTC_SOURCE;
  delete env.PION_INTERCEPTOR_SOURCE;
  return exec(process.execPath, ["scripts/run-browser-tests.ts", ...args], {
    cwd: fixture,
    timeout: 120_000,
    env: {
      ...env,
      GOFLAGS: [env.GOFLAGS, "-buildvcs=false"].filter(Boolean).join(" "),
      GOWORK: path.join(fixture, "nonexistent-caller.go.work"),
      // Every dependency is supplied locally, so these tests must not download
      // Go modules or consult the public checksum service.
      GOPROXY: "off",
      GOSUMDB: "off",
      PION_WEBRTC_REPOSITORY: webrtcV4,
      PION_INTERCEPTOR_REPOSITORY: upstream,
      TESTSERVER_ADDR: `127.0.0.1:${address.port}`,
      EXPECTED_SOURCE: "baseline:uncommitted interceptor",
      ...extraEnv,
    },
  });
};

const failureOutput = (error: unknown) => {
  assert(error instanceof Error && "stdout" in error && "stderr" in error);
  return `${String(error.stdout)}\n${String(error.stderr)}`;
};

const expectFailure = async (operation: ReturnType<typeof run>) => operation.then(
  () => assert.fail("Expected runner to fail"),
  (error: unknown) => {
    const output = failureOutput(error);
    assert(error instanceof Error && "code" in error);
    return { output, code: error.code };
  },
);

const assertRemoved = async (directory: string) => {
  await assert.rejects(readFile(path.join(directory, "go.mod")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(path.dirname(directory), "go.work")), { code: "ENOENT" });
};

describe("interceptor source selection", { timeout: 300_000 }, () => {
  before(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), "pion interceptor selection "));
    upstream = path.join(fixture, "interceptor checkout");
    webrtcV4 = path.join(fixture, "WebRTC v4 checkout");
    webrtcV5 = path.join(fixture, "WebRTC v5 checkout");
    const normalWebRTC = path.join(fixture, "baseline WebRTC");
    const normalInterceptor = path.join(fixture, "baseline interceptor");
    await mkdir(path.join(fixture, "scripts"));
    await mkdir(path.join(fixture, "node_modules", "vitest"), { recursive: true });
    await mkdir(upstream);
    await mkdir(normalInterceptor);
    await cp(path.join(rootDir, "scripts/run-browser-tests.ts"), path.join(fixture, "scripts/run-browser-tests.ts"));
    await writeFile(path.join(fixture, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(normalInterceptor, "go.mod"), "module github.com/pion/interceptor\n\ngo 1.24.0\n");
    await writeFile(path.join(normalInterceptor, "source.go"), 'package interceptor\nconst SourceMarker = "baseline interceptor"\n');
    await createWebRTC(normalWebRTC, "v4", "baseline");
    await createWebRTC(webrtcV4, "v4", "paired v4");
    await createWebRTC(webrtcV5, "v5", "paired v5");
    for (const directory of [webrtcV4, webrtcV5]) {
      // A selected interceptor must also win over WebRTC's module replacement.
      const moduleFile = path.join(directory, "go.mod");
      await writeFile(moduleFile, `${await readFile(moduleFile, "utf8")}\nreplace github.com/pion/interceptor => ${JSON.stringify(normalInterceptor)}\n`);
      await git(directory, "init", "--quiet", "-b", "main");
      await commit(directory);
    }
    await writeFile(path.join(fixture, "go.mod"), `module github.com/pion/browsertests

go 1.24.0

require github.com/pion/webrtc/v4 v4.0.0
require github.com/pion/interceptor v0.0.0 // indirect

replace github.com/pion/webrtc/v4 => ${JSON.stringify(normalWebRTC)}
replace github.com/pion/interceptor => ${JSON.stringify(normalInterceptor)}
`);
    await writeFile(path.join(fixture, "go.sum"), "");
    await writeFile(path.join(fixture, "runner.go"), `package main
import ("net/http"; "os"; "github.com/pion/webrtc/v4")
func main() {
  http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("X-Test-Server-ID", os.Getenv("TESTSERVER_ID"))
    w.Write([]byte("ok"))
  })
  http.HandleFunc("/source", func(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte(webrtc.SourceMarker()))
  })
  if err := http.ListenAndServe(os.Getenv("TESTSERVER_ADDR"), nil); err != nil { panic(err) }
}
`);
    await writeFile(path.join(fixture, "node_modules", "vitest", "vitest.mjs"), `
import assert from "node:assert/strict";
const response = await fetch(process.env.VITE_TEST_SERVER_URL + "/source");
assert.equal(await response.text(), process.env.EXPECTED_SOURCE);
assert.deepEqual(process.argv.slice(2), ["run", "--reporter", "dot"]);
process.exit(Number(process.env.RUNNER_TEST_EXIT || 0));
`);
    await writeFile(path.join(upstream, "go.mod"), "module github.com/pion/interceptor\n\ngo 1.24.0\n");
    await git(upstream, "init", "--quiet", "-b", "main");
    await setSource("main interceptor");
    await commit(upstream);
    mainCommit = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "checkout", "--quiet", "-b", "feature/source-test");
    await setSource("feature interceptor");
    await commit(upstream);
    featureCommit = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "tag", "v0.99.0");
    await setSource("uncommitted interceptor");
  });

  after(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  it("preserves normal dependency selection when no override is supplied", async () => {
    const moduleFile = path.join(fixture, "go.mod");
    const original = await readFile(moduleFile, "utf8");
    const { stdout } = await run(["--reporter", "dot"], { EXPECTED_SOURCE: "baseline:baseline interceptor" });
    assert(!stdout.includes("Testing Pion"), stdout);
    assert.equal(await readFile(moduleFile, "utf8"), original);
    await assert.rejects(readFile(path.join(fixture, "go.work")), { code: "ENOENT" });
  });

  it("selects uncommitted local interceptor code independently without editing either module", async () => {
    const files = [path.join(fixture, "go.mod"), path.join(fixture, "go.sum"), path.join(fixture, "runner.go"),
      path.join(upstream, "go.mod"), path.join(upstream, "source.go")];
    const original = await Promise.all(files.map(file => readFile(file, "utf8")));
    const status = await git(upstream, "status", "--porcelain");
    const { stdout } = await run(["--interceptor", "./interceptor checkout", "--reporter", "dot"], {
      PION_INTERCEPTOR_SOURCE: "no-such-environment-ref",
    });
    assert(stdout.includes(`Testing Pion interceptor checkout: ${await realpath(upstream)}`), stdout);
    assert.deepEqual(await Promise.all(files.map(file => readFile(file, "utf8"))), original);
    assert.equal(await git(upstream, "status", "--porcelain"), status);
    await assert.rejects(readFile(path.join(fixture, "go.work")), { code: "ENOENT" });
  });

  it("accepts environment selection and CLI equals syntax overriding that environment", async () => {
    await run(["--reporter", "dot"], { PION_INTERCEPTOR_SOURCE: upstream });
    await run([`--interceptor=${upstream}`, "--reporter", "dot"], {
      PION_INTERCEPTOR_SOURCE: "no-such-environment-ref",
    });
  });

  it("fetches branches, tags, and exact commits into temporary checkouts and removes them", async () => {
    const cases = [["feature/source-test", "feature interceptor", featureCommit],
      ["v0.99.0", "feature interceptor", featureCommit], [mainCommit, "main interceptor", mainCommit]];
    for (const [ref, marker, revision] of cases) {
      const { stdout } = await run([`--interceptor=${ref}`, "--reporter", "dot"], {
        EXPECTED_SOURCE: `baseline:${marker}`,
      });
      assert(stdout.includes(`Testing Pion interceptor ref ${ref} at ${revision}`), stdout);
      const checkout = stdout.match(/Testing Pion interceptor checkout: (.+)/)?.[1];
      assert(checkout, stdout);
      assert.notEqual(checkout, upstream);
      await assertRemoved(checkout);
    }
  });

  it("selects local v4 and v5 WebRTC sources with the same interceptor and preserves source files", async () => {
    const files = [path.join(fixture, "go.mod"), path.join(fixture, "go.sum"), path.join(fixture, "runner.go"),
      ...[webrtcV4, webrtcV5, upstream].flatMap(directory => [path.join(directory, "go.mod"), path.join(directory, "source.go")])];
    const original = await Promise.all(files.map(file => readFile(file, "utf8")));
    const statuses = await Promise.all([webrtcV4, webrtcV5, upstream].map(directory => git(directory, "status", "--porcelain")));
    for (const [webrtc, marker] of [[webrtcV4, "paired v4"], [webrtcV5, "paired v5"]]) {
      await run(["--webrtc", webrtc, "--interceptor", upstream, "--reporter", "dot"], {
        EXPECTED_SOURCE: `${marker}:uncommitted interceptor`,
      });
    }
    assert.deepEqual(await Promise.all(files.map(file => readFile(file, "utf8"))), original);
    assert.deepEqual(await Promise.all([webrtcV4, webrtcV5, upstream].map(directory => git(directory, "status", "--porcelain"))), statuses);
  });

  it("fetches paired v4 and v5 refs and cleans up both source checkouts", async () => {
    for (const [repository, marker] of [[webrtcV4, "paired v4"], [webrtcV5, "paired v5"]]) {
      const { stdout } = await run(["--webrtc=main", "--interceptor=feature/source-test", "--reporter", "dot"], {
        PION_WEBRTC_REPOSITORY: repository,
        EXPECTED_SOURCE: `${marker}:feature interceptor`,
      });
      for (const label of ["WebRTC", "interceptor"]) {
        const checkout = stdout.match(new RegExp(`Testing Pion ${label} checkout: (.+)`))?.[1];
        assert(checkout, stdout);
        await assertRemoved(checkout);
      }
    }
  });

  it("cleans up both fetched modules when Vitest fails", async () => {
    const { output, code } = await expectFailure(run(["--webrtc=main", "--interceptor=main", "--reporter", "dot"], {
      EXPECTED_SOURCE: "paired v4:main interceptor",
      RUNNER_TEST_EXIT: "7",
    }));
    assert.equal(code, 7, output);
    for (const label of ["WebRTC", "interceptor"]) {
      const checkout = output.match(new RegExp(`Testing Pion ${label} checkout: (.+)`))?.[1];
      assert(checkout, output);
      await assertRemoved(checkout);
    }
  });

  it("cleans up fetched modules when selected interceptor code fails to build", async () => {
    const invalid = path.join(fixture, "invalid interceptor");
    await mkdir(invalid);
    await writeFile(path.join(invalid, "go.mod"), "module github.com/pion/interceptor\n\ngo 1.24.0\n");
    await writeFile(path.join(invalid, "source.go"), "invalid go source\n");
    await git(invalid, "init", "--quiet", "-b", "main");
    await commit(invalid);
    const { output } = await expectFailure(run(["--webrtc=main", "--interceptor=main", "--reporter", "dot"], {
      PION_INTERCEPTOR_REPOSITORY: invalid,
    }));
    assert.match(output, /Go build exited/);
    for (const label of ["WebRTC", "interceptor"]) {
      const checkout = output.match(new RegExp(`Testing Pion ${label} checkout: (.+)`))?.[1];
      assert(checkout, output);
      await assertRemoved(checkout);
    }
  });

  it("rejects invalid checkout paths, modules, and refs", async () => {
    const cases: [string, RegExp][] = [
      ["./missing", /interceptor checkout does not exist/],
      [path.join(fixture, "go.mod"), /interceptor checkout is not a directory/],
      [".", /Expected github.com\/pion\/interceptor checkout/],
      [webrtcV4, /Expected github.com\/pion\/interceptor checkout/],
      ["no-such-ref", /git -C exited:/],
    ];
    for (const [source, message] of cases) {
      await assert.rejects(run(["--interceptor", source]), (error: unknown) => {
        assert.match(failureOutput(error), message);
        return true;
      });
    }
  });

  it("rejects missing or repeated interceptor arguments", async () => {
    const cases: [string[], RegExp][] = [
      [["--interceptor"], /--interceptor requires/],
      [["--interceptor="], /--interceptor requires/],
      [["--interceptor", "--reporter", "dot"], /--interceptor requires/],
      [["--interceptor=main", "--interceptor", "main"], /Specify --interceptor only once/],
    ];
    for (const [args, message] of cases) {
      await assert.rejects(run(args), (error: unknown) => {
        assert.match(failureOutput(error), message);
        return true;
      });
    }
  });

  it("rejects CLI and environment interceptor overrides with external-server mode", async () => {
    for (const [args, extraEnv] of [[ ["--interceptor", upstream], {} ],
      [[], { PION_INTERCEPTOR_SOURCE: upstream }]] as [string[], NodeJS.ProcessEnv][]) {
      await assert.rejects(run(args, { TEST_SERVER_URL: "http://127.0.0.1:1", ...extraEnv }), (error: unknown) => {
        assert.match(failureOutput(error), /Cannot select .* checkout\/ref/);
        return true;
      });
    }
  });

  it("fetches the latest branch head on each run without relying on a fixed revision", async () => {
    await run(["--interceptor=feature/source-test", "--reporter", "dot"], {
      EXPECTED_SOURCE: "baseline:feature interceptor",
    });
    await setSource("updated interceptor");
    await commit(upstream);
    const revision = await git(upstream, "rev-parse", "HEAD");
    assert.notEqual(revision, featureCommit);
    const { stdout } = await run(["--interceptor=feature/source-test", "--reporter", "dot"], {
      EXPECTED_SOURCE: "baseline:updated interceptor",
    });
    assert(stdout.includes(`Testing Pion interceptor ref feature/source-test at ${revision}`), stdout);
  });
});
