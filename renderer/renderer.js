const urlInput = document.getElementById('url-input');
const analyzeBtn = document.getElementById('analyze-btn');
const errorMsg = document.getElementById('error-msg');
const analyzeProgress = document.getElementById('analyze-progress');
const themeToggle = document.getElementById('theme-toggle');

const THEME_KEY = 'theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggle.textContent = theme === 'dark' ? 'Mode clair' : 'Mode sombre';
}

applyTheme(localStorage.getItem(THEME_KEY) || 'light');

themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

const preview = document.getElementById('preview');
const previewThumb = document.getElementById('preview-thumb');
const previewTitle = document.getElementById('preview-title');
const previewUploader = document.getElementById('preview-uploader');

const ficheSection = document.getElementById('fiche-section');
const ficheFieldsEl = document.getElementById('fiche-fields');

const options = document.getElementById('options');
const qualitySelectEl = document.getElementById('quality-select');
const qualitySelectTrigger = document.getElementById('quality-select-trigger');
const qualitySelectValue = document.getElementById('quality-select-value');
const qualitySelectMenu = document.getElementById('quality-select-menu');
const folderPathEl = document.getElementById('folder-path');
const chooseFolderBtn = document.getElementById('choose-folder-btn');
const downloadBtn = document.getElementById('download-btn');

const aiSettingsToggle = document.getElementById('ai-settings-toggle');
const aiSettingsPanel = document.getElementById('ai-settings-panel');
const ollamaModelSelect = document.getElementById('ollama-model-select');
const ollamaRefreshBtn = document.getElementById('ollama-refresh-btn');
const ollamaStatus = document.getElementById('ollama-status');
const searxUrlInput = document.getElementById('searx-url-input');
const aiSettingsSaveBtn = document.getElementById('ai-settings-save-btn');
const aiSettingsCloseBtn = document.getElementById('ai-settings-close-btn');

const crossRefSection = document.getElementById('cross-ref-section');
const crossRefBtn = document.getElementById('cross-ref-btn');
const applyAllBtn = document.getElementById('apply-all-btn');
const crossRefResult = document.getElementById('cross-ref-result');
const crossRefNote = document.getElementById('cross-ref-note');
const crossRefSource = document.getElementById('cross-ref-source');
const crossRefSourceLink = document.getElementById('cross-ref-source-link');
const crossRefLoadingOverlay = document.getElementById('cross-ref-loading-overlay');
const crossRefCancelBtn = document.getElementById('cross-ref-cancel-btn');

const EDITABLE_FIELDS = [
  { key: 'synopsis', label: 'Synopsis', multiline: true },
  { key: 'year', label: 'Année' },
  { key: 'director', label: 'Réalisateur' },
  { key: 'country', label: 'Nationalité' },
  { key: 'production', label: 'Studio / Production' },
  { key: 'presenter', label: 'Présentateur' },
];

const READONLY_FIELDS = [
  { key: 'duration', label: 'Durée' },
  { key: 'genres', label: 'Genres' },
  { key: 'tags', label: 'Tags' },
];

let ficheState = {};
let ficheReadonly = {};
let ficheSuggestions = {};
let ficheInputs = {};
let ficheSuggestionEls = {};

function createCollapsibleText(text) {
  const container = document.createElement('span');
  if (!text || text === '—') {
    container.textContent = '—';
    return container;
  }
  if (text.length <= 220) {
    container.textContent = text;
    return container;
  }
  const short = text.slice(0, 220).trim() + '…';
  const textEl = document.createElement('span');
  textEl.textContent = short;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'link-btn fiche-toggle';
  toggle.textContent = 'Voir plus ▾';
  let expanded = false;
  toggle.addEventListener('click', () => {
    expanded = !expanded;
    textEl.textContent = expanded ? text : short;
    toggle.textContent = expanded ? 'Voir moins ▴' : 'Voir plus ▾';
  });
  container.appendChild(textEl);
  container.appendChild(document.createElement('br'));
  container.appendChild(toggle);
  return container;
}

