/**
 * MCP Server Runner
 * 
 * This script provides a convenient way to start the MCP server
 * directly from Cursor via the run_terminal_cmd tool.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Setup logging to file
const logFile = path.join(__dirname, 'server.log');

// Custom log function that writes to file and console
function log(message) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
  console.log(message);
}

// Ensure we're in the right directory
const serverDir = __dirname;
const packageJsonPath = path.join(serverDir, 'package.json');

if (!fs.existsSync(packageJsonPath)) {
  log('Error: package.json not found. Make sure to run this script from the mcp-server directory.');
  process.exit(1);
}

// Check if node_modules exists, install dependencies if not
const nodeModulesPath = path.join(serverDir, 'node_modules');
if (!fs.existsSync(nodeModulesPath)) {
  log('Node modules not found. Installing dependencies...');
  
  // Run npm install
  const npmInstall = spawn('npm', ['install'], {
    cwd: serverDir,
    stdio: 'inherit',
    shell: true
  });
  
  npmInstall.on('close', (code) => {
    if (code !== 0) {
      log(`npm install failed with code ${code}`);
      process.exit(1);
    } else {
      log('Dependencies installed successfully.');
      startServer();
    }
  });
} else {
  startServer();
}

function startServer() {
  // Creates the data directory if it doesn't exist
  const dataDir = path.join(serverDir, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
  }
  
  log('Starting MCP Server...');
  
  // Start the server using npm run dev (with nodemon for auto-restart)
  const server = spawn('npm', ['run', 'dev'], {
    cwd: serverDir,
    stdio: 'inherit',
    shell: true
  });
  
  server.on('close', (code) => {
    if (code !== 0) {
      log(`Server process exited with code ${code}`);
    }
  });
  
  // Handle process termination signals
  const signals = ['SIGINT', 'SIGTERM'];
  signals.forEach(signal => {
    process.on(signal, () => {
      log(`Received ${signal}, shutting down MCP server...`);
      server.kill(signal);
      process.exit(0);
    });
  });
} 