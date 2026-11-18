# Hopper

A personal, AI-organised replacement for Google Keep. One hopper for bookmarks, notes, quotes and images: no filing decisions at capture, and the AI organises afterwards.

Live at <https://hopper-keith.vercel.app> (sign-in is limited to one email address).

## What's here

| Folder | What it is |
|---|---|
| `app/` | The PWA: plain HTML, CSS and JavaScript, no build step. Installable on Android, with a share target at `/share`. |
| `supabase/functions/` | Edge functions (Deno) for the Supabase project. |
| `supabase/schema.sql` | Reference snapshot of the `hopper` schema. |

### Edge functions

| Function | Does |
|---|---|
| `hopper-api` | Everything the app calls: projects, feed, search by meaning, note detail, editing, tags, lock, capture, delete. |
| `hopper-tag` | Tags notes with Claude (projects, topics, people, works, format) and locks notes the classifier calls sensitive. Reads unlocked notes only. |
| `hopper-fetch` | Fetches page titles, text and thumbnails for links in notes. |
| `hopper-embed` | Embeds notes with gte-small (384 dimensions) for search and related notes. |
| `hopper-import-wp` | One-off import of the *On the Ruin of Britain* WordPress posts as notes. |

## How it fits together

- **Database:** Supabase, schema `hopper` in the "stromata" project. No table is exposed to the browser; the app only talks to `hopper-api`.
- **Auth:** Supabase magic link (PKCE). `hopper-api` checks the signed-in email against `hopper.settings.owner_email`.
- **Function-to-function calls:** each function checks an `x-hopper-token` header against a sha256 hash in `hopper.settings`. The token itself lives in Supabase Vault (`hopper_invoke_token`), never in this repo.
- **Locked notes:** never sent to an AI model. AI work reads through the `hopper.notes_for_ai` view, which excludes them; locking a note also deletes its embedding.

## Deploying

- **App:** Vercel project `hopper-keith`, root directory `app`. Pushing to `main` deploys to production.
- **Functions:** deployed to Supabase separately (connector or `supabase functions deploy <name>`), all with JWT verification off; each function does its own auth check.

## Secrets

None are committed. The functions read `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` and `HOPPER_API` (the Claude API key) from the Supabase environment. The Supabase publishable key in `app/app.js` is public by design.
