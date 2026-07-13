import { _electron as electron } from 'playwright-core';

const APP_DIR = 'c:\\Users\\akiO\\Desktop\\Video downloader';

const app = await electron.launch({ args: [APP_DIR], timeout: 30000 });
await new Promise((r) => setTimeout(r, 2000));
const page = await app.firstWindow();
page.on('pageerror', (err) => console.log('pageerror:', err.message));

await page.waitForTimeout(1000);
const status = await page.evaluate(() => document.getElementById('ollama-status').textContent);
console.log('ollama status:', status);
const checkboxState = await page.evaluate(() => ({
  disabled: document.getElementById('ai-cleanup-checkbox').disabled,
  checked: document.getElementById('ai-cleanup-checkbox').checked,
}));
console.log('ai-cleanup checkbox:', checkboxState);

// Analyze
await page.fill('#url-input', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
await page.click('#analyze-btn');
await page.waitForSelector('#preview:not(.hidden)', { timeout: 20000 });
const crossRefVisible = await page.evaluate(() => !document.getElementById('cross-ref-section').classList.contains('hidden'));
console.log('cross-ref section visible:', crossRefVisible);

// Cross-reference search (real Ollama + real SearxNG)
console.log('--- clicking cross-ref button, this may take up to ~60s (search + local LLM) ---');
await page.click('#cross-ref-btn');
await page.waitForTimeout(2000);
let crossRefText = '';
for (let i = 0; i < 30; i++) {
  crossRefText = await page.evaluate(() => document.getElementById('cross-ref-text').textContent);
  if (crossRefText && crossRefText !== 'Recherche en cours...') break;
  await page.waitForTimeout(2000);
}
console.log('cross-ref result:', crossRefText);

// Download with AI cleanup enabled (audio preset for speed)
await page.selectOption('#quality-select', 'audio');
console.log('--- starting download with AI description cleanup enabled ---');
await page.click('#download-btn');
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  const done = await page.evaluate(() => !document.getElementById('done-section').classList.contains('hidden'));
  const error = await page.evaluate(() => {
    const el = document.getElementById('error-msg');
    return el && !el.classList.contains('hidden') ? el.textContent : null;
  });
  if (done || error) { console.log('download -> done:', done, 'error:', error); break; }
}

await app.close();
