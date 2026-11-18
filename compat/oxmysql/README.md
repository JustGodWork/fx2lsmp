# oxmysql compat resource

The oxmysql API (exports and the `MySQL` global) over `lsmp.mysql`, for FiveM resources migrated with fx2lsmp.

## Install

1. Convert it like any resource, passing the server.cfg that holds the connection string:
   `npm run fx2lsmp -- compat/oxmysql <server>/resources/oxmysql --cfg server.cfg`
2. Set the convar in server.cfg (URI or `key=value;` form, both are read):
   `set mysql_connection_string "mysql://user:password@127.0.0.1:3306/database?connectionLimit=8"` or
   `set mysql_connection_string "host=127.0.0.1;port=3306;user=user;password=password;database=database"`
3. `lsmp.mysql` is refused to sandboxed resources, so the operator must trust this resource. In `resources.json`, next
   to server.cfg:

```json
{
  "resources": {
    "oxmysql": { "sandbox": false }
  }
}
```

Without it the pool creation fails with `permission` (logged with this hint) and every query raises.

## Consumers

A resource whose manifest lists `'@oxmysql/lib/MySQL.lua'` in `server_scripts` gets a bundled copy of
`lib/MySQL.lua` at the same position in its script list, as `_fxcompat/libs/oxmysql/MySQL.lua`; fx2lsmp prints a
warning to remind you of the step above. Keep the `oxmysql` resource started before the consumers
(`dependency 'oxmysql'` in their manifest).

## Coverage

- Exports (callback form, and `_async` form returning the result): `query`, `single`, `scalar`, `insert`, `update`,
  `prepare`, `rawExecute`, `transaction`, `startTransaction`, plus `isReady` and `awaitConnection`.
- `MySQL` global: the same methods with `.await`, `MySQL.ready`, `MySQL.store`, and the legacy `MySQL.Async` and
  `MySQL.Sync` (`fetchAll`, `fetchScalar`, `execute`, `insert`, `transaction`).
- Placeholders: `?` with a list (nil becomes SQL NULL), `@name` and `:name` with a map (keys with or without the
  prefix). Quotes, comments and `@@variables` are left alone; a name missing from the map stays as written.
- Results: `lsmp.null` becomes nil in rows; `insert` returns `insertId`, `update` returns `affectedRows`, `scalar`
  the first column of the first row, `single` the first row, `transaction` a boolean.
- `prepare`: one row of one column gives the value, one row gives the row, several rows give the rows, no row gives
  nil; a list of parameter lists runs the statement once per list. A non SELECT returns the write summary.

## Gaps

- LS:MP rows have no column order: `scalar` and `prepare` on a multi-column SELECT read the first selected name from
  the SQL text (`AS alias`, `table.column` or a bare column) and warn once when they cannot.
- Only `?`, `@name` and `:name` are rewritten; `mysql_*` convars other than the connection string, `MySQL.ready`
  timing and slow query logging are not implemented. Only utf8mb4, utf8, latin1 and binary charsets exist
  (`utf8mb4_unicode_ci` is read as `utf8mb4`).
- An error in the callback forms is logged and the callback gets nil; the `await` forms raise with the database message.
- Trailing nil parameters do not cross the export boundary (`{ 'a', nil, nil }` arrives as one value): missing
  positions up to the number of `?` marks (outside quotes and comments) are sent as SQL NULL, as oxmysql does.
- Verified against a real MariaDB (127.0.0.1) on the real LS:MP server with a FiveM-style test resource (70 checks:
  callback, `.await`, export and legacy forms, `?`/`@name`/`:name`, NULL to nil, prepare with a list of parameter lists,
  transaction commit and rollback, `startTransaction`, bad SQL in both forms). The connection string stays in
  `_fxcompat/server_convars.json`, which is not part of the client package.