function renderFiche() {
  ficheFieldsEl.innerHTML = '';
  ficheInputs = {};
  ficheSuggestionEls = {};

  for (const field of EDITABLE_FIELDS) {
    const dt = document.createElement('dt');
    dt.textContent = field.label;

    const dd = document.createElement('dd');
    const input = document.createElement(field.multiline ? 'textarea' : 'input');
    if (!field.multiline) input.type = 'text';
    input.className = 'fiche-input';
    input.value = ficheState[field.key] || '';
    input.addEventListener('input', () => {
      ficheState[field.key] = input.value;
      input.classList.remove('applied');
    });
    ficheInputs[field.key] = input;
    dd.appendChild(input);

    if (field.key === 'synopsis') {
      const cleanBtn = document.createElement('button');
      cleanBtn.type = 'button';
      cleanBtn.className = 'link-btn fiche-clean-btn';
      cleanBtn.textContent = "Nettoyer avec l'IA";
      cleanBtn.disabled = !hasOllamaModel;
      cleanBtn.addEventListener('click', async () => {
        cleanBtn.disabled = true;
        cleanBtn.textContent = 'Nettoyage...';
        try {
          const cleaned = await window.api.cleanDescription({
            title: lastAnalyzedInfo.title,
            description: ficheState.synopsis,
          });
          ficheState.synopsis = cleaned;
          input.value = cleaned;
        } catch (err) {
          showError(err.message || 'Le nettoyage a échoué.');
        } finally {
          cleanBtn.disabled = !hasOllamaModel;
          cleanBtn.textContent = "Nettoyer avec l'IA";
        }
      });
      dd.appendChild(cleanBtn);
    }

    const suggestionEl = document.createElement('div');
    suggestionEl.className = 'fiche-suggestion hidden';
    const suggestionText = document.createElement('span');
    suggestionText.className = 'fiche-suggestion-text';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'primary subtle fiche-apply-btn';
    applyBtn.textContent = 'Appliquer';
    applyBtn.addEventListener('click', () => {
      const value = ficheSuggestions[field.key];
      if (value === undefined) return;
      ficheState[field.key] = value;
      input.value = value;
      input.classList.add('applied');
      delete ficheSuggestions[field.key];
      renderFicheSuggestions();
    });
    suggestionEl.appendChild(suggestionText);
    suggestionEl.appendChild(applyBtn);
    dd.appendChild(suggestionEl);
    ficheSuggestionEls[field.key] = { container: suggestionEl, text: suggestionText };

    ficheFieldsEl.appendChild(dt);
    ficheFieldsEl.appendChild(dd);
  }

  for (const field of READONLY_FIELDS) {
    const dt = document.createElement('dt');
    dt.textContent = field.label;
    const dd = document.createElement('dd');
    dd.appendChild(createCollapsibleText(ficheReadonly[field.key] || '—'));
    ficheFieldsEl.appendChild(dt);
    ficheFieldsEl.appendChild(dd);
  }
}

function renderFicheSuggestions() {
  for (const field of EDITABLE_FIELDS) {
    const entry = ficheSuggestionEls[field.key];
    const value = ficheSuggestions[field.key];
    if (!entry) continue;
    if (value) {
      entry.text.textContent = `Suggestion IA : ${value}`;
      entry.container.classList.remove('hidden');
    } else {
      entry.container.classList.add('hidden');
    }
  }
  applyAllBtn.classList.toggle('hidden', Object.keys(ficheSuggestions).length === 0);
}

applyAllBtn.addEventListener('click', () => {
  for (const key of Object.keys(ficheSuggestions)) {
    ficheState[key] = ficheSuggestions[key];
    if (ficheInputs[key]) {
      ficheInputs[key].value = ficheSuggestions[key];
      ficheInputs[key].classList.add('applied');
    }
  }
  ficheSuggestions = {};
  renderFicheSuggestions();
});

