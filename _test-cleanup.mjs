import { _electron as electron } from 'playwright-core';

const APP_DIR = 'c:\\Users\\akiO\\Desktop\\Video downloader';

const app = await electron.launch({ args: [APP_DIR], timeout: 30000 });
await new Promise((r) => setTimeout(r, 2000));
const page = await app.firstWindow();
page.on('pageerror', (err) => console.log('pageerror:', err.message));

await page.fill('#url-input', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
await page.click('#analyze-btn');
await page.waitForSelector('#preview:not(.hidden)', { timeout: 20000 });

await page.selectOption('#quality-select', '480p'); // smaller/faster video download
const cleanupChecked = await page.evaluate(() => document.getElementById('ai-cleanup-checkbox').checked);
console.log('AI cleanup checkbox checked:', cleanupChecked);

console.log('--- downloading 480p video with AI cleanup, this includes an Ollama call, may take a bit ---');
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
