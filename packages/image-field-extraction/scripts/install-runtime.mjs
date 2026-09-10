#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = existsSync(path.join(SCRIPT_DIR, "python")) ? SCRIPT_DIR : path.dirname(SCRIPT_DIR);
const TARGET = path.resolve(process.env.BAOX_HOME ?? path.join(os.homedir(), ".baox"), "ocr-runtime", "v1");
const PYTHON = findPython();
const plan = {
  status: process.argv.includes("--yes") ? "installing" : "confirmation_required",
  engine: "RapidOCR 3.9.2 + PP-OCRv6 small + ONNX Runtime 1.23.2 (CPU)",
  source: "Python Package Index and RapidOCR official model package",
  estimatedDownload: "approximately 150-300 MB including Python wheels and models",
  cache: TARGET,
  python: PYTHON,
};
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);

if (!process.argv.includes("--yes")) process.exit(2);
if (process.platform !== "darwin" || process.arch !== "arm64") fail("v1 only supports Apple Silicon macOS");
if (!PYTHON) fail("Python 3.11 is required; install it and run setup again");

const temporary = `${TARGET}.installing-${process.pid}`;
rmSync(temporary, { recursive: true, force: true });
mkdirSync(path.dirname(TARGET), { recursive: true, mode: 0o700 });
const uv = commandExists("uv");
run(uv ? ["uv", "venv", "--python", PYTHON, temporary] : [PYTHON, "-m", "venv", temporary]);
const environmentPython = path.join(temporary, "bin", "python");
const requirements = path.join(ROOT, "python", "requirements-rapid.txt");
run(uv
  ? ["uv", "pip", "install", "--python", environmentPython, "-r", requirements]
  : [environmentPython, "-m", "pip", "install", "-r", requirements]);
const health = spawnSync(environmentPython, [path.join(ROOT, "python", "worker.py")], {
  input: '{"type":"init","contractVersion":1}\n{"type":"shutdown"}\n',
  encoding: "utf8",
  env: { ...process.env, BAOX_OCR_ENGINE: "rapidocr" },
});
if (health.status !== 0 || !health.stdout.includes('"type":"ready"')) {
  rmSync(temporary, { recursive: true, force: true });
  fail(`OCR runtime health check failed: ${health.stderr.trim()}`);
}
if (existsSync(TARGET)) rmSync(TARGET, { recursive: true });
renameSync(temporary, TARGET);
process.stdout.write(`${JSON.stringify({ status: "installed", python: path.join(TARGET, "bin", "python") })}\n`);

function findPython() {
  for (const executable of ["python3.11", "python3"]) {
    const result = spawnSync(executable, ["-c", "import sys; print('.'.join(map(str, sys.version_info[:2])))"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim() === "3.11") return executable;
  }
  return null;
}

function commandExists(command) {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function run(argv) {
  const result = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
  if (result.status !== 0) fail(`${argv[0]} exited with ${result.status}`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