const categoryChipsEl = document.getElementById('category-chips');
const categoryAddForm = document.getElementById('category-add-form');
const categoryNameInput = document.getElementById('category-name-input');
const categoryAddConfirmBtn = document.getElementById('category-add-confirm-btn');
const categoryAddCancelBtn = document.getElementById('category-add-cancel-btn');

const progressSection = document.getElementById('progress-section');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');

const doneSection = document.getElementById('done-section');
const openFolderBtn = document.getElementById('open-folder-btn');

let selectedFolder = null;
let selectedCategory = null;
let lastOutputDir = null;
let categories = [];
let hasOllamaModel = false;
let lastAnalyzedInfo = null;
let lastAnalyzedUrl = null;
let selectedQuality = 'best';

function updateAiControlsAvailability() {
  crossRefBtn.disabled = !hasOllamaModel;
}

function closeQualityMenu() {
  qualitySelectMenu.classList.add('hidden');
  qualitySelectEl.classList.remove('open');
  qualitySelectTrigger.setAttribute('aria-expanded', 'false');
}

function openQualityMenu() {
  qualitySelectMenu.classList.remove('hidden');
  qualitySelectEl.classList.add('open');
  qualitySelectTrigger.setAttribute('aria-expanded', 'true');
}

function selectQuality(li) {
  selectedQuality = li.dataset.value;
  qualitySelectValue.textContent = li.textContent;
  for (const item of qualitySelectMenu.children) {
    item.classList.toggle('active', item === li);
    item.setAttribute('aria-selected', item === li ? 'true' : 'false');
  }
  closeQualityMenu();
  qualitySelectTrigger.focus();
}

qualitySelectTrigger.addEventListener('click', () => {
  if (qualitySelectMenu.classList.contains('hidden')) {
    openQualityMenu();
  } else {
    closeQualityMenu();
  }
});

qualitySelectMenu.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) selectQuality(li);
});

qualitySelectMenu.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    selectQuality(e.target);
  }
});

document.addEventListener('click', (e) => {
  if (!qualitySelectEl.contains(e.target)) closeQualityMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeQualityMenu();
});

async function refreshOllamaModels(selectedModel) {
  const models = await window.api.listOllamaModels();
  ollamaModelSelect.innerHTML = '';

  if (models.length === 0) {
    ollamaStatus.textContent = "Ollama non détecté - installe-le (ollama.com) puis lance 'ollama pull llama3.2'.";
    hasOllamaModel = false;
    updateAiControlsAvailability();
    return;
  }

  for (const name of models) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    ollamaModelSelect.appendChild(option);
  }
  const alreadyConfigured = !!(selectedModel && models.includes(selectedModel));
  if (alreadyConfigured) {
    ollamaModelSelect.value = selectedModel;
  }
  ollamaStatus.textContent = `Ollama détecté, ${models.length} modèle(s) disponible(s).`;
  hasOllamaModel = true;
  updateAiControlsAvailability();

  if (!alreadyConfigured) {
    // Aucun modèle n'était encore enregistré : on sauvegarde celui affiché
    // par défaut pour que les réglages reflètent ce que montre l'UI.
    await window.api.saveSettings({
      ollamaModel: ollamaModelSelect.value,
      searxUrl: searxUrlInput.value.trim(),
    });
  }
}

async function loadSettings() {
  const settings = await window.api.getSettings();
  searxUrlInput.value = (settings && settings.searxUrl) || '';
  await refreshOllamaModels(settings && settings.ollamaModel);
}

aiSettingsToggle.addEventListener('click', () => {
  aiSettingsPanel.classList.remove('hidden');
});

aiSettingsCloseBtn.addEventListener('click', () => {
  aiSettingsPanel.classList.add('hidden');
});

aiSettingsPanel.addEventListener('click', (e) => {
  if (e.target === aiSettingsPanel) {
    aiSettingsPanel.classList.add('hidden');
  }
});

ollamaRefreshBtn.addEventListener('click', () => {
  refreshOllamaModels(ollamaModelSelect.value);
});

