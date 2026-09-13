/* Settings page. Keys must match DEFAULT_SETTINGS in content.js. */

const DEFAULTS = {
  defaultScope: 0,
  showDock: true,
  briefingPrompt: '', // empty = use the localised default
};

const t = (key, ...subs) => {
  try {
    return chrome.i18n.getMessage(key, subs.map(String)) || key;
  } catch (_) {
    return key;
  }
};

const $ = (id) => document.getElementById(id);
const scopeEl = $('defaultScope');
const dockEl = $('showDock');
const promptEl = $('briefingPrompt');
const statusEl = $('status');

// Pull every label out of the locale files.
function localize() {
  document.title = t('extName');

  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }

  // The scope options carry their number in the value.
  for (const opt of scopeEl.options) {
    const n = parseInt(opt.value, 10);
    opt.textContent = n > 0 ? t('popupScopeLast', n) : t('popupScopeAll');
  }

  promptEl.placeholder = t('briefingDefaultPrompt');
}

let statusTimer;

function flash(msg) {
  statusEl.textContent = msg;
  statusEl.classList.add('visible');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusEl.classList.remove('visible'), 1800);
}

async function load() {
  let stored = DEFAULTS;
  try {
    stored = await chrome.storage.sync.get(DEFAULTS);
  } catch (_) {
    /* use defaults */
  }
  scopeEl.value = String(stored.defaultScope ?? DEFAULTS.defaultScope);
  dockEl.checked = stored.showDock !== false;
  // Leave it empty while the default applies, so the placeholder shows the
  // localised text instead of freezing one language into storage.
  promptEl.value = stored.briefingPrompt || '';
}

async function save() {
  const values = {
    defaultScope: parseInt(scopeEl.value, 10) || 0,
    showDock: dockEl.checked,
    briefingPrompt: promptEl.value.trim(),
  };
  try {
    await chrome.storage.sync.set(values);
    flash(t('popupSaved'));
  } catch (_) {
    flash(t('popupSaveFailed'));
  }
}

$('save').addEventListener('click', save);

$('reset').addEventListener('click', () => {
  promptEl.value = '';
  promptEl.focus();
  save();
});

// The toggles save on change. Doing that for the prompt would fire on every
// keystroke, so it keeps the button.
scopeEl.addEventListener('change', save);
dockEl.addEventListener('change', save);

localize();
load();
