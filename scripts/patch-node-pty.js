// Patches node-pty's gyp files for Windows builds:
// 1. Fix .bat file paths (need .\ prefix in gyp shell context)
// 2. Disable Spectre mitigation (requires VS component most devs don't have)
const fs = require('fs');
const path = require('path');

const files = [
  path.join(__dirname, '..', 'node_modules', 'node-pty', 'binding.gyp'),
  path.join(__dirname, '..', 'node_modules', 'node-pty', 'deps', 'winpty', 'src', 'winpty.gyp'),
];

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/'SpectreMitigation': 'Spectre'/g, "'SpectreMitigation': 'false'");
  content = content.replace(/&& GetCommitHash\.bat/g, '&& .\\\\GetCommitHash.bat');
  content = content.replace(/&& UpdateGenVersion\.bat/g, '&& .\\\\UpdateGenVersion.bat');
  fs.writeFileSync(file, content);
}
console.log('node-pty patched for Windows build');
