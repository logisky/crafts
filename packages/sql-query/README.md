# sql-query

Run SQL against a database and pull the result into a typed block. Run it
again and the same block is replaced with fresh rows.

**Needs the `dataConnections` host capability** (`craftRequires` in
`package.json`), which only the LogiSheets desktop app provides. Elsewhere
Browse shows it as *needs database connections* and will not install it; the
page also checks `window.dataConnections` itself and says so if it is missing.

## How it works

- Connections are the **host's**: the user adds them in the craft manager's
  *Connections* tab (opened from here with **Manage…**). The password lives in
  the OS keychain; this craft never sees it.
- **Run** calls `window.dataConnections.query(connId, sql, {maxRows})`. The
  query is read-only, capped and timed out by the host.
- The result becomes a block: a header line of column names, one line per
  row, and a schema typed from the result's column types (`number`,
  `boolean`, `datetime` for dates and date-times, `string` otherwise).
- **Craft state** (saved in the workbook) holds the SQL, the max-rows setting,
  the connection **id** and the block it wrote — never credentials. Opened on
  another computer, the id does not resolve and the craft asks the user to pick
  a connection.

## Value rules

`src/index.ts` `cellInput` decides what each value is typed as:

| Value | Written as |
| --- | --- |
| `null` | nothing — the cell stays **empty** (not `""`) |
| boolean | `TRUE` / `FALSE` |
| number | the number |
| exact decimal string (NUMERIC, big BIGINT) | the number, unless it has more than 15 significant digits — then the exact text |
| text the input parser would reinterpret (`=…`, `00123`, `true`) | a formula that evaluates to exactly that text |
| date, date-time | a date serial, shown through the field's number format (`yyyy-mm-dd` / `yyyy-mm-dd hh:mm:ss`); zoned values are already UTC. Before 1900-03-01, as text |

## Refresh

Re-running replaces the block the last run wrote — `removeBlock` +
`createBlock` in one undoable transaction, at the block's current position, as
long as it still exists and is still owned by `sql-query`. The block keeps its
id and ref name (`sql_<sheet>_<block>`), so a formula that names it keeps
working across refreshes. This needs an engine with logisky/LogiSheets#528,
which made `removeBlock` free the id's state within the transaction. *Write the next run
to a new block* forgets it, so the next run starts a new block under the
sheet's data.
