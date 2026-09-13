/*
 * Handover for Gemini — content script.
 *
 * Loads a Gemini conversation in full, turns it into Markdown and drops it
 * into a new chat (or the clipboard).
 */
(() => {
  'use strict';

  const UI_ATTR = 'data-gh-ui';
  const STORAGE_KEY = 'pendingGeminiContext';
  const CONTEXT_TTL_MS = 10 * 60 * 1000;

  const TURN_SELECTOR = 'user-query, model-response';
  const INPUT_SELECTOR =
    '.ql-editor, rich-textarea div[contenteditable="true"], div[contenteditable="true"]';

  const LOAD_TIMEOUT_MS = 120000;
  const QUIET_PROBE_MS = 500; // parked at the top, nothing loading
  const BUSY_PROBE_MS = 2500; // still loading or still scrolling
  const STABLE_ROUNDS_QUIET = 2;
  const STABLE_ROUNDS_MAX = 4;
  const TOP_EPS = 8;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const getTurns = () => Array.from(document.querySelectorAll(TURN_SELECTOR));

  // ---- Settings ----

  // Falls back to the key itself when chrome.i18n is missing, which is what
  // lets the tests run outside a browser.
  function t(key, ...subs) {
    try {
      const msg = chrome.i18n.getMessage(key, subs.map(String));
      if (msg) return msg;
    } catch (_) {
      /* fall through */
    }
    return key;
  }

  // Format numbers in the UI language, not a fixed locale.
  function num(n) {
    try {
      return n.toLocaleString(chrome.i18n.getUILanguage());
    } catch (_) {
      return String(n);
    }
  }

  const DEFAULT_SETTINGS = {
    defaultScope: 0, // 0 = whole conversation
    showDock: true,
    briefingPrompt: '', // empty = use the localised default
  };

  const briefingPrompt = () =>
    settings.briefingPrompt || t('briefingDefaultPrompt');

  let settings = { ...DEFAULT_SETTINGS };

  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      settings = { ...DEFAULT_SETTINGS, ...stored };
    } catch (_) {
      settings = { ...DEFAULT_SETTINGS };
    }
    return settings;
  }

  // ---- Theme ----
  // Derived from Gemini's own background colour instead of hardcoded, so it
  // keeps working when they change their palette.

  const PALETTES = {
    dark: {
      surface: '#1e1f20',
      raised: '#2b2c2f',
      hover: '#35363a',
      border: '#444746',
      text: '#e3e3e3',
      muted: '#9aa0a6',
      accent: '#a8c7fa',
      'on-accent': '#062e6f',
      'warn-bg': '#3a2c1e',
      'warn-text': '#f9c58d',
      shadow: 'rgba(0,0,0,0.45)',
      scrim: 'rgba(0,0,0,0.55)',
    },
    light: {
      surface: '#ffffff',
      raised: '#f1f3f4',
      hover: '#e4e6e8',
      border: '#c4c7c5',
      text: '#1f1f1f',
      muted: '#5f6368',
      accent: '#0b57d0',
      'on-accent': '#ffffff',
      'warn-bg': '#fef7e0',
      'warn-text': '#7a5300',
      shadow: 'rgba(0,0,0,0.18)',
      scrim: 'rgba(0,0,0,0.32)',
    },
  };

  // Read the theme off Gemini's background colour.
  function detectTheme() {
    let bg = '';
    try {
      bg = getComputedStyle(document.body).backgroundColor || '';
    } catch (_) {
      /* ignore */
    }
    const parts = bg.match(/\d+(\.\d+)?/g);
    // Transparent body: fall back to the system setting
    if (!parts || (parts.length > 3 && +parts[3] === 0)) {
      const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
      return mq && mq.matches ? 'dark' : 'light';
    }
    const lum = (0.299 * +parts[0] + 0.587 * +parts[1] + 0.114 * +parts[2]) / 255;
    return lum < 0.5 ? 'dark' : 'light';
  }

  let currentTheme = null;

  // Only swaps the CSS variables; everything already on screen follows.
  function applyTheme(force) {
    const next = detectTheme();
    if (!force && next === currentTheme) return;
    currentTheme = next;
    const root = document.documentElement;
    const palette = PALETTES[next];
    for (const key of Object.keys(palette)) {
      root.style.setProperty(`--gh-${key}`, palette[key]);
    }
  }

  const STYLESHEET = `
    .gh-dock[${UI_ATTR}] {
      position: fixed; right: 10px; top: 50%; transform: translateY(-50%);
      z-index: 2147482000; display: none; flex-direction: column;
      align-items: center; gap: 6px; width: 40px; padding: 8px 4px;
      box-sizing: border-box;
      background: var(--gh-surface); border: 1px solid var(--gh-border);
      border-radius: 20px; box-shadow: 0 6px 20px var(--gh-shadow);
      user-select: none;
    }
    .gh-dock--visible[${UI_ATTR}] { display: flex; }

    .gh-icon-btn[${UI_ATTR}] {
      width: 30px; height: 30px; padding: 0; margin: 0;
      display: flex; align-items: center; justify-content: center;
      background: transparent; color: var(--gh-muted);
      border: none; border-radius: 50%; cursor: pointer;
      font: 13px system-ui, sans-serif; outline: none;
      transition: background 0.15s, color 0.15s;
    }
    .gh-icon-btn[${UI_ATTR}]:hover { background: var(--gh-hover); color: var(--gh-text); }
    .gh-icon-btn--accent[${UI_ATTR}] {
      background: var(--gh-raised); color: var(--gh-accent);
      border: 1px solid var(--gh-border);
    }

    .gh-toast[${UI_ATTR}] {
      position: fixed; bottom: 24px; right: 60px; z-index: 2147483000;
      display: flex; align-items: center; gap: 12px; max-width: 380px;
      padding: 10px 14px; box-sizing: border-box;
      background: var(--gh-surface); color: var(--gh-text);
      border: 1px solid var(--gh-border); border-radius: 8px;
      font: 13px/1.4 system-ui, sans-serif;
      box-shadow: 0 4px 16px var(--gh-shadow);
    }

    .gh-overlay[${UI_ATTR}] {
      position: fixed; inset: 0; z-index: 2147483100;
      display: flex; align-items: center; justify-content: center;
      background: var(--gh-scrim);
    }
    .gh-card[${UI_ATTR}] {
      width: min(440px, calc(100vw - 32px)); padding: 20px;
      box-sizing: border-box;
      background: var(--gh-surface); color: var(--gh-text);
      border: 1px solid var(--gh-border); border-radius: 14px;
      font: 14px/1.5 system-ui, sans-serif;
      box-shadow: 0 12px 40px var(--gh-shadow);
    }
    .gh-title[${UI_ATTR}] { font-size: 15px; font-weight: 600; margin-bottom: 12px; }
    .gh-status[${UI_ATTR}] { color: var(--gh-muted); margin-bottom: 14px; }
    .gh-warning[${UI_ATTR}] {
      display: none; margin-bottom: 14px; padding: 10px 12px;
      background: var(--gh-warn-bg); color: var(--gh-warn-text);
      border-radius: 8px; font-size: 13px;
    }
    .gh-warning--visible[${UI_ATTR}] { display: block; }
    .gh-field[${UI_ATTR}] { display: none; margin-bottom: 14px; }
    .gh-field--visible[${UI_ATTR}] { display: block; }
    .gh-label[${UI_ATTR}] {
      display: block; margin-bottom: 6px;
      font-size: 12px; color: var(--gh-muted);
    }
    .gh-select[${UI_ATTR}] {
      width: 100%; padding: 8px 10px; box-sizing: border-box;
      background: var(--gh-raised); color: var(--gh-text);
      border: 1px solid var(--gh-border); border-radius: 8px;
      font: 14px system-ui, sans-serif;
    }
    .gh-textarea[${UI_ATTR}] {
      width: 100%; padding: 10px; box-sizing: border-box; resize: vertical;
      background: var(--gh-raised); color: var(--gh-text);
      border: 1px solid var(--gh-border); border-radius: 8px;
      font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .gh-filters[${UI_ATTR}] {
      display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px;
    }
    .gh-chip[${UI_ATTR}] {
      padding: 4px 10px; cursor: pointer;
      background: var(--gh-raised); color: var(--gh-text);
      border: 1px solid var(--gh-border); border-radius: 999px;
      font: 12px system-ui, sans-serif;
    }
    .gh-chip[${UI_ATTR}]:hover { background: var(--gh-hover); }

    .gh-list[${UI_ATTR}] {
      max-height: 260px; overflow-y: auto; margin-bottom: 14px;
      border: 1px solid var(--gh-border); border-radius: 8px;
    }
    .gh-row[${UI_ATTR}] {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 8px; border-bottom: 1px solid var(--gh-border);
    }
    .gh-row[${UI_ATTR}]:last-child { border-bottom: none; }
    .gh-row[${UI_ATTR}]:hover { background: var(--gh-hover); }
    .gh-row--off[${UI_ATTR}] { opacity: 0.45; }
    .gh-check[${UI_ATTR}] { flex: none; margin: 0; accent-color: var(--gh-accent); }
    .gh-row-main[${UI_ATTR}] {
      flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px;
      cursor: pointer;
    }
    .gh-row-role[${UI_ATTR}] {
      flex: none; width: 44px; color: var(--gh-muted);
      font: 600 11px system-ui, sans-serif; text-transform: uppercase;
    }
    .gh-row-text[${UI_ATTR}] {
      flex: 1; min-width: 0; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
      font: 13px system-ui, sans-serif; color: var(--gh-text);
    }
    .gh-row-jump[${UI_ATTR}] {
      flex: none; width: 24px; height: 24px; padding: 0; cursor: pointer;
      background: transparent; color: var(--gh-muted);
      border: none; border-radius: 6px; font: 13px system-ui, sans-serif;
    }
    .gh-row-jump[${UI_ATTR}]:hover { background: var(--gh-raised); color: var(--gh-text); }

    /* Peek mode: get the panel out of the way while jumping to a message. */
    .gh-overlay--peek[${UI_ATTR}] { background: transparent; pointer-events: none; }
    .gh-overlay--peek[${UI_ATTR}] .gh-card[${UI_ATTR}] { display: none; }
    .gh-peek[${UI_ATTR}] { display: none; }
    .gh-overlay--peek[${UI_ATTR}] .gh-peek[${UI_ATTR}] {
      display: block; position: fixed; left: 16px; bottom: 16px;
      pointer-events: auto; padding: 8px 14px; cursor: pointer;
      background: var(--gh-surface); color: var(--gh-text);
      border: 1px solid var(--gh-border); border-radius: 999px;
      font: 13px system-ui, sans-serif;
      box-shadow: 0 6px 20px var(--gh-shadow);
    }
    .gh-overlay--peek[${UI_ATTR}] .gh-peek[${UI_ATTR}]:hover { background: var(--gh-hover); }

    /* Highlight for the message we jumped to. This sits on one of Gemini's own
       elements, so no UI attribute here, and inset shadow so it costs no
       layout. */
    @keyframes gh-flash-anim {
      from { box-shadow: inset 0 0 0 2px var(--gh-accent); }
      to { box-shadow: inset 0 0 0 2px transparent; }
    }
    .gh-flash {
      animation: gh-flash-anim 1.5s ease-out 1;
      border-radius: 10px;
    }

    .gh-stats[${UI_ATTR}] {
      font-size: 13px; color: var(--gh-muted); margin-bottom: 18px;
    }
    .gh-actions[${UI_ATTR}] { display: flex; gap: 8px; justify-content: flex-end; }

    .gh-btn[${UI_ATTR}] {
      padding: 8px 14px; cursor: pointer;
      background: transparent; color: var(--gh-text);
      border: 1px solid var(--gh-border); border-radius: 8px;
      font: 14px system-ui, sans-serif;
    }
    .gh-btn[${UI_ATTR}]:hover { background: var(--gh-hover); }
    .gh-btn--primary[${UI_ATTR}] {
      padding: 8px 16px;
      background: var(--gh-accent); color: var(--gh-on-accent);
      border: 1px solid transparent; font-weight: 600;
    }
    .gh-btn--primary[${UI_ATTR}]:hover { background: var(--gh-accent); opacity: 0.9; }
    .gh-btn[${UI_ATTR}]:disabled { opacity: 0.5; cursor: default; }
    .gh-btn[${UI_ATTR}]:disabled:hover { background: var(--gh-accent); }
  `;

  function ensureStyles() {
    if (document.getElementById('gh-styles')) return;
    const style = document.createElement('style');
    style.id = 'gh-styles';
    style.setAttribute(UI_ATTR, '');
    style.textContent = STYLESHEET;
    (document.head || document.documentElement).appendChild(style);
  }

  // Gemini switches theme without a reload, so watch the attributes on <html>
  // and <body> plus the system setting.
  function watchTheme() {
    let pending;
    const refresh = () => {
      clearTimeout(pending);
      pending = setTimeout(() => applyTheme(false), 60);
    };

    const obs = new MutationObserver(refresh);
    const opts = {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'dark', 'data-dark-theme'],
    };
    obs.observe(document.documentElement, opts);
    if (document.body) obs.observe(document.body, opts);

    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (mq) {
      if (mq.addEventListener) mq.addEventListener('change', refresh);
      else if (mq.addListener) mq.addListener(refresh);
    }

    // Last resort. Gemini can also swap stylesheets, which no attribute
    // announces.
    setInterval(() => applyTheme(false), 2000);
  }

  // ---- DOM to Markdown ----

  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'BUTTON',
    'MAT-ICON',
    'MAT-TOOLTIP-COMPONENT',
    'SVG',
    'TEMPLATE',
    // Hidden edit fields repeat the same text
    'TEXTAREA',
    'INPUT',
    'SELECT',
    'OPTION',
  ]);

  const SKIP_CLASSES = [
    // Chrome around code blocks: the language label and the copy button
    'code-block-decoration',
    'code-block-header',
    'buttons-container',
    // Screen reader blocks. Gemini parks "You said" plus a second copy of the
    // prompt in here, so without this everything lands in the export twice.
    'cdk-visually-hidden',
    'visually-hidden',
    'visually_hidden',
    'sr-only',
    'screen-reader-only',
    'screenreader-only',
  ];

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HR',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH',
  ]);

  // Treat custom elements (anything hyphenated) as blocks.
  function isBlockNode(n) {
    return (
      !!n &&
      n.nodeType === Node.ELEMENT_NODE &&
      (BLOCK_TAGS.has(n.tagName) || n.tagName.includes('-'))
    );
  }

  // Whitespace between two block elements is just source formatting. Let it
  // through and lines start with a stray space, which breaks tables and lists.
  function isLayoutWhitespace(kids, i) {
    const node = kids[i];
    if (node.nodeType !== Node.TEXT_NODE) return false;
    if (/\S/.test(node.textContent || '')) return false;
    const prev = kids[i - 1];
    const next = kids[i + 1];
    return !prev || !next || isBlockNode(prev) || isBlockNode(next);
  }

  function detectLanguage(pre, codeEl) {
    const cls = `${(codeEl && codeEl.className) || ''} ${pre.className || ''}`;
    const m = cls.match(/language-([\w+#.-]+)/i);
    if (m) return m[1].toLowerCase();

    const block = pre.closest('code-block, .code-block');
    if (block) {
      const label = block.querySelector(
        '.code-block-decoration span, [data-test-id="code-block-language"]'
      );
      const t = label && label.textContent ? label.textContent.trim().toLowerCase() : '';
      if (t && /^[\w+#.-]{1,20}$/.test(t)) return t;
    }
    return '';
  }

  function serializePre(pre) {
    const codeEl = pre.querySelector('code');
    const raw = ((codeEl || pre).textContent || '').replace(/\s+$/, '');
    const lang = detectLanguage(pre, codeEl);
    const fence = raw.includes('```') ? '````' : '```';
    return `${fence}${lang}\n${raw}\n${fence}\n\n`;
  }

  function serializeList(el, depth) {
    const ordered = el.tagName === 'OL';
    let idx = parseInt(el.getAttribute('start') || '1', 10);
    if (Number.isNaN(idx)) idx = 1;
    const pad = '    '.repeat(depth);
    let out = '';

    for (const li of Array.from(el.children)) {
      if (li.tagName !== 'LI') continue;

      let text = '';
      let nested = '';
      const kids = Array.from(li.childNodes);
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (isLayoutWhitespace(kids, i)) continue;
        if (
          child.nodeType === Node.ELEMENT_NODE &&
          (child.tagName === 'UL' || child.tagName === 'OL')
        ) {
          nested += serializeList(child, depth + 1);
        } else {
          text += serializeNode(child, depth);
        }
      }

      const marker = ordered ? `${idx++}. ` : '- ';
      const lines = text.trim().split('\n');
      out += `${pad}${marker}${lines[0] || ''}\n`;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim()) out += `${pad}    ${lines[i].trim()}\n`;
      }
      out += nested;
    }

    return out + (depth === 0 ? '\n' : '');
  }

  function serializeTable(el) {
    const rows = Array.from(el.querySelectorAll('tr'));
    if (!rows.length) return '';

    const cells = rows.map((r) =>
      Array.from(r.children).map((c) =>
        serializeChildren(c, 0).replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim()
      )
    );
    const cols = Math.max(...cells.map((r) => r.length));
    const fill = (r) => {
      const c = r.slice();
      while (c.length < cols) c.push('');
      return c;
    };

    let out = `| ${fill(cells[0]).join(' | ')} |\n`;
    out += `| ${new Array(cols).fill('---').join(' | ')} |\n`;
    for (let i = 1; i < cells.length; i++) out += `| ${fill(cells[i]).join(' | ')} |\n`;
    return `${out}\n`;
  }

  function serializeChildren(el, depth) {
    const kids = Array.from(el.childNodes);
    let out = '';
    for (let i = 0; i < kids.length; i++) {
      if (isLayoutWhitespace(kids, i)) continue;
      out += serializeNode(kids[i], depth);
    }
    return out;
  }

  function serializeNode(node, depth) {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent || '').replace(/\s+/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag) || el.hasAttribute(UI_ATTR)) return '';
    if (el.getAttribute('aria-hidden') === 'true') return '';
    if (el.classList && SKIP_CLASSES.some((c) => el.classList.contains(c))) return '';

    switch (tag) {
      case 'BR':
        return '\n';
      case 'HR':
        return '\n---\n\n';
      case 'P':
        return `${serializeChildren(el, depth).trim()}\n\n`;
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6':
        return `${'#'.repeat(+tag[1])} ${serializeChildren(el, depth).trim()}\n\n`;
      case 'UL':
      case 'OL':
        return serializeList(el, depth);
      case 'PRE':
        return serializePre(el);
      case 'CODE': {
        if (el.closest('pre')) return el.textContent || '';
        const t = (el.textContent || '').trim();
        if (!t) return '';
        const tick = t.includes('`') ? '``' : '`';
        return `${tick}${t}${tick}`;
      }
      case 'A': {
        const label = serializeChildren(el, depth).trim();
        const href = el.getAttribute('href') || '';
        if (!label) return '';
        if (!href || href.startsWith('javascript:')) return label;
        return `[${label}](${href})`;
      }
      case 'STRONG':
      case 'B': {
        const t = serializeChildren(el, depth).trim();
        return t ? `**${t}**` : '';
      }
      case 'EM':
      case 'I': {
        const t = serializeChildren(el, depth).trim();
        return t ? `*${t}*` : '';
      }
      case 'S':
      case 'DEL': {
        const t = serializeChildren(el, depth).trim();
        return t ? `~~${t}~~` : '';
      }
      case 'BLOCKQUOTE': {
        const inner = serializeChildren(el, depth).trim();
        if (!inner) return '';
        return `${inner
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')}\n\n`;
      }
      case 'TABLE':
        return serializeTable(el);
      case 'IMG': {
        const alt = el.getAttribute('alt') || 'Bild';
        return `![${alt}]`;
      }
      case 'DIV':
      case 'SECTION':
      case 'ARTICLE':
      case 'MAIN':
        return `${serializeChildren(el, depth)}\n`;
      default:
        return serializeChildren(el, depth);
    }
  }

  function tidy(md) {
    return md
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
  }

  const USER_ROOTS = [
    '.query-text',
    '.user-query-box-text',
    '[class*="query-text"]',
    '.query-content',
  ];

  const MODEL_ROOTS = ['.markdown', '.model-response-text', 'message-content'];

  // Find the outermost containers holding the actual text. Outermost matters:
  // if a selector also matches nested elements we'd serialise the same text
  // twice.
  function pickContentRoots(turn, selectors) {
    for (const sel of selectors) {
      const nodes = Array.from(turn.querySelectorAll(sel));
      if (!nodes.length) continue;
      const outer = [];
      for (const n of nodes) {
        if (!outer.some((o) => o.contains(n))) outer.push(n);
      }
      if (outer.length) return outer;
    }
    return [turn];
  }

  const normalize = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

  // Drop back-to-back identical paragraphs.
  function dedupeBlocks(md) {
    const blocks = md.split(/\n{2,}/);
    const out = [];
    let lastKey = null;
    for (const b of blocks) {
      const key = normalize(b);
      if (!key) continue;
      if (key === lastKey) continue;
      lastKey = key;
      out.push(b);
    }
    return out.join('\n\n');
  }

  function turnToMarkdown(turn) {
    const isUser = turn.tagName.toLowerCase() === 'user-query';
    const roots = pickContentRoots(turn, isUser ? USER_ROOTS : MODEL_ROOTS);

    const seen = new Set();
    const chunks = [];
    for (const root of roots) {
      const md = tidy(serializeChildren(root, 0));
      if (!md) continue;
      const key = normalize(md);
      if (seen.has(key)) continue;
      seen.add(key);
      chunks.push(md);
    }

    return {
      role: isUser ? 'User' : 'Gemini',
      text: dedupeBlocks(tidy(chunks.join('\n\n'))),
    };
  }

  /**
   * @param {{role:string,text:string}[]} parts already-converted turns
   * @param {boolean} complete whether we know the history is whole
   * @param {boolean} partial whether the user picked a subset
   */
  function buildContextString(parts, complete, partial) {
    const used = parts.filter((p) => p && p.text);
    if (!used.length) return null;

    let out = '[CONTEXT HANDOVER FROM A PREVIOUS GEMINI CONVERSATION]\n';
    if (partial) {
      out +=
        'Below is a SELECTION of messages from an earlier conversation. ' +
        'Continue it seamlessly and ask if anything essential is unclear.\n\n';
    } else if (complete) {
      out +=
        'Below is the complete history of an earlier conversation. ' +
        'Continue it seamlessly.\n\n';
    } else {
      out +=
        'Below is an EXCERPT of an earlier conversation (the beginning may be missing). ' +
        'Continue it seamlessly and ask if anything essential is unclear.\n\n';
    }

    for (const p of used) out += `--- ${p.role} ---\n${p.text}\n\n`;

    out += '--- END OF HISTORY ---\nMy next question / instruction:\n';
    return out;
  }

  function buildBriefingContext(briefing) {
    if (!briefing) return null;
    return (
      '[CONTEXT HANDOVER FROM A PREVIOUS GEMINI CONVERSATION]\n' +
      'The text below is a handover briefing that summarises an earlier conversation ' +
      'with you. Treat it as established context and continue from it.\n\n' +
      `--- BRIEFING ---\n${briefing}\n\n--- END OF BRIEFING ---\n` +
      'My next question / instruction:\n'
    );
  }

  // ---- Loading the full history ----

  function getScrollContainer() {
    const turns = getTurns();
    if (turns.length) {
      let el = turns[0].parentElement;
      while (el && el !== document.body) {
        const style = window.getComputedStyle(el);
        if (
          ['auto', 'scroll'].includes(style.overflowY) &&
          el.scrollHeight > el.clientHeight
        ) {
          return el;
        }
        el = el.parentElement;
      }
    }
    return document.scrollingElement || document.documentElement || document.body;
  }

  // Height of whatever is pinned to the top of the viewport. Without this
  // offset the first lines of a message end up behind Gemini's own bar.
  function topObstruction() {
    let bottom = 0;
    const candidates = document.querySelectorAll(
      'header, [role="banner"], [class*="header" i], [class*="toolbar" i], [class*="top-bar" i]'
    );
    for (const el of candidates) {
      if (el.hasAttribute(UI_ATTR)) continue;
      const s = getComputedStyle(el);
      if (s.position !== 'fixed' && s.position !== 'sticky') continue;
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      const wide = r.width > window.innerWidth * 0.5;
      if (r.top <= 8 && r.height > 8 && r.height < 220 && wide) {
        bottom = Math.max(bottom, r.bottom);
      }
    }
    return Math.min(bottom, 220);
  }

  function flashTurn(el) {
    el.classList.remove('gh-flash');
    void el.offsetWidth; // force reflow so the animation restarts
    el.classList.add('gh-flash');
    setTimeout(() => el.classList.remove('gh-flash'), 1600);
  }

  // Jump to the START of a message. scrollIntoView with block:'center' puts
  // the middle of a long answer on screen, which is not what anyone wants.
  function scrollToTurn(el) {
    if (!el || !el.isConnected) return;

    const container = getScrollContainer();
    const isWindow =
      container === document.scrollingElement ||
      container === document.documentElement ||
      container === document.body;

    const elTop = el.getBoundingClientRect().top;

    if (isWindow) {
      const top = elTop + window.scrollY - (topObstruction() + 12);
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } else {
      // Does the bar actually cover this container? If it already starts
      // below it, subtracting the full header height overshoots.
      const cTop = container.getBoundingClientRect().top;
      const offset = Math.max(0, topObstruction() - cTop) + 12;
      const top = container.scrollTop + (elTop - cTop) - offset;
      container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }

    flashTurn(el);
  }

  function isLoading() {
    const els = document.querySelectorAll(
      'mat-spinner, mat-progress-spinner, mat-progress-bar'
    );
    for (const el of els) {
      if (el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }

  async function waitForGrowth(from, maxMs) {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      await wait(120);
      if (getTurns().length !== from) return true;
    }
    return false;
  }

  /**
   * Scroll up until no more old messages appear. The wait adapts: short probes
   * once we're parked at the top with nothing loading, patient otherwise.
   * @returns {{count:number, complete:boolean}}
   */
  async function loadFullHistory(onProgress) {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    let last = getTurns().length;
    let stable = 0;

    if (onProgress) onProgress(last);
    if (!last) return { count: 0, complete: false };

    while (Date.now() < deadline) {
      const container = getScrollContainer();
      const turns = getTurns();
      if (!turns.length) break;

      turns[0].scrollIntoView({ block: 'start', behavior: 'auto' });
      container.scrollTop = 0;
      await wait(60); // let layout settle

      // If we're already at the top with no spinner, nothing more can arrive,
      // so a short probe is enough. Otherwise wait it out.
      const quiet = getScrollContainer().scrollTop <= TOP_EPS && !isLoading();
      await waitForGrowth(last, quiet ? QUIET_PROBE_MS : BUSY_PROBE_MS);

      let guard = 0;
      while (isLoading() && guard++ < 40) await wait(150);

      const now = getTurns().length;
      if (onProgress) onProgress(now);

      if (now > last) {
        last = now;
        stable = 0;
        continue;
      }

      stable++;
      const atTop = getScrollContainer().scrollTop <= TOP_EPS;

      // At the top, nothing loading, twice in a row with no growth: done.
      if (atTop && !isLoading() && stable >= STABLE_ROUNDS_QUIET) {
        return { count: now, complete: true };
      }
      // Not certain we're at the top. Try a bit longer, then say so.
      if (stable >= STABLE_ROUNDS_MAX) {
        return { count: now, complete: atTop };
      }
    }

    return { count: getTurns().length, complete: false };
  }

  // ---- Writing into the composer ----
  // Every attempt is verified; if one silently does nothing we fall through
  // to the next.

  function grew(el, before, text) {
    const threshold = before + Math.min(20, Math.max(1, text.length - 1));
    return el.innerText.length >= threshold;
  }

  function moveCaretToEnd(el) {
    try {
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      el.scrollTop = el.scrollHeight;
    } catch (_) {
      /* ignore */
    }
  }

  async function insertIntoInput(el, text) {
    el.focus();
    const before = el.innerText.length;

    // 1. Synthetic paste event, which is what Quill expects anyway
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
      await wait(200);
      if (grew(el, before, text)) return true;
    } catch (_) {
      /* next */
    }

    // 2. execCommand. Deprecated, still works as a fallback
    try {
      document.execCommand('insertText', false, text);
      await wait(200);
      if (grew(el, before, text)) return true;
    } catch (_) {
      /* next */
    }

    // 3. Straight into the DOM, in the paragraph structure Quill expects
    try {
      el.innerHTML = '';
      for (const line of text.split('\n')) {
        const p = document.createElement('p');
        if (line) p.textContent = line;
        else p.appendChild(document.createElement('br'));
        el.appendChild(p);
      }
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
      );
      await wait(200);
      if (grew(el, 0, text)) return true;
    } catch (_) {
      /* next */
    }

    return false;
  }

  async function findInput(timeoutMs = 8000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const el = document.querySelector(INPUT_SELECTOR);
      if (el) return el;
      await wait(250);
    }
    return null;
  }

  // ---- Briefing ----
  // Gemini writes the summary itself: no backend, no API key, nothing to pay
  // for. The cost is an extra turn in the user's existing chat, which the
  // panel warns about before we do it.

  const SEND_SELECTORS = [
    'button[aria-label*="Senden" i]',
    'button[aria-label*="Send" i]',
    'button[data-test-id="send-button"]',
    'button.send-button',
    'button[mattooltip*="Senden" i]',
  ];

  const STOP_SELECTORS = [
    'button[aria-label*="Stopp" i]',
    'button[aria-label*="Stop" i]',
    'button[data-test-id="stop-button"]',
    'button.stop-button',
  ];

  function visibleMatch(selectors, requireEnabled) {
    for (const sel of selectors) {
      for (const b of document.querySelectorAll(sel)) {
        if (b.offsetParent === null) continue;
        if (requireEnabled && (b.disabled || b.getAttribute('aria-disabled') === 'true')) {
          continue;
        }
        return b;
      }
    }
    return null;
  }

  const isGenerating = () => !!visibleMatch(STOP_SELECTORS, false);

  async function waitUntil(fn, timeoutMs, step = 250) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (fn()) return true;
      await wait(step);
    }
    return false;
  }

  async function trySubmit() {
    const btn = visibleMatch(SEND_SELECTORS, true);
    if (btn) {
      btn.click();
      return;
    }
    const input = document.querySelector(INPUT_SELECTOR);
    if (!input) return;
    input.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    }
  }

  const lastResponseEl = () => {
    const all = document.querySelectorAll('model-response');
    return all.length ? all[all.length - 1] : null;
  };

  // Done streaming = length stopped changing and the stop button is gone.
  async function waitForResponse(baseCount, onTick) {
    const appeared = await waitUntil(() => getTurns().length > baseCount, 45000, 300);
    if (!appeared) return null;

    let lastLen = -1;
    let stable = 0;
    const deadline = Date.now() + 300000;

    while (Date.now() < deadline) {
      await wait(600);
      const el = lastResponseEl();
      const len = el ? (el.innerText || '').length : 0;
      if (onTick) onTick(len);

      if (len > 0 && len === lastLen && !isGenerating()) {
        if (++stable >= 3) return el;
      } else {
        stable = 0;
        lastLen = len;
      }
    }
    return lastResponseEl();
  }

  async function runBriefing(promptText, onStatus) {
    const say = (m) => onStatus && onStatus(m);

    const input = await findInput(8000);
    if (!input) return { ok: false, error: t('briefingErrNoInput') };
    if (input.innerText.trim()) {
      return { ok: false, error: t('briefingErrInputBusy') };
    }

    say(t('briefingStatusInsert'));
    if (!(await insertIntoInput(input, promptText))) {
      return { ok: false, error: t('briefingErrInsert') };
    }
    moveCaretToEnd(input);
    await wait(400);

    const baseCount = getTurns().length;

    say(t('briefingStatusSend'));
    let sent = false;
    for (let attempt = 0; attempt < 6 && !sent; attempt++) {
      await trySubmit();
      sent = await waitUntil(() => getTurns().length > baseCount, 2500);
    }
    if (!sent) return { ok: false, error: t('briefingErrSend') };

    say(t('briefingStatusWriting'));
    const el = await waitForResponse(baseCount, (len) => {
      if (len) say(t('briefingStatusWritingCount', num(len)));
    });
    if (!el) return { ok: false, error: t('briefingErrNoResponse') };

    const md = turnToMarkdown(el).text;
    if (!md) return { ok: false, error: t('briefingErrEmpty') };
    return { ok: true, text: md };
  }

  // ---- Picking up the handover in the new tab ----

  async function readPending() {
    try {
      const res = await chrome.storage.local.get([STORAGE_KEY]);
      const entry = res && res[STORAGE_KEY];
      if (!entry) return null;

      // Still accept the old format (a plain string)
      if (typeof entry === 'string') return { text: entry, ts: Date.now() };
      if (!entry.text) return null;
      if (Date.now() - (entry.ts || 0) > CONTEXT_TTL_MS) {
        await chrome.storage.local.remove([STORAGE_KEY]);
        return null;
      }
      return entry;
    } catch (_) {
      return null;
    }
  }

  async function consumePendingContext() {
    const pending = await readPending();
    if (!pending) return;

    const input = await findInput();
    if (!input) {
      // Do NOT drop the context here; the user gets a retry instead.
      toast(t('toastNoInput'), {
        label: t('toastRetryInsert'),
        onClick: consumePendingContext,
        sticky: true,
      });
      return;
    }

    const ok = await insertIntoInput(input, pending.text);
    if (ok) {
      moveCaretToEnd(input);
      await chrome.storage.local.remove([STORAGE_KEY]);
      toast(t('toastInserted'));
    } else {
      toast(t('toastInsertFailed'), {
        label: t('toastRetry'),
        onClick: consumePendingContext,
        sticky: true,
      });
    }
  }

  // ---- Toast ----

  let activeToast = null;

  // Create an element, tag it as ours, set class and text.
  function mk(tag, className, text) {
    const node = document.createElement(tag);
    node.setAttribute(UI_ATTR, '');
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function toast(msg, action) {
    if (activeToast) activeToast.remove();

    const box = mk('div', 'gh-toast');
    box.appendChild(mk('span', null, msg));

    if (action) {
      const btn = mk('button', 'gh-btn gh-btn--primary', action.label);
      btn.style.flex = 'none';
      btn.style.padding = '5px 10px';
      btn.style.fontSize = '12px';
      btn.onclick = () => {
        box.remove();
        activeToast = null;
        action.onClick();
      };
      box.appendChild(btn);
    }

    document.body.appendChild(box);
    activeToast = box;

    if (!action || !action.sticky) {
      setTimeout(() => {
        if (activeToast === box) activeToast = null;
        box.remove();
      }, 3500);
    }
  }

  // ---- Panel ----

  let panelOpen = false;

  const preview = (text, max = 90) => {
    const one = text.replace(/```[\s\S]*?```/g, '[Code]').replace(/\s+/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
  };

  function openPanel(mode) {
    if (panelOpen) return;
    panelOpen = true;

    let cancelled = false;

    const overlay = mk('div', 'gh-overlay');
    const card = mk('div', 'gh-card');

    const TITLES = {
      copy: t('titleCopy'),
      newtab: t('titleHandover'),
      briefing: t('titleBriefing'),
    };

    const title = mk('div', 'gh-title', TITLES[mode]);
    const status = mk('div', 'gh-status', t('statusLoading'));
    const warning = mk('div', 'gh-warning');
    const stats = mk('div', 'gh-stats');

    const actions = mk('div', 'gh-actions');
    const btnCancel = mk('button', 'gh-btn', t('btnCancel'));
    const btnGo = mk('button', 'gh-btn gh-btn--primary', t('btnNext'));
    btnGo.disabled = true;
    actions.append(btnCancel, btnGo);

    const close = () => {
      cancelled = true;
      panelOpen = false;
      overlay.remove();
    };
    btnCancel.onclick = close;
    overlay.onclick = (e) => {
      if (e.target === overlay) close();
    };

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    if (mode === 'briefing') buildBriefingPanel();
    else buildSelectionPanel();

    // Selection panel: copy, or hand over to a new tab.

    function buildSelectionPanel() {
      btnGo.textContent = mode === 'copy' ? t('btnCopy') : t('btnOpenNewChat');

      const filters = mk('div', 'gh-filters');
      const listWrap = mk('div', 'gh-list');
      card.append(title, status, warning, filters, listWrap, stats, actions);

      // Only visible in peek mode, when the panel steps aside for a jump.
      const back = mk('button', 'gh-peek', t('peekBack'));
      back.onclick = () => overlay.classList.remove('gh-overlay--peek');
      overlay.appendChild(back);

      let parsed = []; // [{role, text, el, on}]
      let complete = false;

      const setAll = (on) => {
        for (const p of parsed) p.on = on;
        renderList();
        refreshStats();
      };

      const setLast = (n) => {
        parsed.forEach((p, i) => {
          p.on = i >= parsed.length - n;
        });
        renderList();
        refreshStats();
      };

      const setUserOnly = () => {
        for (const p of parsed) p.on = p.role === 'User';
        renderList();
        refreshStats();
      };

      function buildFilters() {
        const defs = [
          [t('filterAll'), () => setAll(true)],
          [t('filterNone'), () => setAll(false)],
        ];
        for (const n of [10, 25]) {
          if (parsed.length > n) defs.push([t('filterLast', n), () => setLast(n)]);
        }
        defs.push([t('filterUserOnly'), setUserOnly]);

        for (const [label, fn] of defs) {
          const b = mk('button', 'gh-chip', label);
          b.onclick = fn;
          filters.appendChild(b);
        }
      }

      function renderList() {
        listWrap.textContent = '';
        parsed.forEach((p, i) => {
          const row = mk('div', `gh-row${p.on ? '' : ' gh-row--off'}`);

          const box = mk('input', 'gh-check');
          box.type = 'checkbox';
          box.checked = p.on;
          box.onchange = () => {
            p.on = box.checked;
            row.classList.toggle('gh-row--off', !p.on);
            refreshStats();
          };

          const label = mk('div', 'gh-row-main');
          label.append(
            mk('span', 'gh-row-role', p.role === 'User' ? t('roleUser') : t('roleModel')),
            mk('span', 'gh-row-text', preview(p.text))
          );
          label.onclick = () => {
            box.checked = !box.checked;
            box.onchange();
          };

          const jump = mk('button', 'gh-row-jump', '↦');
          jump.title = t('rowJump');
          jump.onclick = (e) => {
            e.stopPropagation();
            // Hide the panel, or the chat scrolls behind the scrim.
            overlay.classList.add('gh-overlay--peek');
            scrollToTurn(p.el);
          };

          row.append(box, label, jump);
          row.dataset.index = String(i);
          listWrap.appendChild(row);
        });
      }

      function selection() {
        return parsed.filter((p) => p.on);
      }

      function refreshStats() {
        const sel = selection();
        const partial = sel.length !== parsed.length;
        const text = buildContextString(sel, complete, partial);
        const chars = text ? text.length : 0;

        stats.textContent = t('statsLine', sel.length, parsed.length, num(chars));
        if (chars > 40000) stats.textContent += t('statsTooLong');
        btnGo.disabled = !text;
        return text;
      }

      loadFullHistory((n) => {
        if (!cancelled) status.textContent = t('statusLoadingCount', num(n));
      }).then((res) => {
        if (cancelled) return;

        complete = res.complete;
        status.textContent = t('statusCaptured', num(res.count));

        if (!complete) {
          warning.classList.add('gh-warning--visible');
          warning.textContent = t('warnIncomplete');
        }

        parsed = getTurns()
          .map((el) => {
            const t = turnToMarkdown(el);
            return t.text ? { ...t, el, on: true } : null;
          })
          .filter(Boolean);

        const n = settings.defaultScope;
        if (n > 0 && parsed.length > n) setLast(n);

        buildFilters();
        renderList();
        refreshStats();

        btnGo.onclick = async () => {
          const text = refreshStats();
          if (!text) return;
          btnGo.disabled = true;
          btnGo.textContent = t('statusMoment');

          try {
            if (mode === 'copy') {
              await navigator.clipboard.writeText(text);
              close();
              toast(t('toastCopied'));
            } else {
              await chrome.storage.local.set({
                [STORAGE_KEY]: { text, ts: Date.now() },
              });
              close();
              window.open('https://gemini.google.com/app', '_blank');
            }
          } catch (_) {
            btnGo.disabled = false;
            btnGo.textContent = mode === 'copy' ? t('btnCopy') : t('btnOpenNewChat');
            status.textContent = t('statusFailedRetry');
          }
        };
      });
    }

    // Briefing panel.

    function buildBriefingPanel() {
      btnGo.textContent = t('btnCreateBriefing');
      btnGo.disabled = false;

      status.textContent = t('briefingIntro');

      warning.classList.add('gh-warning--visible');
      warning.textContent = t('briefingWarning');

      const field = mk('div', 'gh-field gh-field--visible');
      const area = mk('textarea', 'gh-textarea');
      area.value = briefingPrompt();
      area.rows = 8;
      field.append(mk('label', 'gh-label', t('briefingLabelPrompt')), area);

      card.append(title, status, warning, field, stats, actions);

      btnGo.onclick = async () => {
        const promptText = area.value.trim();
        if (!promptText) return;

        btnGo.disabled = true;
        area.disabled = true;
        field.classList.remove('gh-field--visible');
        warning.classList.remove('gh-warning--visible');

        const res = await runBriefing(promptText, (m) => {
          if (!cancelled) status.textContent = m;
        });
        if (cancelled) return;

        if (!res.ok) {
          status.textContent = res.error;
          warning.classList.add('gh-warning--visible');
          warning.textContent = t('briefingNothingTransferred');
          btnGo.disabled = false;
          btnGo.textContent = t('btnRetry');
          area.disabled = false;
          field.classList.add('gh-field--visible');
          return;
        }

        const text = buildBriefingContext(res.text);
        stats.textContent = t('briefingChars', num(res.text.length));

        try {
          await chrome.storage.local.set({
            [STORAGE_KEY]: { text, ts: Date.now() },
          });
          close();
          window.open('https://gemini.google.com/app', '_blank');
        } catch (_) {
          status.textContent = t('briefingTransferFailed');
          btnGo.disabled = false;
          btnGo.textContent = t('btnRetry');
        }
      };
    }
  }

  // ---- Dock ----

  function makeDockButton(label, title, onClick, highlight) {
    const b = mk('button', `gh-icon-btn${highlight ? ' gh-icon-btn--accent' : ''}`);
    b.innerHTML = label;
    b.title = title;
    b.onclick = onClick;
    return b;
  }

  function injectDock() {
    if (document.getElementById('gh-dock')) return;

    const dock = mk('div', 'gh-dock');
    dock.id = 'gh-dock';

    const btnTop = makeDockButton('&#9650;', t('dockLoadAll'), async (e) => {
      const b = e.currentTarget;
      b.innerHTML = '&#8987;';
      const res = await loadFullHistory();
      b.innerHTML = '&#9650;';
      toast(
        res.complete
          ? t('toastLoadedComplete', num(res.count))
          : t('toastLoadedPartial', num(res.count))
      );
    });

    const btnHandover = makeDockButton(
      '&#8599;',
      t('dockHandover'),
      () => openPanel('newtab'),
      true
    );

    const btnBriefing = makeDockButton('&#10022;', t('dockBriefing'), () =>
      openPanel('briefing')
    );

    const btnCopy = makeDockButton('&#128203;', t('dockCopy'), () =>
      openPanel('copy')
    );

    const btnBottom = makeDockButton('&#9660;', t('dockBottom'), () => {
      const turns = getTurns();
      if (turns.length) {
        turns[turns.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
      }
    });

    dock.append(btnTop, btnHandover, btnBriefing, btnCopy, btnBottom);
    document.body.appendChild(dock);
  }

  function syncDock() {
    const dock = document.getElementById('gh-dock');
    if (!dock) return;
    const show = settings.showDock && getTurns().length > 0;
    dock.classList.toggle('gh-dock--visible', show);
  }

  // ---- Startup ----

  let debounce;
  const observer = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      injectDock();
      syncDock();
    }, 300);
  });

  async function boot() {
    ensureStyles();
    applyTheme(true);
    watchTheme();

    await loadSettings();

    // Pick up popup changes straight away, no reload.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        for (const key of Object.keys(changes)) {
          if (key in DEFAULT_SETTINGS) settings[key] = changes[key].newValue;
        }
        syncDock();
      });
    } catch (_) {
      /* ignore */
    }

    injectDock();
    syncDock();
    consumePendingContext();

    // Just the area chats render into, not the whole body.
    const scope =
      document.querySelector('chat-window, main, [role="main"]') || document.body;
    observer.observe(scope, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
