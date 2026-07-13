const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

const YT_DLP_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'yt-dlp.exe')
  : path.join(__dirname, 'bin', 'yt-dlp.exe');
const DEFAULT_DOWNLOAD_DIR = app.isPackaged
  ? path.join(app.getPath('videos'), 'akiHome Downloader')
  : path.join(__dirname, 'downloads');
const OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_SEARX_URL = 'http://localhost:8080/search';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

let mainWindow;
let categoriesFile;
let settingsFile;

function readCategories() {
  try {
    return JSON.parse(fs.readFileSync(categoriesFile, 'utf8'));
  } catch {
    return [];
  }
}

function writeCategories(categories) {
  fs.writeFileSync(categoriesFile, JSON.stringify(categories, null, 2));
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return { ollamaModel: '', searxUrl: DEFAULT_SEARX_URL };
  }
}

function writeSettings(settings) {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

async function listOllamaModels() {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.models) ? data.models.map((m) => m.name) : [];
  } catch {
    return [];
  }
}

async function ollamaChat(model, prompt, signal) {
  const signals = [AbortSignal.timeout(60000)];
  if (signal) signals.push(signal);
  const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
    signal: AbortSignal.any(signals),
  });
  if (!res.ok) {
    throw new Error(`Ollama a renvoyé une erreur (${res.status}). Vérifie que le modèle "${model}" est bien installé.`);
  }
  const data = await res.json();
  return (data.response || '').trim();
}

async function searxSearch(query, searxUrl, signal) {
  const url = `${searxUrl || DEFAULT_SEARX_URL}?q=${encodeURIComponent(query)}&format=json`;
  const signals = [AbortSignal.timeout(8000)];
  if (signal) signals.push(signal);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_USER_AGENT },
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (err.name === 'AbortError' && signal?.aborted) throw err;
    throw new Error("Impossible de contacter l'instance SearxNG. Vérifie qu'elle tourne (docker) et que l'URL est correcte dans les réglages.");
  }
  if (!res.ok) {
    throw new Error(`L'instance SearxNG a refuse la requete (${res.status}). Verifie que le format JSON est active dans settings.yml.`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("Réponse SearxNG illisible (format JSON peut-être désactivé sur cette instance).");
  }
  const results = Array.isArray(data.results) ? data.results : [];
  return results.slice(0, 5).map((r) => ({ title: r.title, url: r.url, content: r.content }));
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPageText(url, signal) {
  const signals = [AbortSignal.timeout(10000)];
  if (signal) signals.push(signal);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_USER_AGENT },
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (err.name === 'AbortError' && signal?.aborted) throw err;
    throw new Error('Impossible de récupérer la page source.');
  }
  if (!res.ok) {
    throw new Error(`La page source a renvoye une erreur (${res.status}).`);
  }
  const html = await res.text();
  return stripHtml(html).slice(0, 6000);
}

function parseJsonLoose(text) {
  const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 480,
    minHeight: 420,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  if (!fs.existsSync(DEFAULT_DOWNLOAD_DIR)) {
    fs.mkdirSync(DEFAULT_DOWNLOAD_DIR, { recursive: true });
  }
  categoriesFile = path.join(app.getPath('userData'), 'categories.json');
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  createWindow();

  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Vérification des mises à jour échouée:', err);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

autoUpdater.on('update-available', (info) => {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Mise à jour disponible',
    message: `La version ${info.version} est disponible.`,
    detail: 'Veux-tu la télécharger maintenant ?',
    buttons: ['Télécharger', 'Plus tard'],
    defaultId: 0,
    cancelId: 1,
  }).then((result) => {
    if (result.response === 0) autoUpdater.downloadUpdate();
  });
});

autoUpdater.on('update-downloaded', (info) => {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Mise à jour prête',
    message: `La version ${info.version} a été téléchargée.`,
    detail: "Redémarrer l'application maintenant pour l'installer ?",
    buttons: ['Redémarrer', 'Plus tard'],
    defaultId: 0,
    cancelId: 1,
  }).then((result) => {
    if (result.response === 0) autoUpdater.quitAndInstall();
  });
});

