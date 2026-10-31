const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.join(__dirname, "..");
const backend = spawn(process.execPath, [path.join(projectRoot, "server", "index.js")], {
  cwd: projectRoot,
  stdio: "inherit"
});

let frontend;
let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  if (frontend && frontend.exitCode === null) frontend.kill();
  if (backend.exitCode === null) backend.kill();
}

for (const child of [backend]) {
  child.once("error", (error) => {
    console.error(`Could not start ${child === backend ? "FoodBridge backend" : "Vite"}: ${error.message}`);
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
  console.log("FoodBridge API is ready. Starting the React development server...");
  frontend = spawn(process.execPath, [path.join(projectRoot, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1"], {
    cwd: projectRoot,
    stdio: "inherit"
  });
  frontend.once("error", (error) => {
    console.error(`Could not start Vite: ${error.message}`);
    stop(1);
  });
  frontend.once("exit", (code) => {
    if (!stopping) stop(code || 1);
  });
}).catch((error) => {
  console.error(error.message);
  stop(1);
});

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
