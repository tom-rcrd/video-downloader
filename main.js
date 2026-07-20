const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

const YT_DLP_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'yt-dlp.exe')
  : path.join(__dirname, 'bin', 'yt-dlp.exe');
const SEARXNG_SETTINGS_TEMPLATE_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'searxng-settings.yml')
  : path.join(__dirname, 'resources', 'searxng-settings.yml');
const DEFAULT_DOWNLOAD_DIR = app.isPackaged
  ? path.join(app.getPath('videos'), 'akiHome Downloader')
  : path.join(__dirname, 'downloads');
const OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_SEARX_URL = 'http://localhost:8080/search';
const GENRE_LIST = ['Cinéma', 'Documentaire', 'Série', 'Animation', 'Musique', 'Sport', 'Actualités', 'Talk-show', 'Spectacle', 'Jeunesse'];
// yt-dlp ne montre une progression en % que pendant le téléchargement lui-même :
// avant (analyse, miniature) et après (fusion, métadonnées) il ne reste que ces
// lignes préfixées par tag, sans quoi la barre semble figée pendant plusieurs
// secondes alors que le travail continue bel et bien.
const DOWNLOAD_STAGE_LABELS = {
  youtube: 'Analyse de la vidéo...',
  info: 'Récupération des informations...',
  ThumbnailsConvertor: 'Conversion de la miniature...',
  Merger: 'Fusion audio/vidéo...',
  EmbedThumbnail: 'Intégration de la miniature...',
  Metadata: 'Intégration des métadonnées...',
  ExtractAudio: 'Conversion audio...',
  VideoRemuxer: 'Finalisation du fichier...',
  MoveFiles: 'Finalisation...',
};
const DOCKER_DESKTOP_PATH = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
const OLLAMA_APP_PATH = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama app.exe');
const SEARXNG_CONTAINER_NAME = 'searxng';
const DOCKER_DOWNLOAD_URL = 'https://www.docker.com/products/docker-desktop/';
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';
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

async function ollamaChat(model, prompt, signal, options = {}) {
  const signals = [AbortSignal.timeout(60000)];
  if (signal) signals.push(signal);
  const body = { model, prompt, stream: false };
  if (options.json) body.format = 'json';
  if (options.temperature !== undefined) body.options = { temperature: options.temperature };
  const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

// Beaucoup de sites (ARTE, INA...) sont des applications JS (React/Next.js) qui
// rendent tout leur contenu côté client : un simple fetch() ne récupère que la
// coquille vide de la page. On la rend donc dans une vraie fenêtre Chromium
// cachée puis on lit le texte affiché, comme le ferait un visiteur humain.
async function fetchPageText(url, signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const onAbort = () => {
    if (!win.isDestroyed()) win.destroy();
  };
  signal?.addEventListener('abort', onAbort);

  try {
    win.webContents.setUserAgent(BROWSER_USER_AGENT);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('La page source a mis trop de temps à charger.')), 15000);
    });
    await Promise.race([win.loadURL(url), timeoutPromise]);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Laisse le temps aux pages type SPA de s'hydrater et d'afficher leur contenu.
    await new Promise((r) => setTimeout(r, 2000));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const text = await win.webContents.executeJavaScript('document.body.innerText');
    return String(text || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 6000);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.error('fetchPageText a échoué:', err.message || err);
    throw new Error('Impossible de récupérer la page source.');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!win.isDestroyed()) win.destroy();
  }
}

function getTextParagraphs(text) {
  // Sur certains sites, un bandeau cookies + un fil d'ariane + un texte court
  // ("Cet article date de...") ne sont séparés que par de simples retours à la
  // ligne, pas une ligne vide : découper uniquement sur les lignes vides les
  // fait fusionner avec le vrai synopsis qui suit dans le même bloc "candidat".
  // On découpe donc sur CHAQUE retour à la ligne - les lignes courtes de menu
  // sont éliminées par le filtre de longueur, les vrais paragraphes de prose ne
  // contiennent généralement pas de retour à la ligne interne et restent entiers.
  return String(text || '')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 80 && /[.!?]/.test(p))
    .slice(0, 20);
}