autoUpdater.on('error', (err) => {
  console.error('Erreur de mise à jour automatique:', err);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

ipcMain.handle('analyze', async (_event, url) => {
  if (!isValidUrl(url)) {
    throw new Error('Lien invalide.');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP_PATH, ['-j', '--no-playlist', url]);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp a échoué (code ${code}).`));
        return;
      }
      try {
        const info = JSON.parse(stdout.trim().split('\n')[0]);
        resolve({
          title: info.title,
          thumbnail: info.thumbnail,
          duration: info.duration,
          uploader: info.uploader || info.channel || '',
          description: info.description || '',
          year: (info.upload_date || '').slice(0, 4) || null,
          categories: Array.isArray(info.categories) ? info.categories : [],
          tags: Array.isArray(info.tags) ? info.tags.slice(0, 10) : [],
        });
      } catch {
        reject(new Error("Impossible d'analyser la réponse de yt-dlp."));
      }
    });
  });
});

const QUALITY_PRESETS = {
  best: { format: 'bv*+ba/b', mergeFormat: 'mp4' },
  '1080p': { format: 'bv*[height<=1080]+ba/b[height<=1080]/b[height<=1080]', mergeFormat: 'mp4' },
  '720p': { format: 'bv*[height<=720]+ba/b[height<=720]/b[height<=720]', mergeFormat: 'mp4' },
  '480p': { format: 'bv*[height<=480]+ba/b[height<=480]/b[height<=480]', mergeFormat: 'mp4' },
  audio: { format: 'ba/b', audioOnly: true },
};

const FILEPATH_MARKER = 'JDL_FILEPATH::';

function escapeXml(str) {
  return String(str ?? '').replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]));
}

function buildNfo(info, categoryName, overrides) {
  const uploadDate = info.upload_date || '';
  const year = (overrides && overrides.year) || uploadDate.slice(0, 4);
  const premiered = uploadDate.length === 8
    ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`
    : '';
  const plot = (overrides && overrides.synopsis) || info.description;
  const studio = (overrides && overrides.production) || info.uploader || info.channel;
  const runtimeMin = info.duration ? Math.round(info.duration / 60) : null;
  const tags = Array.isArray(info.tags) ? info.tags.slice(0, 20) : [];
  const genres = categoryName ? [categoryName] : (Array.isArray(info.categories) ? info.categories : []);

  const lines = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<movie>'];
  lines.push(`  <title>${escapeXml(info.title)}</title>`);
  lines.push(`  <originaltitle>${escapeXml(info.title)}</originaltitle>`);
  if (plot) lines.push(`  <plot>${escapeXml(plot)}</plot>`);
  if (year) lines.push(`  <year>${year}</year>`);
  if (premiered) lines.push(`  <premiered>${premiered}</premiered>`);
  if (runtimeMin) lines.push(`  <runtime>${runtimeMin}</runtime>`);
  if (overrides && overrides.director) lines.push(`  <director>${escapeXml(overrides.director)}</director>`);
  if (overrides && overrides.country) lines.push(`  <country>${escapeXml(overrides.country)}</country>`);
  for (const g of genres) lines.push(`  <genre>${escapeXml(g)}</genre>`);
  for (const t of tags) lines.push(`  <tag>${escapeXml(t)}</tag>`);
  if (studio) lines.push(`  <studio>${escapeXml(studio)}</studio>`);
  if (overrides && overrides.presenter) {
    lines.push('  <actor>');
    lines.push(`    <name>${escapeXml(overrides.presenter)}</name>`);
    lines.push('    <role>Présentateur</role>');
    lines.push('  </actor>');
  }
  if (info.id) lines.push(`  <uniqueid type="youtube" default="true">${escapeXml(info.id)}</uniqueid>`);
  lines.push('</movie>');
  return lines.join('\n');
}

async function cleanDescriptionWithAI(title, description) {
  const { ollamaModel } = readSettings();
  if (!ollamaModel || !description) return description;

  try {
    const prompt = `Voici le titre et la description brute d'une vidéo YouTube. Réécris une synopsis propre en français, en 2 à 4 phrases maximum. Garde uniquement le contenu qui décrit réellement la vidéo. Supprime les liens, les mentions de réseaux sociaux, les appels à s'abonner, le sponsoring et les hashtags. Réponds UNIQUEMENT avec la synopsis, sans introduction, sans commentaire, sans guillemets.\n\nTitre: ${title}\n\nDescription brute:\n${description}`;
    const cleaned = await ollamaChat(ollamaModel, prompt);
    return cleaned || description;
  } catch (err) {
    console.error('Nettoyage de description IA échoué:', err);
    return description;
  }
}

async function generateJellyfinMetadata(finalFilePath, isAudio, categoryName, overrides) {
  const dir = path.dirname(finalFilePath);
  const base = path.basename(finalFilePath, path.extname(finalFilePath));
  const infoJsonPath = path.join(dir, base + '.info.json');

  if (!fs.existsSync(infoJsonPath)) return;

  try {
    if (!isAudio) {
      const info = JSON.parse(fs.readFileSync(infoJsonPath, 'utf8'));
      fs.writeFileSync(path.join(dir, base + '.nfo'), buildNfo(info, categoryName, overrides));

      const thumbFile = fs.readdirSync(dir).find(
        (f) => f.startsWith(base + '.') && /\.(jpg|jpeg|png|webp)$/i.test(f)
      );
      if (thumbFile) {
        fs.renameSync(path.join(dir, thumbFile), path.join(dir, base + '-poster' + path.extname(thumbFile)));
      }
    }
  } finally {
    fs.unlinkSync(infoJsonPath);
  }
}

ipcMain.handle('download', async (event, { url, quality, destFolder, category, overrides }) => {
  if (!isValidUrl(url)) {
    throw new Error('Lien invalide.');
  }
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.best;
  const outputDir = destFolder || DEFAULT_DOWNLOAD_DIR;
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const args = [
    '--no-playlist',
    '--newline',
    '-f', preset.format,
    '-o', path.join(outputDir, '%(title)s.%(ext)s'),
    '--write-info-json',
    '--embed-metadata',
    '--parse-metadata', '%(uploader)s:%(meta_artist)s',
    '--print', `after_move:${FILEPATH_MARKER}%(filepath)s`,
  ];

  if (preset.mergeFormat) {
    args.push('--merge-output-format', preset.mergeFormat);
  }
  if (preset.audioOnly) {
    args.push('-x', '--audio-format', 'mp3', '--embed-thumbnail');
  } else {
    args.push('--embed-thumbnail', '--write-thumbnail', '--convert-thumbnails', 'jpg');
  }

  args.push(url);

  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP_PATH, args);
    let stderr = '';
    let lastLine = '';
    let finalFilePath = null;

    child.stdout.on('data', (data) => {
      const lines = data.toString().split(/\r|\n/).filter(Boolean);
      for (const line of lines) {
        lastLine = line;
        if (line.includes(FILEPATH_MARKER)) {
          finalFilePath = line.slice(line.indexOf(FILEPATH_MARKER) + FILEPATH_MARKER.length).trim();
          continue;
        }
        const percentMatch = line.match(/\[download\]\s+([\d.]+)%/);
        if (percentMatch) {
          const speedMatch = line.match(/at\s+([\d.]+\w+\/s)/);
          const etaMatch = line.match(/ETA\s+([\d:]+)/);
          event.sender.send('download-progress', {
            percent: parseFloat(percentMatch[1]),
            speed: speedMatch ? speedMatch[1] : null,
            eta: etaMatch ? etaMatch[1] : null,
          });
        }
      }
    });

    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);

    child.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || lastLine || `yt-dlp a échoué (code ${code}).`));
        return;
      }
      if (finalFilePath) {
        try {
          await generateJellyfinMetadata(finalFilePath, !!preset.audioOnly, category, overrides);
        } catch (err) {
          console.error('Génération des métadonnées Jellyfin échouée:', err);
        }
      }
      resolve({ outputDir });
    });
  });
});

