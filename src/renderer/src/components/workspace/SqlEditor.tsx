import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { sql, MySQL } from '@codemirror/lang-sql'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import './workspace.css'

/**
 * Public handle so the workspace can ask the editor for the current selection
 * (Ctrl+Enter / 执行按钮只执行选中文本) and insert generated SQL from the tree.
 * The editor stays fully controlled by the parent: every doc change is bubbled
 * through `onChange`, no SQL text is kept locally.
 */
export interface SqlEditorHandle {
  /** Returns the selected text, or '' when the selection is empty. */
  getSelection: () => string
  /** Replaces the current selection (or inserts at the cursor) with `text`. */
  insertSql: (text: string) => void
  focus: () => void
}

export interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  /** Ctrl/Cmd+Enter. The parent performs the plan -> approval -> execute flow. */
  onExecute: () => void
}

/** Dark syntax colors (the default highlight style is tuned for light themes). */
const sqlHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#7aa2f7' },
  { tag: tags.operator, color: '#89ddff' },
  { tag: [tags.string, tags.special(tags.string)], color: '#9ece6a' },
  { tag: [tags.number, tags.bool, tags.null], color: '#ff9e64' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#60728a', fontStyle: 'italic' },
  { tag: tags.variableName, color: '#e6edf3' },
  { tag: tags.propertyName, color: '#c0caf5' },
  { tag: tags.typeName, color: '#2dd4bf' },
  { tag: tags.function(tags.variableName), color: '#7dcfff' },
  { tag: tags.punctuation, color: '#a6b2c1' },
  { tag: tags.brace, color: '#a6b2c1' },
  { tag: tags.invalid, color: '#ff5d5d' }
])

const sqlTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--bg)', color: 'var(--text)', height: '100%' },
    '.cm-content': { caretColor: 'var(--accent)', fontFamily: 'var(--mono)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '.cm-gutters': {
      backgroundColor: 'var(--bg-elevated)',
      color: 'var(--text-muted)',
      border: 'none'
    },
    '.cm-activeLine': { backgroundColor: 'rgba(76, 141, 255, 0.06)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--panel-2)', color: 'var(--text-dim)' },
    '.cm-panels': { backgroundColor: 'var(--panel-2)', color: 'var(--text)' },
    '.cm-tooltip': { backgroundColor: 'var(--panel-2)', border: '1px solid var(--border-strong)' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--accent-soft)',
      color: 'var(--text)'
    }
  },
  { dark: true }
)

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const fallbackRef = useRef<HTMLTextAreaElement | null>(null)
  const [initError, setInitError] = useState<string | null>(null)
  const onChangeRef = useRef(props.onChange)
  const onExecuteRef = useRef(props.onExecute)
  onChangeRef.current = props.onChange
  onExecuteRef.current = props.onExecute

  // Editor is created once. Later `value` changes are applied as a diff-free
  // full replacement only when the parent really changed the document (e.g.
  // clearing after execution or inserting from the object tree).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let view: EditorView
    try {
      view = new EditorView({
        parent: host,
        doc: props.value,
        extensions: [
          basicSetup,
          sql({ dialect: MySQL }),
          sqlTheme,
          syntaxHighlighting(sqlHighlight),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          }),
          EditorView.domEventHandlers({
            keydown: (event) => {
              // Ctrl/Cmd+Enter is the only execute shortcut; it never executes
              // by itself — the parent must still show the plan preview.
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                onExecuteRef.current()
                return true
              }
              return false
            }
          })
        ]
      })
    } catch (e) {
      // Defensive only: @codemirror/state is deduped to a single version in
      // package.json, so the normal path must always be full CodeMirror.
      // If the environment is still broken, never leave the workspace blank:
      // fall back to a plain SQL textarea and keep the error visible.
      const message = e instanceof Error ? e.message : String(e)
      setInitError(message)
      return
    }
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === props.value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: props.value } })
  }, [props.value])

  useImperativeHandle(
    ref,
    () => ({
      getSelection: () => {
        const view = viewRef.current
        if (view) {
          const { from, to } = view.state.selection.main
          return from === to ? '' : view.state.sliceDoc(from, to)
        }
        const textarea = fallbackRef.current
        if (!textarea) return ''
        const { selectionStart, selectionEnd } = textarea
        return selectionStart === selectionEnd ? '' : textarea.value.slice(selectionStart, selectionEnd)
      },
      insertSql: (text) => {
        const view = viewRef.current
        if (view) {
          const { from, to } = view.state.selection.main
          const before = view.state.sliceDoc(0, from)
          const prefix = before.length > 0 && !before.endsWith('\n') ? '\n' : ''
          const suffix = text.endsWith('\n') ? '' : '\n'
          const insert = `${prefix}${text}${suffix}`
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + insert.length }
          })
          view.focus()
          return
        }
        const textarea = fallbackRef.current
        if (!textarea) return
        const from = textarea.selectionStart
        const to = textarea.selectionEnd
        const before = textarea.value.slice(0, from)
        const prefix = before.length > 0 && !before.endsWith('\n') ? '\n' : ''
        const suffix = text.endsWith('\n') ? '' : '\n'
        const insert = `${prefix}${text}${suffix}`
        onChangeRef.current(`${before}${insert}${textarea.value.slice(to)}`)
        textarea.focus()
        window.setTimeout(() => {
          if (!fallbackRef.current) return
          const position = from + insert.length
          fallbackRef.current.selectionStart = position
          fallbackRef.current.selectionEnd = position
        }, 0)
      },
      focus: () => {
        if (viewRef.current) viewRef.current.focus()
        else fallbackRef.current?.focus()
      }
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  if (initError !== null) {
    return (
      <div className="sql-fallback">
        <div className="sql-fallback-warning">
          CodeMirror 编辑器初始化失败，已降级为纯文本 SQL 编辑模式（执行流程与安全校验不受影响）。
          <span className="mono"> {initError}</span>
        </div>
        <textarea
          ref={fallbackRef}
          className="sql-fallback-input"
          value={props.value}
          spellCheck={false}
          placeholder="在此输入 SQL；Ctrl/Cmd + Enter 预览执行计划"
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault()
              props.onExecute()
            }
          }}
        />
      </div>
    )
  }

  return <div className="sql-editor-host" ref={hostRef} />
})