// Le LLM est peu fiable pour RECOPIER le synopsis mot pour mot (résumés
// inventés, copies tronquées ou trop larges, JSON cassé par des guillemets
// internes). En revanche, lui faire CHOISIR lequel des paragraphes de la page
// est le synopsis est une tâche de classification, bien plus fiable - et le
// texte renvoyé vient alors toujours mot pour mot de la page elle-même,
// jamais retapé par l'IA. Fonctionne sur n'importe quel site, pas que ARTE.
async function pickSynopsisParagraph(pageText, model, signal) {
  const paragraphs = getTextParagraphs(pageText);
  if (paragraphs.length === 0) return null;
  if (paragraphs.length === 1) return paragraphs[0];

  const listText = paragraphs
    .map((p, i) => `${i + 1}. [${p.length} caractères] ${p.slice(0, 300)}${p.length > 300 ? '…' : ''}`)
    .join('\n\n');
  const prompt = `Voici une liste numérotée d'extraits de texte trouvés sur une page web qui présente une vidéo/émission (la longueur totale en caractères de chaque extrait est indiquée entre crochets) :\n\n${listText}\n\nQuel numéro correspond au synopsis/résumé de cette vidéo/émission, c'est-à-dire le texte qui décrit son histoire ou son sujet ? Ce n'est ni un menu, ni une légende, ni un texte sur un tout autre sujet (ex: biographie d'un présentateur, mentions légales, autre article recommandé). S'il y a plusieurs extraits qui parlent du même sujet (un résumé court ET un résumé plus détaillé), choisis celui qui a le PLUS GRAND NOMBRE DE CARACTÈRES indiqué entre crochets. Si aucun extrait ne correspond à un synopsis, réponds 0.\n\nRéponds uniquement par le numéro, rien d'autre.`;

  const raw = await ollamaChat(model, prompt, signal, { temperature: 0 });
  const match = raw.match(/\d+/);
  const index = match ? parseInt(match[0], 10) : 0;
  return index >= 1 && index <= paragraphs.length ? paragraphs[index - 1] : null;
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

function execFileAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000, windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function isDockerReady() {
  try {
    await execFileAsync('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

// Fermer la fenêtre (comme un clic sur la croix) la cache sans quitter le
// programme ni arrêter son serveur - seulement fait quand c'est nous qui
// venons de le lancer, pour ne pas fermer une fenêtre que l'utilisateur avait
// déjà ouverte lui-même.
function hideAppWindow(processName) {
  execFile(
    'powershell.exe',
    ['-NoProfile', '-Command', `Get-Process "${processName}" -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() } | Out-Null`],
    { windowsHide: true },
    () => {}
  );
}

// Le conteneur a besoin du format JSON activé (désactivé par défaut sur l'image
// SearxNG), donc on lui fournit un settings.yml minimal (basé sur use_default_settings)
// avec un secret généré une seule fois par installation et réutilisé ensuite.
function getSearxngSettingsPath() {
  const generatedPath = path.join(app.getPath('userData'), 'searxng-settings.yml');
  if (!fs.existsSync(generatedPath)) {
    const template = fs.readFileSync(SEARXNG_SETTINGS_TEMPLATE_PATH, 'utf8');
    const secret = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(generatedPath, template.replace('__SECRET_KEY__', secret));
  }
  return generatedPath;
}

async function createSearxngContainer() {
  const settingsPath = getSearxngSettingsPath();
  await execFileAsync(
    'docker',
    [
      'run',
      '-d',
      '--name',
      SEARXNG_CONTAINER_NAME,
      '--restart',
      'unless-stopped',
      '-p',
      '8080:8080',
      '-v',
      `${settingsPath}:/etc/searxng/settings.yml:ro`,
      'searxng/searxng',
    ],
    { timeout: 5 * 60 * 1000 }
  );
}

// Docker Desktop ne démarre pas avec Windows et ne relance pas ses conteneurs
// automatiquement : on le lance nous-mêmes puis on redémarre le conteneur SearxNG
// utilisé par la fonctionnalité "cross-reference" avant que l'utilisateur en ait besoin.
async function ensureSearxngContainer(onStatus = () => {}) {
  if (process.platform !== 'win32') return;

  onStatus('Vérification de Docker...');
  if (!(await isDockerReady())) {
    if (!fs.existsSync(DOCKER_DESKTOP_PATH)) {
      onStatus("Docker Desktop n'est pas installé.", { showDownloadLink: true });
      return;
    }
    onStatus('Lancement de Docker Desktop...');
    try {
      spawn(DOCKER_DESKTOP_PATH, [], { detached: true, stdio: 'ignore' }).unref();
    } catch (err) {
      console.error('Impossible de lancer Docker Desktop:', err);
      onStatus('Impossible de lancer Docker Desktop.', { showDownloadLink: true });
      return;
    }

    onStatus('En attente du démarrage de Docker...');
    const deadline = Date.now() + 90000;
    let ready = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      ready = await isDockerReady();
      if (ready) break;
    }
    if (!ready) {
      console.error('Docker Desktop ne répond pas après 90s.');
      onStatus('Docker met trop de temps à démarrer, réessaie plus tard.', { showDownloadLink: true });
      return;
    }
    // Laisse le temps au Dashboard de finir de s'afficher avant d'essayer de le fermer.
    setTimeout(() => hideAppWindow('Docker Desktop'), 2000);
  }

  onStatus('Démarrage du moteur de recherche...');
  try {
    await execFileAsync('docker', ['start', SEARXNG_CONTAINER_NAME]);
    onStatus('Prêt !', { ready: true });
    return;
  } catch (err) {
    const containerMissing = /No such container/i.test(err.stderr || err.message || '');
    if (!containerMissing) {
      console.error(`Impossible de démarrer le conteneur "${SEARXNG_CONTAINER_NAME}":`, err.message || err);
      onStatus('Le service de recherche est indisponible.');
      return;
    }
  }

  // Premier lancement : le conteneur n'existe pas encore et l'image doit être
  // téléchargée (peut prendre plusieurs minutes). On ne bloque pas le démarrage
  // de l'app pour ça : la fenêtre principale s'ouvre tout de suite et la bannière
  // Docker se met à jour en direct quand l'installation se termine.
  onStatus("Installation du moteur de recherche en arrière-plan (première utilisation)...");
  createSearxngContainer()
    .then(() => onStatus('Prêt !', { ready: true }))
    .catch((err) => {
      console.error('Impossible de créer le conteneur SearxNG:', err.stderr || err.message || err);
      onStatus("Impossible d'installer le service de recherche.");
    });
}

async function isOllamaReady() {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Contrairement à Docker Desktop, Ollama n'a pas besoin de VM/WSL et démarre en
// quelques secondes : on peut se permettre d'attendre avant d'ouvrir la fenêtre.
async function ensureOllamaRunning(onStatus = () => {}) {
  if (process.platform !== 'win32') return;

  onStatus("Vérification d'Ollama...");
  if (await isOllamaReady()) return;

  if (!fs.existsSync(OLLAMA_APP_PATH)) {
    console.error("Ollama n'est pas installé.");
    onStatus("Ollama n'est pas installé.");
    return;
  }

  onStatus("Lancement d'Ollama...");
  try {
    spawn(OLLAMA_APP_PATH, [], { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    console.error('Impossible de lancer Ollama:', err);
    onStatus("Impossible de lancer Ollama.");
    return;
  }
  setTimeout(() => hideAppWindow('ollama app'), 2000);

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    if (await isOllamaReady()) return;
  }
  console.error('Ollama ne répond pas après 20s.');
  onStatus('Ollama ne répond pas.');
}

let splashWindow;

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    resizable: false,
    show: false,
    center: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-splash.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWindow.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow.show());
}

let splashShowedDownloadLink = false;
let latestDockerStatus = { message: '', ready: false, showDownloadLink: false };

function broadcastDockerStatus(message, options = {}) {
  latestDockerStatus = { message, ready: false, showDownloadLink: false, ...options };
  if (options.showDownloadLink) splashShowedDownloadLink = true;
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('docker-status', { message, ...options });
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('docker-status', { message, ...options });
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

app.whenReady().then(async () => {
  if (!fs.existsSync(DEFAULT_DOWNLOAD_DIR)) {
    fs.mkdirSync(DEFAULT_DOWNLOAD_DIR, { recursive: true });
  }
  categoriesFile = path.join(app.getPath('userData'), 'categories.json');
  settingsFile = path.join(app.getPath('userData'), 'settings.json');

  createSplashWindow();

  const splashStart = Date.now();
  await ensureSearxngContainer(broadcastDockerStatus).catch((err) => {
    console.error('Démarrage automatique de SearxNG échoué:', err);
  });
  // On laisse le temps de lire (et cliquer) le message Docker avant de passer à
  // la vérification d'Ollama, qui réutilise la même ligne de statut de la splash.
  const dockerMinSplashTime = splashShowedDownloadLink ? 5000 : 600;
  const dockerRemaining = dockerMinSplashTime - (Date.now() - splashStart);
  if (dockerRemaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, dockerRemaining));
  }

  await ensureOllamaRunning((message) => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.send('docker-status', { message });
    }
  }).catch((err) => {
    console.error("Démarrage automatique d'Ollama échoué:", err);
  });

  createWindow();
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  splashWindow = null;

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

// yt-dlp a besoin d'exécuter du JS pour déchiffrer certaines vidéos YouTube
// (sinon "403 Forbidden" sur ces vidéos précises). Le Node.js intégré à
// Electron est détecté mais jugé incompatible par yt-dlp : on cherche donc un
// vrai Node.js installé sur le système, si disponible.
let nodeJsPathPromise;
function findSystemNodeJs() {
  if (!nodeJsPathPromise) {
    nodeJsPathPromise = (async () => {
      const candidates = [];
      if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'));
      if (process.env['ProgramFiles(x86)']) candidates.push(path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe'));
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
      }
      try {
        const { stdout } = await execFileAsync('where', ['node']);
        const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        if (first && fs.existsSync(first)) return first;
      } catch {
        // Pas de Node.js système disponible.
      }
      return null;
    })();
  }
  return nodeJsPathPromise;
}

async function getYtDlpJsRuntimeArgs() {
  const nodePath = await findSystemNodeJs();
  return nodePath ? ['--js-runtimes', `node:${nodePath}`] : [];
}

ipcMain.handle('analyze', async (_event, url) => {
  if (!isValidUrl(url)) {
    throw new Error('Lien invalide.');
  }

  const jsRuntimeArgs = await getYtDlpJsRuntimeArgs();
  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP_PATH, [...jsRuntimeArgs, '-j', '--no-playlist', url]);
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
  const genres = (overrides && overrides.genres)
    ? overrides.genres.split(',').map((g) => g.trim()).filter(Boolean)
    : (categoryName ? [categoryName] : (Array.isArray(info.categories) ? info.categories : []));

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

let cancelCurrentDownload = null;

ipcMain.on('cancel-download', () => {
  cancelCurrentDownload?.();
});

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
    ...(await getYtDlpJsRuntimeArgs()),
    '--no-playlist',
    '--newline',
    // --print met yt-dlp en mode "sortie silencieuse" par défaut (il ne montre
    // plus que la valeur imprimée) : sans --progress, toute la progression du
    // téléchargement disparaît, alors même que celui-ci se déroule normalement.
    '--progress',
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
    let cancelled = false;
    let lastProgressAt = 0;

    cancelCurrentDownload = () => {
      cancelled = true;
      // yt-dlp.exe relance un sous-processus pour le téléchargement réel : le tuer
      // seul (child.kill()) laisse ce sous-processus continuer en arrière-plan.
      // /T tue tout l'arbre de processus.
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    };

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
          const percent = parseFloat(percentMatch[1]);
          // Beaucoup de lignes de progression peuvent arriver en quelques millisecondes
          // (petits fichiers, bonne connexion) : sans limiter la fréquence, les mises à
          // jour de la barre s'accumulent plus vite que le rendu ne peut en afficher, et
          // elle semble figée jusqu'à la toute dernière (100%).
          const now = Date.now();
          if (percent < 100 && now - lastProgressAt < 200) continue;
          lastProgressAt = now;
          const speedMatch = line.match(/at\s+([\d.]+\w+\/s)/);
          const etaMatch = line.match(/ETA\s+([\d:]+)/);
          event.sender.send('download-progress', {
            percent,
            speed: speedMatch ? speedMatch[1] : null,
            eta: etaMatch ? etaMatch[1] : null,
          });
          continue;
        }
        const stageMatch = line.match(/^\[(\w+)\]/);
        if (stageMatch) {
          event.sender.send('download-progress', {
            stage: DOWNLOAD_STAGE_LABELS[stageMatch[1]] || 'Traitement en cours...',
          });
        }
      }
    });

    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);

    child.on('close', async (code) => {
      cancelCurrentDownload = null;
      if (cancelled) {
        reject(new Error('Téléchargement annulé.'));
        return;
      }
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
      if (Notification.isSupported()) {
        const name = finalFilePath
          ? path.basename(finalFilePath, path.extname(finalFilePath))
          : 'Téléchargement';
        new Notification({ title: 'Téléchargement terminé', body: name }).show();
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

ipcMain.on('open-docker-download', () => {
  shell.openExternal(DOCKER_DOWNLOAD_URL);
});

ipcMain.on('open-ollama-download', () => {
  shell.openExternal(OLLAMA_DOWNLOAD_URL);
});

ipcMain.handle('get-docker-status', () => latestDockerStatus);

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

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

let crossRefAbortController = null;

ipcMain.on('cancel-cross-reference', () => {
  crossRefAbortController?.abort();
});

// La description de la vidéo elle-même contient souvent déjà le réalisateur, le
// pays, l'année et le genre (ex: "Documentaire de Léo Favier (France, 2022,
// 1h22mn)") : pas besoin d'attendre une recherche de source alternative pour
// les récupérer, l'IA peut les repérer directement dans le texte fourni par
// yt-dlp au moment de l'analyse.
ipcMain.handle('extract-video-metadata', async (_event, { title, description }) => {
  const { ollamaModel } = readSettings();
  if (!ollamaModel || !description) return null;

  try {
    const genreList = GENRE_LIST.join(', ');
    const prompt = `Voici le titre et la description d'une vidéo YouTube :\n\nTitre : ${title}\n\nDescription :\n${description}\n\nExtrait de cette description les informations suivantes si elles sont présentes, et RÉPONDS UNIQUEMENT avec un objet JSON (rien d'autre, pas de markdown) au format exact :\n{"director": "réalisateur/réalisatrice ou null", "year": "année de production ou null", "country": "nationalité/pays de production ou null", "production": "société de production ou null", "presenter": "présentateur/animateur ou null", "genres": "genres ou null"}\n\nCe type de description contient souvent une ligne de crédits compacte, par exemple :\n"Documentaire de Léo Favier (France, 2022, 1h22mn)"\nCe fragment donnerait : {"director": "Léo Favier", "year": "2022", "country": "France", "genres": "Documentaire", ...} (le mot avant "de", ici "Documentaire", est aussi un indice de genre).\n\nRègles importantes :\n- N'invente ni ne devine aucune information : utilise null si un champ n'est pas présent dans le texte.\n- Pour "genres" : choisis UNIQUEMENT parmi cette liste fixe, en reprenant l'orthographe exacte : ${genreList}. Si aucun ne correspond, utilise null.`;
    const raw = await ollamaChat(ollamaModel, prompt, null, { json: true, temperature: 0 });
    return parseJsonLoose(raw);
  } catch (err) {
    console.error('Extraction des métadonnées depuis la description échouée:', err);
    return null;
  }
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

    // On demande l'URL choisie plutôt qu'un numéro : avec un numéro, on a déjà vu
    // le modèle donner un raisonnement correct ("...c'est sur Arte.tv...") mais
    // répondre un chiffre qui pointe vers un tout autre résultat - le chiffre se
    // découple de son propre raisonnement. En répondant directement l'URL, il n'y
    // a plus d'indirection dans laquelle se tromper.
    const matchPrompt = `Voici les infos d'une vidéo YouTube :\nTitre : ${title}\nChaîne : ${uploader}\nDescription (extrait) : ${(description || '').slice(0, 500)}\n\nVoici une liste de résultats de recherche web pour cette vidéo (la vidéo elle-même a été retirée de la liste) :\n\n${resultsText}\n\nQuel résultat correspond à une version officielle de CETTE MÊME vidéo/émission disponible ailleurs (ex: rediffusion par un diffuseur comme ARTE, une institution comme l'INA) ? Attention : un article de presse qui PARLE de la vidéo/émission (critique, actualité) n'est PAS une version officielle de la vidéo elle-même, même s'il en parle en détail - ignore ce genre de résultat. Priorise la correspondance du TITRE et du NOM DE DOMAINE de l'URL : ce sont les signaux les plus fiables. Le champ "extrait" peut être imprécis ou tronqué, ne t'y fie pas exclusivement.\n\nRéponds en français sur exactement 3 lignes, dans cet ordre :\nURL: <l'URL EXACTE du résultat choisi, copiée telle quelle depuis la liste ci-dessus, ou "aucune" si aucun résultat ne correspond de manière fiable>\nConfiance: <faible|moyen|eleve>\nNote: <courte explication>`;

    const matchRaw = await ollamaChat(ollamaModel, matchPrompt, signal, { temperature: 0 });
    const urlMatch = matchRaw.match(/URL\s*:\s*(\S+)/i);
    const confianceMatch = matchRaw.match(/Confiance\s*:\s*(\w+)/i);
    const noteMatch = matchRaw.match(/Note\s*:\s*(.*)/i);
    const rawUrl = urlMatch ? urlMatch[1].trim().replace(/[.,;]+$/, '') : '';
    const note = noteMatch ? noteMatch[1].trim() : '';

    const matchedResult = /^aucune?$/i.test(rawUrl)
      ? null
      : results.find((r) => r.url === rawUrl) || results.find((r) => r.url.startsWith(rawUrl) || rawUrl.startsWith(r.url));

    if (!matchedResult) {
      return { matched: false, note: note || 'Aucune source officielle fiable trouvee.' };
    }

    const confidence = confianceMatch ? confianceMatch[1].toLowerCase() : 'faible';

    let fields = null;
    try {
      const pageText = await fetchPageText(matchedResult.url, signal);
      const synopsis = await pickSynopsisParagraph(pageText, ollamaModel, signal);

      const genreList = GENRE_LIST.join(', ');
      const metaPrompt = `Voici le texte affiché sur une page web qui présente une vidéo/émission :\n\n${pageText}\n\nExtrait de cette page les informations suivantes si elles sont présentes, et RÉPONDS UNIQUEMENT avec un objet JSON (rien d'autre, pas de markdown) au format exact :\n{"director": "réalisateur/réalisatrice ou null", "year": "année de production ou null", "country": "nationalité/pays de production ou null", "production": "société de production ou null", "presenter": "présentateur/animateur ou null", "genres": "genres ou null"}\n\nSur ce type de page, les informations techniques apparaissent souvent sous forme de courtes lignes juxtaposées, par exemple :\nRéalisation\n\nLéo Favier\n\nPays\n\nFrance\n\nAnnée\n\n2024\n\nCe fragment donnerait : {"director": "Léo Favier", "year": "2024", "country": "France", ...}. Cherche ce genre de motif "libellé" suivi de sa "valeur" dans TOUT le texte fourni, y compris vers la fin.\n\nRègles importantes :\n- N'invente ni ne devine aucune information : utilise null si un champ n'est pas présent dans le texte.\n- Le mot "réalisation" utilisé dans une phrase (ex: "la réalisation de tel film") n'est PAS un nom de réalisateur, ignore-le pour le champ "director".\n- Pour "genres" : la page mentionne souvent un ou plusieurs genres/catégories (ex: près du titre, dans un fil d'ariane, ou une liste de tags). Choisis UNIQUEMENT parmi cette liste fixe, en reprenant l'orthographe exacte : ${genreList}. Ignore tout terme qui n'est pas dans cette liste (ex: un nom de collection ou de strand éditorial comme "Les grands du 7e art" n'est pas un genre, ignore-le). Si plusieurs genres de la liste correspondent, sépare-les par une virgule. Si aucun ne correspond, utilise null.`;
      const metaRaw = await ollamaChat(ollamaModel, metaPrompt, signal, { json: true, temperature: 0 });
      const meta = parseJsonLoose(metaRaw) || {};
      fields = { ...meta, synopsis };
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
