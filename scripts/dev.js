const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.join(__dirname, "..");
const backendDirectory = path.join(projectRoot, "backend");
const backend = spawn(process.execPath, [path.join(backendDirectory, "index.js")], {
  cwd: backendDirectory,
  stdio: "inherit"
});

const frontends = [];
let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  frontends.forEach((frontend) => {
    if (frontend.exitCode === null) frontend.kill();
  });
  if (backend.exitCode === null) backend.kill();
}

for (const child of [backend]) {
  child.once("error", (error) => {
    console.error(`Could not start FoodBridge backend: ${error.message}`);
    stop(1);
  });
  child.once("exit", (code) => {
    if (!stopping) {
      console.error(`FoodBridge backend exited${code === null ? "" : ` with code ${code}`}.`);
      stop(code || 1);
    }
  });
}

async function waitForBackend() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (backend.exitCode !== null) throw new Error("FoodBridge backend exited before becoming ready.");
    try {
      const response = await fetch("http://127.0.0.1:5173/api/v1/health");
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("FoodBridge backend did not become ready within 30 seconds. Check MongoDB and .env.");
}

waitForBackend().then(() => {
  if (stopping) return;
  console.log("FoodBridge API is ready. Starting frontend and Admin development servers...");
  const vite = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
  const apps = [
    { name: "FoodBridge frontend", directory: path.join(projectRoot, "frontend"), port: "5174" },
    { name: "FoodBridge Admin", directory: path.join(projectRoot, "Admin"), port: "5175" }
  ];
  apps.forEach(({ name, directory, port }) => {
    const frontend = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", port], {
      cwd: directory,
      stdio: "inherit"
    });
    frontends.push(frontend);
    frontend.once("error", (error) => {
      console.error(`Could not start ${name}: ${error.message}`);
      stop(1);
    });
    frontend.once("exit", (code) => {
      if (!stopping) {
        console.error(`${name} exited${code === null ? "" : ` with code ${code}`}.`);
        stop(code || 1);
      }
    });
  });
}).catch((error) => {
  console.error(error.message);
  stop(1);
});

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
