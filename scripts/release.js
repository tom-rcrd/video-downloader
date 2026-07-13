const { execSync, spawnSync } = require('child_process');

let token;
try {
  token = execSync('gh auth token', { encoding: 'utf8' }).trim();
} catch {
  console.error(
    "Impossible de recuperer un token via GitHub CLI.\n" +
    "Verifie que 'gh' est installe (winget install --id GitHub.cli) et que tu es connecte ('gh auth login')."
  );
  process.exit(1);
}

const result = spawnSync('npx', ['electron-builder', '--publish', 'always'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, GH_TOKEN: token },
});

process.exit(result.status ?? 1);