aiSettingsSaveBtn.addEventListener('click', async () => {
  const ollamaModel = ollamaModelSelect.value || '';
  const searxUrl = searxUrlInput.value.trim();
  await window.api.saveSettings({ ollamaModel, searxUrl });
  await loadSettings();
  aiSettingsPanel.classList.add('hidden');
});

loadSettings();

function renderCategoryChips() {
  categoryChipsEl.innerHTML = '';

  for (const category of categories) {
    const chip = document.createElement('button');
    chip.className = 'category-chip' + (selectedCategory === category.name ? ' active' : '');
    chip.type = 'button';

    const label = document.createElement('span');
    label.textContent = category.name;
    chip.appendChild(label);

    const removeBtn = document.createElement('span');
    removeBtn.className = 'remove-chip';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      categories = await window.api.deleteCategory(category.id);
      if (selectedCategory === category.name) {
        selectedCategory = null;
        selectedFolder = null;
        folderPathEl.value = 'downloads/ (par defaut)';
      }
      renderCategoryChips();
    });
    chip.appendChild(removeBtn);

    chip.addEventListener('click', () => {
      selectedCategory = category.name;
      selectedFolder = category.folder;
      folderPathEl.value = category.folder;
      renderCategoryChips();
    });

    categoryChipsEl.appendChild(chip);
  }

  const addChip = document.createElement('button');
  addChip.className = 'category-chip add-chip';
  addChip.type = 'button';
  addChip.textContent = '+ Ajouter';
  addChip.addEventListener('click', () => {
    categoryAddForm.classList.remove('hidden');
    categoryNameInput.value = '';
    categoryNameInput.focus();
  });
  categoryChipsEl.appendChild(addChip);
}

async function loadCategories() {
  categories = await window.api.getCategories();
  renderCategoryChips();
}

categoryAddCancelBtn.addEventListener('click', () => {
  categoryAddForm.classList.add('hidden');
});

categoryAddConfirmBtn.addEventListener('click', async () => {
  const name = categoryNameInput.value.trim();
  if (!name) {
    categoryNameInput.focus();
    return;
  }
  const folder = await window.api.chooseFolder();
  if (!folder) return;
  categories = await window.api.saveCategory({ name, folder });
  categoryAddForm.classList.add('hidden');
  renderCategoryChips();
});

loadCategories();

function showError(message) {
  errorMsg.textContent = message;
  errorMsg.classList.remove('hidden');
}