ipcMain.handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: DEFAULT_DOWNLOAD_DIR,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('open-folder', async (_event, folderPath) => {
  await shell.openPath(folderPath || DEFAULT_DOWNLOAD_DIR);
});

ipcMain.handle('get-categories', async () => readCategories());

ipcMain.handle('save-category', async (_event, { name, folder }) => {
  const categories = readCategories();
  categories.push({ id: crypto.randomUUID(), name, folder });
  writeCategories(categories);
  return categories;
});

ipcMain.handle('delete-category', async (_event, id) => {
  const categories = readCategories().filter((c) => c.id !== id);
  writeCategories(categories);
  return categories;
});

ipcMain.handle('get-settings', async () => readSettings());

ipcMain.handle('save-settings', async (_event, settings) => {
  writeSettings(settings);
  return settings;
});

ipcMain.handle('list-ollama-models', async () => listOllamaModels());

ipcMain.handle('clean-description', async (_event, { title, description }) => {
  const { ollamaModel } = readSettings();
  if (!ollamaModel) {
    throw new Error('Aucun modèle Ollama configuré.');
  }
  return cleanDescriptionWithAI(title, description);
});

function extractYoutubeId(url) {
  const match = String(url || '').match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  return match ? match[1] : null;
}

let crossRefAbortController = null;

