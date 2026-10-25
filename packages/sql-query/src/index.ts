// sql-query craft — pure, host-agnostic helpers.
//
// The user picks a database connection the HOST holds (credentials never reach
// this craft), writes SQL, and the result lands in a typed block. Running it
// again replaces that block in place, so the block is a refreshable view of
// the query.
//
// Everything here is a pure function; the DOM and the `window.workbook` /
// `window.dataConnections` calls live in index.html. The API it consumes is
// `window.dataConnections` (the `dataConnections` host capability — see
// docs/craft/data-connections.md in the LogiSheets repo). The types below
// mirror its contract rather than import it, as the host's own package is not
// a dependency of a craft.

import {isErrorMessage} from 'logisheets-web'
import type {EditPayload, ErrorMessage, Transaction} from 'logisheets-web'

export type DataColumnType =
    | 'number'
    | 'text'
    | 'boolean'
    | 'date'
    | 'datetime'
    | 'time'

/** `null` is an EMPTY cell, which is not the same as `''`. */
export type DataCellValue = string | number | boolean | null

export interface DataColumn {
    name: string
    type: DataColumnType
    dbType: string
}

export interface DataQueryResult {
    columns: DataColumn[]
    rows: DataCellValue[][]
    truncated: boolean
}

/** Every client read returns `V | ErrorMessage` rather than throwing. */
export function errOf(v: unknown): string | null {
    return isErrorMessage(v) ? (v as ErrorMessage).msg : null
}

export const OWNER = 'sql-query'

/** What the craft remembers in the workbook. Never credentials. */
export interface SqlQueryState {
    /** The host's connection id; resolves to nothing on another machine. */
    connId?: string
    sql: string
    maxRows: number
    /** The block the last run wrote, refreshed in place by the next. */
    target?: BlockTarget
}

export interface BlockTarget {
    sheetIdx: number
    blockId: number
    masterRow: number
    masterCol: number
    refName: string
}

export const DEFAULT_MAX_ROWS = 1000

export function parseState(json: string | undefined | null): SqlQueryState {
    const fallback: SqlQueryState = {sql: '', maxRows: DEFAULT_MAX_ROWS}
    if (!json) return fallback
    try {
        const s = JSON.parse(json) as Partial<SqlQueryState>
        return {
            connId: typeof s.connId === 'string' ? s.connId : undefined,
            sql: typeof s.sql === 'string' ? s.sql : '',
            maxRows:
                typeof s.maxRows === 'number' && s.maxRows > 0
                    ? s.maxRows
                    : DEFAULT_MAX_ROWS,
            target: isTarget(s.target) ? s.target : undefined,
        }
    } catch {
        return fallback
    }
}

function isTarget(t: unknown): t is BlockTarget {
    const o = t as BlockTarget | undefined
    return (
        !!o &&
        typeof o.sheetIdx === 'number' &&
        typeof o.blockId === 'number' &&
        typeof o.masterRow === 'number' &&
        typeof o.masterCol === 'number' &&
        typeof o.refName === 'string'
    )
}

/** The block field kind for a result column. */
export function fieldKind(type: DataColumnType): 'number' | 'boolean' | 'datetime' | 'string' {
    switch (type) {
        case 'number':
            return 'number'
        case 'boolean':
            return 'boolean'
        case 'date':
        case 'datetime':
            return 'datetime'
        default:
            return 'string'
    }
}

/**
 * Field names: the column names, made unique and non-empty. SQL allows two
 * columns called `count`; a schema does not.
 */
export function fieldNames(columns: readonly DataColumn[]): string[] {
    const seen = new Map<string, number>()
    return columns.map((c, i) => {
        const base = c.name.trim() || `column_${i + 1}`
        const key = base.toLowerCase()
        const n = (seen.get(key) ?? 0) + 1
        seen.set(key, n)
        return n === 1 ? base : `${base}_${n}`
    })
}

/**
 * The number format a field shows its values in. Dates are stored as serial
 * numbers (as the app's own date picker writes them), so without one a date
 * reads as 46090.
 */
export function numFmt(type: DataColumnType): string {
    if (type === 'date') return 'yyyy-mm-dd'
    if (type === 'datetime') return 'yyyy-mm-dd hh:mm:ss'
    return ''
}

