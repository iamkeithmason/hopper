-- Like every other hopper table: row level security on, no policies. Only hopper-api (database role) reads or writes it.
alter table hopper.ui_events enable row level security;
