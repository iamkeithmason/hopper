# Hopper

A personal, AI-organised replacement for Google Keep. One hopper for bookmarks, notes, quotes and images: no filing decisions at capture, and the AI organises afterwards.

Live at <https://hopper-keith.vercel.app> (sign-in is limited to one email address).

## What's here

| Folder | What it is |
|---|---|
| `app/` | The PWA: plain HTML, CSS and JavaScript, no build step. Installable on Android, with a share target at `/share`. `/oauth/consent` is the OAuth consent page for MCP clients. |
| `supabase/functions/` | Edge functions (Deno) for the Supabase project. |
| `supabase/schema.sql` | Reference snapshot of the `hopper` schema. |

### Edge functions

| Function | Does |
|---|---|
| `hopper-api` | Everything the app calls: projects, feed, search by meaning, note detail, editing, tags, lock, capture, delete. |
| `hopper-tag` | Tags notes with Claude (projects, topics, people, works, format) and locks notes the classifier calls sensitive. Reads unlocked notes only. |
| `hopper-fetch` | Fetches page titles, text and thumbnails for links in notes. |
| `hopper-embed` | Embeds notes with gte-small (384 dimensions) for search and related notes; `refresh` re-embeds after a design read. |
| `hopper-design` | Design teardown of stored images (HOP-20): measured palette plus Claude's read of type, layout, aesthetics and how to borrow from it, saved to `attachments.design_read`. Aesthetic tags come from the shared vocabulary in `hopper.aesthetics`. Reads unlocked notes only. |
| `hopper-mcp` | Read-only MCP server (HOP-18) so Claude can search Hopper and its design references from any chat: `search_references`, `get_reference` (with the image), `list_aesthetics`, `search_notes`, `get_note`, `list_projects`. Bearer token from Vault (`hopper_mcp_token`). |
| `hopper-import-wp` | One-off import of the *On the Ruin of Britain* WordPress posts as notes. |

## How it fits together

- **Database:** Supabase, schema `hopper` in the "stromata" project. No table is exposed to the browser; the app only talks to `hopper-api`.
- **Auth:** Supabase magic link (PKCE). `hopper-api` checks the signed-in email against `hopper.settings.owner_email`.
- **Function-to-function calls:** each function checks an `x-hopper-token` header against a sha256 hash in `hopper.settings`. The token itself lives in Supabase Vault (`hopper_invoke_token`), never in this repo.
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
