# Handover for Gemini

Continue a long Gemini conversation in a fresh chat — without losing the context.

> **Status:** in development. Not yet on the Chrome Web Store.

## The problem

Long Gemini conversations become slow, and the chat history is virtualised — you
cannot simply select it and copy it. So when a thread gets too long, you either
keep fighting the lag or start over and re-explain everything from scratch.

## What it does

- **Loads the full history.** Scrolls the conversation to the top until every
  message is actually in the DOM, and tells you how many it captured. If it
  cannot confirm it reached the beginning, it says so rather than silently
  handing over half a conversation.
- **Keeps the formatting.** Code blocks stay code blocks, with their language.
  Lists, tables, headings, blockquotes and links survive the move.
- **Hands over in one click.** Opens a new Gemini tab and fills the input with
  the context, ready to continue. Or copies it to your clipboard as Markdown.
- **Shows the size first.** Message count and character count before you commit,
  with a warning when the input is likely to be truncated.

- **Pick individual messages.** Every turn in a list with a preview, quick
  filters (all / none / last N / your prompts only), and a jump button that
  scrolls to that message in the chat.
- **Handover briefing.** Instead of carrying 150 messages across, Gemini
  summarises the conversation itself — goal, decisions, current state, open
  points, code — and that briefing becomes the context for the new chat.
  No API key, no backend, no cost: the chat that has the context writes it.

Free, with no paid tier and nothing held back.

## Privacy

Your conversations are read in your browser and are **never sent to me or to
anyone else**. No analytics, no tracking, no account.

The extension runs only on `gemini.google.com` and contacts no server at all —
there is nothing for it to contact.

One thing is worth being precise about: the handover text is typed into a new
Gemini tab, and the briefing prompt is sent into your existing chat. Both go to
Google, exactly as if you had typed them yourself — that is the whole point of
the feature.

Full details: [Privacy policy](docs/privacy.html).

The source is in this repository. Read it before you install it.

## Install

**From source (development):**

1. Clone this repository.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the project folder.

**From the Chrome Web Store:** coming soon.

## Development

```
npm install jsdom     # once
node test-markdown.js # 60+ tests, no build step
```

The tests load the functions straight out of `content.js`, so they cannot drift
away from the implementation. They cover the DOM→Markdown conversion, turn
extraction (including Gemini's hidden screen-reader duplicates), theme
switching, scroll-offset maths, and consistency between `content.js`,
`popup.js` and `manifest.json`.

### Files

| File | Purpose |
|---|---|
| `content.js` | Everything that runs on the Gemini page |
| `popup.html` / `popup.js` | Settings |
| `test-markdown.js` | Test suite |
| `_locales/` | UI strings — English (default) and German |
| `docs/privacy.html` | Privacy policy (GitHub Pages) |

## Translations

The interface is English by default and follows the browser's UI language where
a translation exists. Adding one is a single file: copy `_locales/en/messages.json`
to `_locales/<code>/messages.json` and translate the `message` values — leave the
keys and the `$PLACEHOLDER$` markers alone. `node test-markdown.js` then checks
that your locale has exactly the same keys and placeholders as English, so a
missing string fails the tests instead of showing a raw key to users.

## Contributing

Bug reports and feature requests are welcome via GitHub Issues. If a handover
came out incomplete, please include your Chrome version and roughly how long the
conversation was.

## Trademarks

Gemini™ is a trademark of Google LLC. This extension is an independent project and is not affiliated with, endorsed by, or sponsored by Google.

## License

MIT — see [LICENSE](LICENSE).