const DAY_MS = 86400000
// Serial 1 is 1900-01-01, but serial 60 is the 1900-02-29 that never was, so
// counting from 1899-12-30 is right from 1900-03-01 on.
const SERIAL_EPOCH = Date.UTC(1899, 11, 30)
const FIRST_SAFE = Date.UTC(1900, 2, 1)
const DATE_TIME =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?)?Z?$/

/**
 * `2026-03-09` / `2026-03-09T15:30:00[.250][Z]` as a spreadsheet date serial,
 * or null when it does not parse or predates 1900-03-01. Zoned values are
 * already UTC; the serial carries no zone either way.
 */
export function dateSerial(s: string): number | null {
    const m = DATE_TIME.exec(s)
    if (!m) return null
    const [y, mo, d, h, mi, sec] = m.slice(1, 7).map((x) => Number(x ?? 0))
    const ms =
        Date.UTC(y, mo - 1, d, h, mi, sec) + Math.round(Number(m[7] ?? 0) * 1000)
    if (Number.isNaN(ms) || ms < FIRST_SAFE) return null
    return (ms - SERIAL_EPOCH) / DAY_MS
}

/** The text as a formula that evaluates to exactly that text. */
function literalText(s: string): string {
    return `="${s.replace(/"/g, '""')}"`
}

// What the cell input parser would turn into something other than text.
const NUMERIC = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?%?\s*$/
const BOOLEAN = /^\s*(true|false)\s*$/i

/** Significant digits a JS number cannot hold exactly beyond 15. */
function tooPreciseForNumber(s: string): boolean {
    const digits = s
        .replace(/^[-+]/, '')
        .replace('.', '')
        .replace(/^0+/, '')
        .replace(/0+$/, '')
    return digits.length > 15
}

/**
 * What to type into a cell for one value, or `null` to leave it EMPTY.
 *
 * The cell input parser reads `=…` as a formula, `00123` as 123 and `true` as
 * a boolean. Text that would be reinterpreted is written as a formula that
 * evaluates to the exact text, so a zip code keeps its zeros. An exact
 * decimal with more digits than a spreadsheet number holds is kept as text
 * for the same reason: the database said those digits, and a cell rounding
 * them away would be a silent change.
 */
export function cellInput(value: DataCellValue, type: DataColumnType): string | null {
    if (value === null) return null
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
    if (typeof value === 'number') return String(value)
    switch (type) {
        case 'number':
            return NUMERIC.test(value) && !tooPreciseForNumber(value)
                ? value
                : literalText(value)
        case 'date':
        case 'datetime': {
            // The input parser keeps `2026-03-09` as TEXT, so a date goes in
            // as its serial; the field's number format shows it as a date.
            const serial = dateSerial(value)
            return serial === null ? literalText(value) : String(serial)
        }
        default:
            return value.startsWith('=') ||
                NUMERIC.test(value) ||
                BOOLEAN.test(value)
                ? literalText(value)
                : value
    }
}

function renderId(refName: string, i: number): string {
    return `${refName}__f${i}`
}

export function refNameFor(sheetIdx: number, blockId: number): string {
    return `sql_${sheetIdx}_${blockId}`
}

export interface WriteOptions {
    target: BlockTarget
    result: DataQueryResult
    /** Shown on the block, for people and the AI. */
    description: string
    /**
     * The block the previous run wrote, removed in the same transaction.
     *
     * A refresh passes the target's own id here: the block is recreated
     * under the same id and ref name, so formulas that name it keep working.
     * That needs an engine whose `removeBlock` frees the id's cells, schema
     * and ref name within the transaction (logisky/LogiSheets#528); an older
     * engine rejects the `bindFormSchema` as a duplicate ref name.
     */
    replaceBlockId?: number
}

/**
 * One transaction: (remove the old block,) create the block — a header line
 * plus one line per row — fill it, and bind a typed schema.
 */
