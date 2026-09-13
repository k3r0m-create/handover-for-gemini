/*
 * Tests for the text extraction in content.js.
 *
 * Setup: npm install jsdom
 * Run:   node test-markdown.js
 *
 * The functions are pulled straight out of content.js so these cannot drift
 * away from the implementation. When Gemini changes its markup, extend the
 * fixtures below. It is the cheapest way to catch silent formatting bugs
 * before a user reports one.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');

// Cut a block of functions out of the IIFE and evaluate it on its own.
function loadFromSource(fromMarker, untilMarker, exportsList) {
  const start = SRC.indexOf(fromMarker);
  const end = SRC.indexOf(untilMarker);
  if (start < 0 || end < 0 || end <= start) {
    console.error(
      `markers "${fromMarker}" / "${untilMarker}" not found — content.js restructured?`
    );
    process.exit(1);
  }
  return new Function(
    'const UI_ATTR = "data-gh-ui";\n' +
      SRC.slice(start, end) +
      `\nreturn { ${exportsList.join(', ')} };`
  )();
}

function mountDom(html, bodyStyle) {
  const attr = bodyStyle ? ` style="${bodyStyle}"` : '';
  const dom = new JSDOM(`<body${attr}>${html}</body>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  return dom.window.document;
}

const results = [];
const check = (name, ok) => results.push([name, !!(typeof ok === 'function' ? ok() : ok)]);

// ---- 1. Markdown conversion ----
{
  const doc = mountDom(`
    <div class="markdown">
      <p>A <strong>short</strong> explanation with <code>inline code</code> and a
         <a href="https://example.com">link</a>.</p>
      <h2>Steps</h2>
      <ol>
        <li>First step
          <ul><li>Sub A</li><li>Sub B</li></ul>
        </li>
        <li>Second step</li>
      </ol>
      <code-block>
        <div class="code-block-decoration"><span>javascript</span><button>Copy</button></div>
        <pre><code class="language-javascript">function foo() {
  return 42;
}</code></pre>
      </code-block>
      <table>
        <thead><tr><th>Name</th><th>Value</th></tr></thead>
        <tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody>
      </table>
      <blockquote><p>A quote.</p></blockquote>
      <button data-gh-ui>must not reach the output</button>
    </div>`);

  const mod = loadFromSource('const SKIP_TAGS', 'const USER_ROOTS', [
    'serializeChildren',
    'tidy',
  ]);
  const out = mod.tidy(mod.serializeChildren(doc.querySelector('.markdown'), 0));
  const noCode = out.replace(/```[\s\S]*?```/g, '```');

  console.log('--- markdown ---');
  console.log(out);
  console.log();

  check('code block keeps its language', out.includes('```javascript'));
  check('code survives verbatim', out.includes('return 42;'));
  check('language label does not leak into the text', !/^\s*javascript\s*$/m.test(out));
  check('inline code', out.includes('`inline code`'));
  check('bold', out.includes('**short**'));
  check('link', out.includes('[link](https://example.com)'));
  check('heading', out.includes('## Steps'));
  check('ordered list', /^1\. First step/m.test(out));
  check('nested list is indented', /^ {4}- Sub A/m.test(out));
  check('table header', out.includes('| Name | Value |'));
  check('table separator row', out.includes('| --- | --- |'));
  check('blockquote', out.includes('> A quote.'));
  check('our own UI is stripped', !out.includes('must not reach the output'));
  check(
    'no stray leading spaces outside list indentation',
    !noCode.split('\n').some((l) => /^\s+/.test(l) && !/^( {4})+[-*\d]/.test(l))
  );
  check('no triple blank lines', !/\n{3,}/.test(out));
}

// ---- 2. Turn extraction, without the duplicates ----
// Next to the visible prompt Gemini keeps a hidden screen reader block ("You
// said" plus a second copy) and an edit textarea holding the same text again.
// Without filtering, every prompt lands in the export three times.
{
  const doc = mountDom(`
    <user-query>
      <user-query-content>
        <div class="cdk-visually-hidden">
          <h5>You said</h5>
          <span>What is the difference between Ryzen AI and regular processors?</span>
        </div>
        <div class="query-content">
          <span class="query-text">
            <p>What is the difference between Ryzen AI and regular processors?</p>
          </span>
        </div>
        <textarea>What is the difference between Ryzen AI and regular processors?</textarea>
      </user-query-content>
    </user-query>
    <model-response>
      <div class="model-response-text">
        <div class="markdown"><p>The main difference is the <strong>NPU</strong>.</p></div>
      </div>
    </model-response>`);

  const mod = loadFromSource('const SKIP_TAGS', 'function buildContextString', [
    'turnToMarkdown',
  ]);
  const turns = Array.from(doc.querySelectorAll('user-query, model-response'));
  const parsed = turns.map(mod.turnToMarkdown);

  console.log('--- turns ---');
  for (const p of parsed) console.log(`--- ${p.role} ---\n${p.text}\n`);

  const user = parsed[0].text;
  check('prompt appears exactly once', (user.match(/Ryzen AI/g) || []).length === 1);
  check('no screen reader preamble', !user.includes('You said'));
  check('no heading leaked from the a11y block', !user.includes('#####'));
  check('textarea content ignored', !/processors\?[\s\S]*processors\?/.test(user));
  check('user turn detected', parsed[0].role === 'User');
  check('model turn detected', parsed[1].role === 'Gemini');
  check('answer text survives', parsed[1].text.includes('**NPU**'));
  check('answer is not duplicated', (parsed[1].text.match(/NPU/g) || []).length === 1);
}

// ---- 3. Theme switching without a reload ----
// Gemini flips light/dark at runtime, so colours cannot be baked into inline
// styles; they have to go through CSS variables we can reassign.
{
  const doc = mountDom('', 'background-color: rgb(30,31,32)');
  const mod = loadFromSource('const PALETTES', 'const STYLESHEET', [
    'detectTheme',
    'applyTheme',
    'PALETTES',
  ]);

  const surface = () =>
    doc.documentElement.style.getPropertyValue('--gh-surface').trim();

  mod.applyTheme(true);
  const darkDetected = mod.detectTheme();
  const darkVar = surface();

  doc.body.style.backgroundColor = 'rgb(255,255,255)';
  mod.applyTheme(false);
  const lightDetected = mod.detectTheme();
  const lightVar = surface();

  doc.body.style.backgroundColor = 'rgb(30,31,32)';
  mod.applyTheme(false);
  const backVar = surface();

  console.log('--- theme ---');
  console.log(`dark ${darkVar} / light ${lightVar} / back ${backVar}\n`);

  check('dark background detected', darkDetected === 'dark');
  check('light background detected', lightDetected === 'light');
  check('variable follows into dark', darkVar === mod.PALETTES.dark.surface);
  check('variable follows into light', lightVar === mod.PALETTES.light.surface);
  check('switching back works', backVar === mod.PALETTES.dark.surface);
  check('both palettes define the same keys', () => {
    const a = Object.keys(mod.PALETTES.dark).sort().join(',');
    const b = Object.keys(mod.PALETTES.light).sort().join(',');
    return a === b;
  });
}

// ---- 4. No inline colours left in the UI code ----
{
  const uiSection = SRC.slice(SRC.indexOf('function mk('));
  check(
    'UI code sets no inline hex colours',
    !/\.style\.[a-zA-Z]+\s*=\s*['"`]#/.test(uiSection)
  );
  check('no cssText assignments left', !/\.style\.cssText\s*=/.test(SRC));
  check('stylesheet uses CSS variables', SRC.includes('var(--gh-surface)'));
}

// ---- 5. Context assembly and briefing ----
{
  const mod = loadFromSource(
    'function buildContextString',
    'function getScrollContainer',
    ['buildContextString', 'buildBriefingContext']
  );

  const parts = [
    { role: 'User', text: 'First question' },
    { role: 'Gemini', text: 'First answer' },
  ];

  const full = mod.buildContextString(parts, true, false);
  const excerpt = mod.buildContextString(parts, false, false);
  const partial = mod.buildContextString(parts, true, true);
  const briefing = mod.buildBriefingContext('State: nothing settled yet.');

  check('whole history marked complete', full.includes('complete history'));
  check('partial history marked EXCERPT', excerpt.includes('EXCERPT'));
  check('user selection marked SELECTION', partial.includes('SELECTION'));
  check(
    'a selection never claims to be complete',
    !partial.includes('complete history')
  );
  check('roles are labelled', full.includes('--- User ---') && full.includes('--- Gemini ---'));
  check('empty selection returns null', mod.buildContextString([], true, false) === null);
  check(
    'empty turns are skipped',
    !mod.buildContextString([{ role: 'User', text: '' }, parts[0]], true, false).includes(
      '--- User ---\n\n'
    )
  );
  check('briefing context carries the text', briefing.includes('State: nothing settled yet.'));
  check('briefing is labelled as such', briefing.includes('--- BRIEFING ---'));
  check('empty briefing returns null', mod.buildBriefingContext('') === null);
}

// ---- 6. Previews in the selection list ----
{
  const mod = loadFromSource('const preview =', 'function openPanel', ['preview']);

  const long = 'a'.repeat(200);
  check('long preview is truncated', mod.preview(long).length <= 90);
  check('truncated preview ends in an ellipsis', mod.preview(long).endsWith('…'));
  check('short preview is left alone', mod.preview('Hello') === 'Hello');
  check(
    'code blocks collapse to a placeholder',
    mod.preview('Before\n```js\nconst x = 1;\n```\nAfter') === 'Before [Code] After'
  );
  check('newlines are folded away', !/\n/.test(mod.preview('a\n\n\nb')));
}

// ---- 7. Consistency across files ----
// Settings are declared in content.js and popup.js. Let those drift and the
// popup edits something the content script never reads.
{
  const POPUP_JS = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');
  const POPUP_HTML = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');
  const MANIFEST = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')
  );

  const keysOf = (src) => {
    const m = src.match(/(?:DEFAULT_SETTINGS|DEFAULTS) = \{([\s\S]*?)\}/);
    if (!m) return null;
    return (m[1].match(/^\s*(\w+):/gm) || [])
      .map((x) => x.trim().replace(':', ''))
      .sort()
      .join(',');
  };

  check('settings keys match across files', keysOf(SRC) === keysOf(POPUP_JS));
  check(
    'briefing prompt lives only in the locales',
    !SRC.includes('DEFAULT_BRIEFING_PROMPT') && !POPUP_JS.includes('DEFAULT_BRIEFING_PROMPT')
  );

  check('popup loads popup.js as an external file', POPUP_HTML.includes('src="popup.js"'));
  check(
    'no inline handlers in the popup (MV3 CSP)',
    !/\son(click|change|input|load)\s*=/i.test(POPUP_HTML)
  );
  check('manifest points at the popup', MANIFEST.action?.default_popup === 'popup.html');
  check('no activeTab', !MANIFEST.permissions.includes('activeTab'));
  check('all four icon sizes declared', ['16', '32', '48', '128'].every((s) => MANIFEST.icons?.[s]));
  check(
    'icon files exist',
    ['16', '32', '48', '128'].every((s) =>
      fs.existsSync(path.join(__dirname, MANIFEST.icons[s]))
    )
  );

}

// ---- 8. Localisation ----
// English is the default. Every key the code uses has to exist in EVERY
// locale, otherwise the UI shows the raw key name — and only to users running
// that language, which means you will never see it yourself.
{
  const MANIFEST = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')
  );
  const POPUP_JS = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');
  const POPUP_HTML = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');

  const localeDir = path.join(__dirname, '_locales');
  const locales = fs.existsSync(localeDir) ? fs.readdirSync(localeDir).sort() : [];

  check('locale folders present', locales.length >= 2);
  check('English is the default locale', MANIFEST.default_locale === 'en');
  check('default locale has a folder', locales.includes('en'));
  check('German locale present', locales.includes('de'));
  check('name comes from the locales', MANIFEST.name === '__MSG_extName__');
  check(
    'description comes from the locales',
    MANIFEST.description === '__MSG_extDescription__'
  );

  const msgs = {};
  for (const loc of locales) {
    msgs[loc] = JSON.parse(
      fs.readFileSync(path.join(localeDir, loc, 'messages.json'), 'utf8')
    );
  }

  const keysEn = Object.keys(msgs.en || {}).sort();
  for (const loc of locales) {
    if (loc === 'en') continue;
    const keys = Object.keys(msgs[loc]).sort();
    check(
      `locale "${loc}" defines the same keys as en`,
      JSON.stringify(keys) === JSON.stringify(keysEn)
    );
    const empty = keys.filter((k) => !String(msgs[loc][k].message || '').trim());
    check(`locale "${loc}" has no empty strings`, empty.length === 0);
  }

  // Every key the code uses has to exist ...
  const used = new Set();
  for (const m of SRC.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)) used.add(m[1]);
  for (const m of POPUP_JS.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)) used.add(m[1]);
  for (const m of POPUP_HTML.matchAll(/data-i18n(?:-placeholder)?="([A-Za-z0-9_]+)"/g)) {
    used.add(m[1]);
  }
  for (const m of JSON.stringify(MANIFEST).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
    used.add(m[1]);
  }

  const missing = [...used].filter((k) => !keysEn.includes(k));
  check(`every key used is defined (${used.size} checked)`, () => {
    if (missing.length) console.log('   missing:', missing.join(', '));
    return missing.length === 0;
  });

  // ... and nothing should be sitting there unused.
  const unused = keysEn.filter((k) => !used.has(k));
  check(`no unused keys`, () => {
    if (unused.length) console.log('   unused:', unused.join(', '));
    return unused.length === 0;
  });

  // Placeholder names have to be identical across locales.
  let placeholderMismatch = [];
  for (const k of keysEn) {
    const refs = (s) => [...String(s).matchAll(/\$([A-Z_]+)\$/g)].map((m) => m[1]).sort().join(',');
    for (const loc of locales) {
      if (loc === 'en') continue;
      if (refs(msgs.en[k].message) !== refs(msgs[loc][k].message)) {
        placeholderMismatch.push(`${loc}/${k}`);
      }
    }
  }
  check('placeholders match across locales', () => {
    if (placeholderMismatch.length) console.log('   mismatched:', placeholderMismatch.join(', '));
    return placeholderMismatch.length === 0;
  });

  check(
    'numbers are not pinned to one locale',
    !SRC.includes("toLocaleString('de-DE')") && !POPUP_JS.includes("toLocaleString('de-DE')")
  );
}

// ---- 9. Free, with no leftovers from the paywall ----
// If any of the licence code survives, the manifest ends up asking for
// permissions nothing needs, which costs you in review and in trust.
{
  const MANIFEST = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')
  );
  const POPUP_JS = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');
  const all = SRC + POPUP_JS + JSON.stringify(MANIFEST);

  check('no licence check left in the code', !/isPro|refreshLicense|ExtPay|extensionpay/i.test(all));
  check('no upsell left in the code', !/upsell/i.test(SRC));
  check('no service worker', !MANIFEST.background);
  check('no host permissions', !MANIFEST.host_permissions);
  check('no CSP exception needed', !MANIFEST.content_security_policy);
  check('ExtPay.js is gone', !fs.existsSync(path.join(__dirname, 'ExtPay.js')));
  check('background.js is gone', !fs.existsSync(path.join(__dirname, 'background.js')));
  check(
    'exactly two permissions',
    JSON.stringify([...MANIFEST.permissions].sort()) ===
      JSON.stringify(['clipboardWrite', 'storage'])
  );
  check(
    'content script only on Gemini',
    MANIFEST.content_scripts.length === 1 &&
      MANIFEST.content_scripts[0].matches.join() === 'https://gemini.google.com/*'
  );
}

// ---- 10. Shippable files ----
{
  const need = [
    'LICENSE',
    'README.md',
    'STORE.md',
    'ROADMAP.md',
    'IDEAS.md',
    '.gitignore',
    'docs/privacy.html',
    '_locales/en/messages.json',
    '_locales/de/messages.json',
  ];
  for (const f of need) {
    check(`file present: ${f}`, fs.existsSync(path.join(__dirname, f)));
  }

  const PRIV = fs.readFileSync(path.join(__dirname, 'docs/privacy.html'), 'utf8');
  check(
    'privacy policy names the transfer to Google',
    PRIV.includes('Google') && PRIV.includes('Briefing')
  );
  check(
    'privacy policy lists every permission',
    ['storage', 'clipboardWrite', 'gemini.google.com'].every((x) => PRIV.includes(x))
  );
  check(
    'privacy policy states there is no server',
    /keinen? Server|no server/i.test(PRIV)
  );
}

// ---- 11. Jumping to a message ----
// We jump to the START of a message, not its middle, with an offset for the
// pinned header. Otherwise the beginning of a long answer sits above the
// viewport or behind Gemini's own bar.
{
  const doc = mountDom('<header class="app-header" style="position: fixed"></header>');

  // jsdom has no layout, so rectangles come out of data-rect.
  doc.defaultView.Element.prototype.getBoundingClientRect = function () {
    const r = JSON.parse(this.dataset.rect || '{}');
    return {
      top: r.top || 0,
      bottom: r.bottom || 0,
      height: r.height || 0,
      width: r.width || 0,
      left: 0,
      right: 0,
    };
  };

  const header = doc.querySelector('header');
  header.dataset.rect = JSON.stringify({ top: 0, bottom: 64, height: 64, width: 1024 });

  let container = null;
  const mod = new Function(
    'const UI_ATTR = "data-gh-ui";\n' +
      'function getScrollContainer() { return globalThis.__c; }\n' +
      SRC.slice(SRC.indexOf('function topObstruction'), SRC.indexOf('function isLoading')) +
      '\nreturn { scrollToTurn, topObstruction };'
  )();

  check('pinned header is measured', mod.topObstruction() === 64);

  const target = {
    isConnected: true,
    offsetWidth: 1,
    classList: { add() {}, remove() {} },
    getBoundingClientRect: () => ({ top: 500 }),
  };

  // A: container starts at the very top, so the bar covers it.
  let got;
  globalThis.__c = container = {
    scrollTop: 1000,
    getBoundingClientRect: () => ({ top: 0 }),
    scrollTo: (o) => (got = o),
  };
  mod.scrollToTurn(target);
  check('offset applied when the bar covers the container', got.top === 1000 + 500 - (64 + 12));
  check('scrolling is smooth', got.behavior === 'smooth');

  // B: container already starts below the bar, so just a small gap.
  globalThis.__c = container = {
    scrollTop: 1000,
    getBoundingClientRect: () => ({ top: 64 }),
    scrollTo: (o) => (got = o),
  };
  mod.scrollToTurn(target);
  check('no double offset when it does not', got.top === 1000 + (500 - 64) - 12);

  // C: target is already near the top; don't scroll past zero.
  globalThis.__c = container = {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    scrollTo: (o) => (got = o),
  };
  mod.scrollToTurn({ ...target, getBoundingClientRect: () => ({ top: 10 }) });
  check('never scrolls to a negative offset', got.top === 0);

  check(
    "jump no longer uses block:'center'",
    !/scrollIntoView\(\{[^}]*block:\s*'center'/.test(SRC)
  );
  check('peek mode hides the card', SRC.includes('.gh-overlay--peek'));
}



console.log('--- results ---');
let failed = 0;
for (const [name, ok] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
