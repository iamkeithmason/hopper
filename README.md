# Hopper

A personal, AI-organised replacement for Google Keep. One hopper for bookmarks, notes, quotes and images: no filing decisions at capture, and the AI organises afterwards.

Live at <https://hopper-keith.vercel.app> (sign-in is limited to one email address).

## What's here

| Folder | What it is |
|---|---|
| `app/` | The PWA: plain HTML, CSS and JavaScript, no build step. Installable on Android, with a share target at `/share`. `/oauth/consent` is the OAuth consent page for MCP clients. `app/api/shot.js` is the one server function: page screenshots (see below). |
| `extension/` | Chrome/Brave extension (HOP-8): save pages, images, quotes and screenshots. Load unpacked; see its README. |
| `supabase/functions/` | Edge functions (Deno) for the Supabase project. |
| `supabase/schema.sql` | Reference snapshot of the `hopper` schema. |
| `tests/feed_check.py` | Feed smoke test: the real app against a fake API in headless Chrome. Checks cards never move, scrolling keeps loading on tall screens, and loading stops at the end. Run `python3 tests/feed_check.py` (needs Playwright and Chrome) before pushing feed or layout changes. |
| `tests/contrast_check.py` | WCAG AA audit: every Keep colour and none, light and dark, cards, header and the open note; every visible text and placeholder at 4.5:1, chip outlines and icons at 3:1. Run before pushing colour or style changes. |

### Edge functions