ipcMain.on('cancel-cross-reference', () => {
  crossRefAbortController?.abort();
});

ipcMain.handle('find-cross-reference', async (_event, { title, uploader, description, url }) => {
  const { ollamaModel, searxUrl } = readSettings();
  if (!ollamaModel) {
    throw new Error('Aucun modèle Ollama configuré.');
  }

  const abortController = new AbortController();
  crossRefAbortController = abortController;
  const { signal } = abortController;

  try {
    const query = `${title} ${uploader}`.trim();
    const sourceId = extractYoutubeId(url);
    const results = (await searxSearch(query, searxUrl, signal)).filter(
      (r) => !sourceId || extractYoutubeId(r.url) !== sourceId
    );

    if (results.length === 0) {
      return { matched: false, note: 'Aucun resultat de recherche trouve pour cette video.' };
    }

    const resultsText = results
      .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.content || ''}`)
      .join('\n\n');

    const matchPrompt = `Voici les infos d'une vidéo YouTube :\nTitre : ${title}\nChaîne : ${uploader}\nDescription (extrait) : ${(description || '').slice(0, 500)}\n\nVoici une liste numérotée de résultats de recherche web pour cette vidéo (la vidéo elle-même a été retirée de la liste) :\n\n${resultsText}\n\nQuel numéro de résultat correspond à une version officielle de CETTE MÊME vidéo/émission disponible ailleurs (ex: rediffusion par un diffuseur comme ARTE, une institution comme l'INA, ou un site de presse officiel) ? Priorise la correspondance du TITRE et du NOM DE DOMAINE de l'URL : ce sont les signaux les plus fiables. Le champ "extrait" peut être imprécis ou tronqué, ne t'y fie pas exclusivement. Si aucun numéro ne correspond de manière fiable, réponds 0.\n\nRéponds en français sur exactement 3 lignes, dans cet ordre :\nNumero: <chiffre>\nConfiance: <faible|moyen|eleve>\nNote: <courte explication>`;

    const matchRaw = await ollamaChat(ollamaModel, matchPrompt, signal);
    const numeroMatch = matchRaw.match(/Numero\s*:\s*(\d+)/i);
    const confianceMatch = matchRaw.match(/Confiance\s*:\s*(\w+)/i);
    const noteMatch = matchRaw.match(/Note\s*:\s*(.*)/i);
    const chosenIndex = numeroMatch ? parseInt(numeroMatch[1], 10) : 0;
    const note = noteMatch ? noteMatch[1].trim() : '';

    if (!chosenIndex || chosenIndex < 1 || chosenIndex > results.length) {
      return { matched: false, note: note || 'Aucune source officielle fiable trouvee.' };
    }

    const matchedResult = results[chosenIndex - 1];
    const confidence = confianceMatch ? confianceMatch[1].toLowerCase() : 'faible';

    let fields = null;
    try {
      const pageText = await fetchPageText(matchedResult.url, signal);
      const extractPrompt = `Voici le texte brut (nettoyé du HTML) d'une page web présentant une vidéo/émission :\n\n${pageText}\n\nExtrait de cette page les informations suivantes si elles sont présentes, et RÉPONDS UNIQUEMENT avec un objet JSON (rien d'autre, pas de markdown) au format exact :\n{"year": "année de production ou null", "director": "réalisateur/réalisatrice ou null", "production": "société de production ou null", "country": "nationalité/pays de production ou null", "presenter": "présentateur/animateur ou null", "synopsis": "synopsis complet en français ou null"}\n\nN'invente aucune information : utilise null si un champ n'est pas présent dans le texte.`;
      const extractRaw = await ollamaChat(ollamaModel, extractPrompt, signal);
      fields = parseJsonLoose(extractRaw);
    } catch (err) {
      if (signal.aborted) throw err;
      console.error('Extraction des métadonnées depuis la source échouée:', err);
    }

    return {
      matched: true,
      confidence,
      note,
      sourceUrl: matchedResult.url,
      sourceTitle: matchedResult.title || '',
      fields: fields || null,
    };
  } catch (err) {
    if (signal.aborted) {
      throw new Error('Recherche annulée.');
    }
    throw err;
  } finally {
    crossRefAbortController = null;
  }
});
