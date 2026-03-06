const { execSync } = require('child_process');

const regCommands = [
  `reg delete "HKCU\\Software\\Classes\\Directory\\shell\\ClaudeCorroboree" /f`,
  `reg delete "HKCU\\Software\\Classes\\Directory\\Background\\shell\\ClaudeCorroboree" /f`,
  `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\corroboree.cmd" /f`,
];

console.log('Removing Claude Corroboree shell integration...');
for (const cmd of regCommands) {
  try {
    execSync(cmd, { stdio: 'pipe' });
    console.log('  OK');
  } catch (e) {
    console.error('  SKIP:', e.message);
  }
}
console.log('Shell integration removed.');