| Function | Does |
|---|---|
| `hopper-api` | Everything the app calls: projects, feed, search by meaning, note detail, editing, tags, lock, capture, delete, and `screenshot` (screenshots of a note's page, or `{ url }` for another page of the same site, added to the note as a link). Capture also takes `image_urls` and a `screenshot` flag. |
| `hopper-tag` | Tags notes with Claude (projects, topics, people, works, format) and locks notes the classifier calls sensitive. Reads unlocked notes only. |
| `hopper-fetch` | Fetches page titles, text and thumbnails for links in notes. |
| `hopper-embed` | Embeds notes with gte-small (384 dimensions) for search and related notes; `refresh` re-embeds after a design read. |
| `hopper-design` | Design teardown of stored images (HOP-20): measured palette plus Claude's read of type, layout, aesthetics, visual moves and how to borrow from it, saved to `attachments.design_read`. Aesthetic tags come from `hopper.aesthetics`, moves (annotated-screen, component-collage...) from `hopper.moves` and onto `attachments.moves`. Reads are factual: the model sees the image, its palette and its page context, never the note's title, text or why-saved line; a separate text-only Haiku call writes `relevance_to_owner` when there is a why-saved line. Captured pages are read as pages: one page read per page (first screen, structure, width, image treatment, type and colour, moves, strengths, gaps, how to borrow) from its screenshots and capture facts, stored on the page's link (`note_links.layout_read`); the screenshots get no reads of their own, and figures from a page get a light read (summary, moves, annotations). Reads unlocked notes only. |
| `hopper-mcp` | MCP server (HOP-18) so Claude can search Hopper and its design references from any chat: `search_references`, `get_reference` (with the image), `list_aesthetics`, `search_notes`, `get_note`, `list_projects`, `list_benchmarks` (portfolio benchmark scores, sortable and filterable), `list_moves`, with `moves` as a `search_references` filter, plus one append-only write, `save_to_hopper` (a URL, why-saved line, quote and up to 4 image addresses, which Hopper fetches and keeps; source `assistant`, duplicate URLs skipped, 60 saves an hour at most; `page_screenshot` adds a first screen, a whole page and a phone first screen; `add_to` adds another page of the same site to an existing note, as screenshots and a link). OAuth, or a bearer token from Vault (`hopper_mcp_token`). |
| `hopper-clip` | Gateway for the browser extension: checks the capture-only token (Vault `hopper_capture_token`) and passes captures to `hopper-api`. It can save but never read. |
| `hopper-import` | Imports images captured outside Hopper (the portfolio benchmark page captures): the database asks for a two-hour upload ticket for one note, the images go up with it, then a record step stores each image's page context (role, page, caption, rendered size and position at 1440) and each page's height, video count and layout read. Images already on the note gain the context instead of being stored twice. |
| `hopper-import-wp` | One-off import of the *On the Ruin of Britain* WordPress posts as notes. |

## How it fits together

- **Database:** Supabase, schema `hopper` in the "stromata" project. No table is exposed to the browser; the app only talks to `hopper-api`.
- **Auth:** Supabase magic link (PKCE). `hopper-api` checks the signed-in email against `hopper.settings.owner_email`.
- **Function-to-function calls:** each function checks an `x-hopper-token` header against a sha256 hash in `hopper.settings`. The token itself lives in Supabase Vault (`hopper_invoke_token`), never in this repo.
- **Page screenshots:** `hopper-api` posts the address to `/api/shot` on the Vercel project (headless Chrome via `@sparticuz/chromium`, with DejaVu Sans bundled in `app/fonts` for symbols), which returns a 1440×900 first screen, a whole-page shot and a phone first screen (390×844 at 2x, phone user agent, its own browser, taken only while time remains). The whole page is stitched from screen-sized frames taken while scrolling (so fixed backgrounds and sticky layers render as a reader sees them; small fixed headers are hidden after the first frame so they don't repeat), then scaled down (to 40% at least) to fit 8,000px tall, Claude's image limit, and cut off below that. The service also reports the page's six largest images by rendered area and its video count; Hopper keeps those figures as `image_role` `figure` with their rendered size, position and caption, and an image already on the note only gains that context. They are stored per page with the same scheme as `hopper-import`: `original_file` `capture:<page>#first-screen-1440`, `#full-page` or `#first-screen-390`, with `image_role`, `source_page_url` and `captured_on`, and the page goes on the note as a link with `page_height_px_at_1440`. One note can hold several pages (a portfolio's home, case studies, about); taking a page again replaces its files and clears their design reads, and `views` retakes only some (e.g. just the phone screen). `prune_shots` (invoke token only) removes screenshot files no attachment points at. The service checks an `x-shot-token` header against `SHOT_TOKEN_SHA256` in the Vercel environment; the token is in Vault (`hopper_shot_token`) and the address in `settings.shot_url`. If Chrome crashes it tries once more in a lighter mode, and keeps a first screen on its own if the whole page fails. Pages that scroll inside their own container report a page height of one screen.
- **Locked notes:** never sent to an AI model. AI work reads through the `hopper.notes_for_ai` view, which excludes them; locking a note also deletes its embedding.

## Using Hopper from Claude (MCP)

The `hopper-mcp` function is an MCP server at `https://hhfjfbuiuhhdhwhfwlpv.supabase.co/functions/v1/hopper-mcp`.
It needs a bearer token, which lives only in Supabase Vault as `hopper_mcp_token` (Supabase dashboard, Vault page).
To add it to Claude Code:

```
claude mcp add --transport http hopper https://hhfjfbuiuhhdhwhfwlpv.supabase.co/functions/v1/hopper-mcp --header "Authorization: Bearer <token from Vault>"
```

claude.ai and the desktop app sign in with OAuth instead: Supabase Auth's OAuth 2.1 server (Authentication > OAuth Server,
authorization path `/oauth/consent`, dynamic client registration on) sends the browser to the app's consent page
(`app/consent.html`), and `hopper-mcp` accepts the resulting token only for `settings.owner_email`. Add the server URL above
as a custom connector in claude.ai (Settings > Connectors); the desktop and mobile apps pick it up from there.
To rotate the token, run the block in `supabase/migrations/20261119093000_hopper_mcp_token.sql` again.

## Deploying

- **App:** Vercel project `hopper-keith`, root directory `app`. Pushing to `main` deploys to production.
- **Functions:** deployed to Supabase separately (connector or `supabase functions deploy <name>`), all with JWT verification off; each function does its own auth check.

## Secrets

None are committed. The functions read `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` and `HOPPER_API` (the Claude API key) from the Supabase environment. The Supabase publishable key in `app/app.js` is public by design.
