import {describe, expect, it} from 'vitest'
import {
    cellInput,
    fieldNames,
    parseState,
    writeResultPayloads,
    type DataQueryResult,
    a1,
    anchorOf,
    blockSize,
    isAreaFree,
} from './index'

describe('cellInput', () => {
    it('leaves NULL empty and keeps "" as text', () => {
        expect(cellInput(null, 'text')).toBeNull()
        expect(cellInput('', 'text')).toBe('')
    })

    it('keeps text the input parser would reinterpret', () => {
        expect(cellInput('=1+1', 'text')).toBe('="=1+1"')
        expect(cellInput('00123', 'text')).toBe('="00123"')
        expect(cellInput('true', 'text')).toBe('="true"')
        expect(cellInput('say "hi"', 'text')).toBe('say "hi"')
        expect(cellInput('=a"b', 'text')).toBe('="=a""b"')
    })

    it('writes numbers, and keeps over-precise decimals exact as text', () => {
        expect(cellInput(1.5, 'number')).toBe('1.5')
        expect(cellInput('12.50', 'number')).toBe('12.50')
        expect(cellInput('9007199254740993', 'number')).toBe(
            '="9007199254740993"'
        )
        expect(cellInput('12345678901234567890.0100', 'number')).toBe(
            '="12345678901234567890.0100"'
        )
    })

    it('writes booleans, and dates as serials', () => {
        expect(cellInput(true, 'boolean')).toBe('TRUE')
        expect(cellInput('2026-03-09', 'date')).toBe('46090')
        expect(cellInput('1900-03-01', 'date')).toBe('61')
        expect(cellInput('2026-03-09T18:00:00Z', 'datetime')).toBe('46090.75')
        expect(Number(cellInput('2026-03-09T18:00:00.500', 'datetime'))).toBeCloseTo(
            46090.75 + 0.5 / 86400,
            9
        )
        // Before the 1900 leap-year bug, or unparseable: kept as text.
        expect(cellInput('1900-01-05', 'date')).toBe('="1900-01-05"')
        expect(cellInput('infinity', 'datetime')).toBe('="infinity"')
    })
})

describe('fieldNames', () => {
    it('makes duplicate and blank column names usable', () => {
        const col = (name: string) => ({name, type: 'text' as const, dbType: 'TEXT'})
        expect(fieldNames([col('n'), col('N'), col(''), col('x')])).toEqual([
            'n',
            'N_2',
            'column_3',
            'x',
        ])
    })
})

describe('state', () => {
    it('round-trips and never carries more than it declares', () => {
        const s = parseState(
            JSON.stringify({connId: 'c', sql: 'select 1', maxRows: 5, password: 'x'})
        )
        expect(s).toEqual({connId: 'c', sql: 'select 1', maxRows: 5, target: undefined})
        expect(parseState('nonsense').sql).toBe('')
    })
})

describe('writeResultPayloads', () => {
    const result: DataQueryResult = {
        columns: [
            {name: 'id', type: 'number', dbType: 'INT4'},
            {name: 'note', type: 'text', dbType: 'TEXT'},
        ],
        rows: [
            [1, null],
            [2, 'hi'],
        ],
        truncated: false,
    }
    const target = {sheetIdx: 0, blockId: 7, masterRow: 3, masterCol: 1, refName: 'sql_0_7'}

    it('creates a header plus one line per row and skips NULL cells', () => {
        const p = writeResultPayloads({target, result, description: 'd'})
        expect(p[0].type).toBe('createBlock')
        expect((p[0].value as {rowCnt: number}).rowCnt).toBe(3)
        const inputs = p.filter((x) => x.type === 'blockInput')
        expect(inputs).toHaveLength(2 + 3)
        const schema = p.find((x) => x.type === 'bindFormSchema')!.value as {
            fields: readonly {fieldType: {kind: string}}[]
        }
        expect(schema.fields.map((f) => f.fieldType.kind)).toEqual(['number', 'string'])
        expect(p.filter((x) => x.type === 'upsertFieldRenderInfo')).toHaveLength(2)
    })

    it('replaces the old block in place, keeping its id', () => {
        const p = writeResultPayloads({target, result, description: 'd', replaceBlockId: 7})
        expect(p[0]).toEqual({type: 'removeBlock', value: {sheetIdx: 0, id: 7}})
        expect(p[1].type).toBe('createBlock')
        expect((p[1].value as {id: number}).id).toBe(7)
    })
})

describe('placement', () => {
    it('anchors at the top-left of the selected cells', () => {
        expect(
            anchorOf({data: {ty: 'cellRange', d: {startRow: 4, startCol: 1}}})
        ).toEqual({row: 4, col: 1})
    })

    it('anchors a selected row at column A and a column at row 1', () => {
        expect(anchorOf({data: {ty: 'line', d: {start: 7, type: 'row'}}})).toEqual(
            {row: 7, col: 0}
        )
        expect(anchorOf({data: {ty: 'line', d: {start: 3, type: 'col'}}})).toEqual(
            {row: 0, col: 3}
        )
    })

    it('has no anchor without a selection', () => {
        expect(anchorOf({})).toBeUndefined()
        expect(anchorOf(undefined)).toBeUndefined()
    })

    it('names cells A1-style', () => {
        expect(a1(0, 0)).toBe('A1')
        expect(a1(4, 1)).toBe('B5')
        expect(a1(0, 25)).toBe('Z1')
        expect(a1(0, 26)).toBe('AA1')
        expect(a1(9, 701)).toBe('ZZ10')
        expect(a1(0, 702)).toBe('AAA1')
    })

    it('treats only empty, formula-free, block-free cells as free', () => {
        expect(isAreaFree([{value: 'empty', formula: ''}])).toBe(true)
        expect(isAreaFree([{value: {type: 'number', value: 1}}])).toBe(false)
        expect(isAreaFree([{value: 'empty', formula: 'A1'}])).toBe(false)
        expect(isAreaFree([{value: 'empty', blockId: 3}])).toBe(false)
    })

    it('sizes a block as header plus rows', () => {
        expect(
            blockSize({
                columns: [
                    {name: 'a', type: 'number', dbType: 'int4'},
                    {name: 'b', type: 'text', dbType: 'text'},
                ],
                rows: [
                    [1, 'x'],
                    [2, 'y'],
                ],
                truncated: false,
            })
        ).toEqual({rows: 3, cols: 2})
    })
})
