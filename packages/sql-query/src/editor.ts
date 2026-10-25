// The SQL editor: CodeMirror 6 with the SQL language, keyword highlighting in
// the connection's dialect, undo history and Mod-Enter to run.
//
// The page calls `createSqlEditor` once; everything else is the returned
// handle. Kept apart from the pure helpers in index.ts so they stay testable
// without a DOM.

import {Compartment, EditorState} from '@codemirror/state'
import {
    EditorView,
    keymap,
    placeholder as placeholderExt,
} from '@codemirror/view'
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands'
import {
    HighlightStyle,
    bracketMatching,
    syntaxHighlighting,
} from '@codemirror/language'
import {MySQL, PostgreSQL, SQLite, StandardSQL, sql} from '@codemirror/lang-sql'
import {tags as t} from '@lezer/highlight'

/** The connection kinds the host offers (`dataConnections.list()[i].kind`). */
export type SqlDialectName = 'postgres' | 'mysql' | 'sqlite' | string

function dialectFor(kind: SqlDialectName | undefined) {
    switch (kind) {
        case 'postgres':
            return PostgreSQL
        case 'mysql':
            return MySQL
        case 'sqlite':
            return SQLite
        default:
            return StandardSQL
    }
}

// Quiet colours that read well on the craft panel's white card.
const highlight = HighlightStyle.define([
    {tag: t.keyword, color: '#1d4ed8', fontWeight: '600'},
    {tag: [t.typeName, t.standard(t.name)], color: '#7c3aed'},
    {tag: [t.string, t.special(t.string)], color: '#047857'},
    {tag: [t.number, t.bool, t.null], color: '#b45309'},
    {tag: t.comment, color: '#9ca3af', fontStyle: 'italic'},
    {tag: [t.operator, t.punctuation], color: '#4b5563'},
    {tag: t.special(t.name), color: '#be185d'},
])

const theme = EditorView.theme({
    '&': {
        fontSize: '12px',
        border: '1px solid #d1d5db',
        borderRadius: '6px',
        background: '#fff',
    },
    '&.cm-focused': {outline: '2px solid #bfdbfe', outlineOffset: '-1px'},
    '.cm-scroller': {
        fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        minHeight: '140px',
        maxHeight: '320px',
        overflow: 'auto',
    },
    '.cm-content': {padding: '6px 0'},
    '.cm-line': {padding: '0 8px'},
    '.cm-placeholder': {color: '#9ca3af'},
})

export interface SqlEditorOptions {
    doc: string
    placeholder?: string
    dialect?: SqlDialectName
    /** Every edit, with the whole text. */
    onChange?: (text: string) => void
    /** Mod-Enter (Cmd on macOS, Ctrl elsewhere). */
    onRun?: () => void
}

export interface SqlEditor {
    getValue(): string
    setValue(text: string): void
    setDialect(kind: SqlDialectName | undefined): void
    focus(): void
}

export function createSqlEditor(
    parent: HTMLElement,
    opts: SqlEditorOptions
): SqlEditor {
    const language = new Compartment()
    const view = new EditorView({
        parent,
        state: EditorState.create({
            doc: opts.doc,
            extensions: [
                history(),
                bracketMatching(),
                language.of(sql({dialect: dialectFor(opts.dialect)})),
                syntaxHighlighting(highlight),
                EditorView.lineWrapping,
                theme,
                placeholderExt(opts.placeholder ?? ''),
                keymap.of([
                    {
                        key: 'Mod-Enter',
                        preventDefault: true,
                        run: () => {
                            opts.onRun?.()
                            return true
                        },
                    },
                    ...defaultKeymap,
                    ...historyKeymap,
                ]),
                EditorView.updateListener.of((u) => {
                    if (u.docChanged) opts.onChange?.(u.state.doc.toString())
                }),
            ],
        }),
    })
    return {
        getValue: () => view.state.doc.toString(),
        setValue: (text) =>
            view.dispatch({
                changes: {from: 0, to: view.state.doc.length, insert: text},
            }),
        setDialect: (kind) =>
            view.dispatch({
                effects: language.reconfigure(
                    sql({dialect: dialectFor(kind)})
                ),
            }),
        focus: () => view.focus(),
    }
}