function clearError() {
  errorMsg.classList.add('hidden');
  errorMsg.textContent = '';
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

async function analyzeVideo() {
  const url = urlInput.value.trim();
  clearError();
  preview.classList.add('hidden');
  options.classList.add('hidden');
  progressSection.classList.add('hidden');
  doneSection.classList.add('hidden');
  downloadBtn.classList.add('hidden');

  if (!url) {
    showError('Colle un lien de vidéo.');
    return;
  }

  analyzeBtn.disabled = true;
  analyzeBtn.textContent = 'Analyse...';
  analyzeProgress.classList.remove('hidden');

  try {
    const info = await window.api.analyze(url);
    lastAnalyzedInfo = info;
    lastAnalyzedUrl = url;
    previewThumb.src = info.thumbnail || '';
    previewTitle.textContent = info.title || 'Video';
    previewUploader.textContent = info.uploader ? `Chaine : ${info.uploader}` : '';
    preview.classList.remove('hidden');
    options.classList.remove('hidden');
    downloadBtn.classList.remove('hidden');
    folderPathEl.value = selectedFolder || 'downloads/ (par defaut)';

    ficheState = {
      synopsis: info.description || '',
      year: info.year || '',
      director: '',
      country: '',
      production: info.uploader || '',
      presenter: '',
    };
    ficheReadonly = {
      duration: formatDuration(info.duration) || '—',
      genres: (info.categories && info.categories.length) ? info.categories.join(', ') : '—',
      tags: (info.tags && info.tags.length) ? info.tags.join(', ') : '—',
    };
    ficheSuggestions = {};
    renderFiche();
    ficheSection.classList.remove('hidden');

    crossRefResult.classList.add('hidden');
    crossRefNote.textContent = '';
    crossRefSource.classList.add('hidden');
    applyAllBtn.classList.add('hidden');
    crossRefSection.classList.toggle('hidden', !hasOllamaModel);

    document.body.classList.add('has-result');
  } catch (err) {
    showError(err.message || 'Impossible d\'analyser ce lien.');
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = 'Analyser';
    analyzeProgress.classList.add('hidden');
  }
}

analyzeBtn.addEventListener('click', analyzeVideo);

chooseFolderBtn.addEventListener('click', async () => {
  const folder = await window.api.chooseFolder();
  if (folder) {
    selectedFolder = folder;
    selectedCategory = null;
    folderPathEl.value = folder;
    renderCategoryChips();
  }
});

downloadBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) return;

  clearError();
  doneSection.classList.add('hidden');
  progressSection.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = 'Démarrage...';
  downloadBtn.disabled = true;

  try {
    const result = await window.api.download({
      url,
      quality: selectedQuality,
      destFolder: selectedFolder,
      category: selectedCategory,
      overrides: ficheState,
    });
    lastOutputDir = result.outputDir;
    progressFill.style.width = '100%';
    progressText.textContent = 'Terminé.';
    doneSection.classList.remove('hidden');
  } catch (err) {
    showError(err.message || 'Le téléchargement a échoué.');
    progressSection.classList.add('hidden');
  } finally {
    downloadBtn.disabled = false;
  }
});

openFolderBtn.addEventListener('click', () => {
  window.api.openFolder(lastOutputDir);
});

crossRefCancelBtn.addEventListener('click', () => {
  window.api.cancelCrossReference();
  crossRefLoadingOverlay.classList.add('hidden');
});

crossRefBtn.addEventListener('click', async () => {
  if (!lastAnalyzedInfo) return;
  crossRefBtn.disabled = true;
  crossRefBtn.textContent = 'Recherche...';
  crossRefResult.classList.add('hidden');
  crossRefSource.classList.add('hidden');
  crossRefLoadingOverlay.classList.remove('hidden');
  ficheSuggestions = {};
  renderFicheSuggestions();

  try {
    const result = await window.api.findCrossReference({
      title: lastAnalyzedInfo.title,
      uploader: lastAnalyzedInfo.uploader,
      description: lastAnalyzedInfo.description,
      url: lastAnalyzedUrl,
    });

    crossRefResult.classList.remove('hidden');

    if (!result.matched) {
      crossRefNote.textContent = result.note || 'Aucune source officielle fiable trouvée.';
      return;
    }

    crossRefNote.textContent = `${result.note || ''} (confiance : ${result.confidence || 'faible'})`.trim();

    if (result.sourceUrl) {
      crossRefSourceLink.href = result.sourceUrl;
      crossRefSourceLink.textContent = result.sourceUrl;
      crossRefSource.classList.remove('hidden');
    }

    ficheSuggestions = {};
    const fields = result.fields || {};
    for (const field of EDITABLE_FIELDS) {
      const value = fields[field.key];
      if (value && value !== 'null') {
        ficheSuggestions[field.key] = String(value);
      }
    }
    renderFicheSuggestions();
  } catch (err) {
    crossRefResult.classList.remove('hidden');
    crossRefNote.textContent = err.message || 'La recherche a échoué.';
  } finally {
    crossRefBtn.disabled = !hasOllamaModel;
    crossRefBtn.textContent = 'Rechercher une source alternative (IA)';
    crossRefLoadingOverlay.classList.add('hidden');
  }
});

window.api.onProgress(({ percent, speed, eta }) => {
  progressFill.style.width = `${percent}%`;
  const parts = [`${percent.toFixed(1)}%`];
  if (speed) parts.push(speed);
  if (eta) parts.push(`ETA ${eta}`);
  progressText.textContent = parts.join(' - ');
});
