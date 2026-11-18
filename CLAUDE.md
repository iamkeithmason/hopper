# Working on Hopper

Read `README.md` for the layout. Project docs (decisions, build log, runbooks) live in the claude.ai Project "Hopper"; the feature backlog is in Notion (Hopper hub → Feature Backlog, ICE scored).

Every backlog ticket carries a **Hands-off** flag: *Runs unattended* (Claude can do it start to finish), *Needs a pop-up* (only a Supabase confirmation), or *Needs Keith* (design calls, phone testing, secrets). Set it when you create or rescope a ticket, and say which tickets are hands-off when Keith asks what to work on.

## Rules

- Locked notes must never reach an AI model. AI work reads through `hopper.notes_for_ai`. Never add a code path that sends `hopper.notes` content to a model without that filter.
- Never commit secrets, and never paste or ask for them in chat. Keys live in the Supabase environment and Vault.
- Ask Keith before destructive or costly database changes (deletes, bulk updates, paid model runs), and warn him before anything that triggers a Supabase confirmation pop-up.
- No new paid services beyond Claude; Claude API credit is fine.
- Design changes that are ambiguous: talk them back and confirm before building.
- `hopper.note_cards` is a view: new columns can only be appended at the end.
- After changing `supabase/functions/*`, deploy that function to Supabase; after changing the schema, refresh `supabase/schema.sql`.

## Style

British English. No em dashes (use a comma, colon or en dash). In the app, `replaceChildren` calls filter out nulls (`.filter(Boolean)`), or "null" appears as text.