export function writeResultPayloads(opts: WriteOptions): EditPayload[] {
    const {target, result} = opts
    const names = fieldNames(result.columns)
    // A block needs at least one column; a statement with no result set
    // (impossible on the read-only path, but cheap to guard) gets a stub.
    const cols = Math.max(1, names.length)
    const payloads: EditPayload[] = []
    if (opts.replaceBlockId !== undefined)
        payloads.push({
            type: 'removeBlock',
            value: {sheetIdx: target.sheetIdx, id: opts.replaceBlockId},
        })
    payloads.push({
        type: 'createBlock',
        value: {
            sheetIdx: target.sheetIdx,
            id: target.blockId,
            masterRow: target.masterRow,
            masterCol: target.masterCol,
            rowCnt: result.rows.length + 1,
            colCnt: cols,
            owner: OWNER,
            description: opts.description,
        },
    } as EditPayload)
    const put = (row: number, col: number, input: string): EditPayload => ({
        type: 'blockInput',
        value: {
            sheetIdx: target.sheetIdx,
            blockId: target.blockId,
            row,
            col,
            input,
        },
    })
    names.forEach((n, c) => payloads.push(put(0, c, n)))
    result.rows.forEach((row, r) => {
        row.forEach((v, c) => {
            const input = cellInput(v, result.columns[c].type)
            if (input !== null) payloads.push(put(r + 1, c, input))
        })
    })
    if (names.length > 0)
        payloads.push({
            type: 'bindFormSchema',
            value: {
                refName: target.refName,
                sheetIdx: target.sheetIdx,
                blockId: target.blockId,
                fieldFrom: 0,
                keyIdx: 0,
                row: true,
                headerIdx: 0,
                fields: result.columns.map((col, i) => ({
                    name: names[i],
                    renderId: renderId(target.refName, i),
                    fieldType: {kind: fieldKind(col.type)},
                    description: `${col.dbType} column from the query`,
                })),
            },
        } as EditPayload)
    // Render info per field, as the block composer writes it: booleans get
    // their widget, dates their format.
    result.columns.forEach((col, i) =>
        payloads.push({
            type: 'upsertFieldRenderInfo',
            value: {
                renderId: renderId(target.refName, i),
                diyRender: col.type === 'boolean',
                styleUpdate: {setNumFmt: numFmt(col.type)},
            },
        } as EditPayload)
    )
    return payloads
}

export function buildTransaction(payloads: readonly EditPayload[]): Transaction {
    return {payloads, undoable: true, temp: false}
}

/** The selection as the host hands it to a craft (`window.selection.data`). */
export interface SelectedData {
    data?:
        | {ty: 'cellRange'; d: {startRow: number; startCol: number}}
        | {ty: 'line'; d: {start: number; type: 'row' | 'col'}}
}

/**
 * Where a NEW result block goes: the top-left of what the user selected —
 * column A of a selected row, row 1 of a selected column — or undefined when
 * nothing is selected (the page then falls back to below the sheet's data).
 */
export function anchorOf(
    sel: SelectedData | undefined
): {row: number; col: number} | undefined {
    const d = sel?.data
    if (!d) return undefined
    if (d.ty === 'cellRange') return {row: d.d.startRow, col: d.d.startCol}
    return d.d.type === 'row' ? {row: d.d.start, col: 0} : {row: 0, col: d.d.start}
}

/** `B5` for row 4, column 1 (both 0-based). */
export function a1(row: number, col: number): string {
    let name = ''
    for (let c = col + 1; c > 0; c = Math.floor((c - 1) / 26))
        name = String.fromCharCode(65 + ((c - 1) % 26)) + name
    return `${name}${row + 1}`
}

/** A cell as `workbook.getCells` returns it — only what `isFree` reads. */
export interface CellProbe {
    value: unknown
    formula?: string
    blockId?: number
}

/**
 * Whether a result can be written over these cells without losing anything:
 * no value, no formula, and not part of a block. The craft refuses rather
 * than overwrite — the user picks another cell.
 */
export function isAreaFree(cells: readonly CellProbe[]): boolean {
    return cells.every(
        (c) => c.value === 'empty' && !c.formula && c.blockId === undefined
    )
}

/** The size of the block a result needs: a header line plus one per row. */
export function blockSize(result: DataQueryResult): {rows: number; cols: number} {
    return {rows: result.rows.length + 1, cols: Math.max(1, result.columns.length)}
}

export {createSqlEditor} from './editor'
export type {SqlEditor, SqlEditorOptions} from './editor'
