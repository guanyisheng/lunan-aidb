import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ConnectionInput, ConnectionSummary, ConnectionTestResult, SslMode } from '@shared/types'
import { ApiError, call } from '../../lib/api'
import { errorMessage } from '../../lib/store'
import { Button, Callout, Checkbox, Field, Input, Modal, Select } from '../ui'
import './workspace.css'

export interface ConnectionDialogProps {
  open: boolean
  /** null => create a new connection. */
  editing: ConnectionSummary | null
  onClose: () => void
  onSaved: (connection: ConnectionSummary) => void
}

interface FormState {
  name: string
  host: string
  port: string
  user: string
  password: string
  database: string
  ssl: SslMode
  charset: string
  connectTimeoutMs: string
  clearPassword: boolean
}

const EMPTY_FORM: FormState = {
  name: '',
  host: '127.0.0.1',
  port: '3306',
  user: 'root',
  password: '',
  database: '',
  ssl: 'preferred',
  charset: 'utf8mb4',
  connectTimeoutMs: '10000',
  clearPassword: false
}

function formFromSummary(summary: ConnectionSummary): FormState {
  return {
    name: summary.name,
    host: summary.host,
    port: String(summary.port),
    user: summary.user,
    password: '',
    database: summary.database,
    ssl: summary.ssl,
    charset: summary.charset,
    // The summary intentionally does not expose the stored timeout; leaving
    // this empty keeps the existing value on save.
    connectTimeoutMs: '',
    clearPassword: false
  }
}

/**
 * Create/edit dialog for a saved database connection.
 *
 * The password is write-only: the renderer only ever knows
 * `hasStoredPassword`, never the plaintext. Submitting with an empty password
 * while editing omits the field so the stored secret is kept unchanged.
 */
export function ConnectionDialog(props: ConnectionDialogProps): ReactNode {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saveError, setSaveError] = useState<unknown>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  useEffect(() => {
    if (!props.open) return
    setForm(props.editing ? formFromSummary(props.editing) : EMPTY_FORM)
    setSaving(false)
    setTesting(false)
    setSaveError(null)
    setFieldErrors({})
    setTestResult(null)
    setTestError(null)
  }, [props.open, props.editing])

  const patch = (key: keyof FormState, value: string | boolean): void =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const validate = (): Record<string, string> => {
    const errors: Record<string, string> = {}
    if (!form.name.trim()) errors.name = '请输入连接名称'
    if (!form.host.trim()) errors.host = '请输入主机地址'
    if (!/^[A-Za-z0-9._:\-[\]]+$/.test(form.host.trim())) errors.host = '主机名包含非法字符'
    const port = Number(form.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = '端口必须为 1-65535 的整数'
    if (!form.user.trim()) errors.user = '请输入用户名'
    const timeoutText = form.connectTimeoutMs.trim()
    if (timeoutText) {
      const timeout = Number(timeoutText)
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120_000) {
        errors.connectTimeoutMs = '连接超时需为 1000-120000 毫秒'
      }
    }
    return errors
  }

  const buildInput = (): ConnectionInput => {
    const input: ConnectionInput = {
      name: form.name.trim(),
      host: form.host.trim(),
      port: Number(form.port),
      user: form.user.trim(),
      database: form.database.trim() || undefined,
      ssl: form.ssl,
      charset: form.charset.trim() || undefined,
      connectTimeoutMs: form.connectTimeoutMs.trim() ? Number(form.connectTimeoutMs) : undefined
    }
    if (form.password) {
      input.password = form.password
    } else if (props.editing && form.clearPassword) {
      // Explicit empty string clears the stored secret; undefined would keep it.
      input.password = ''
    }
    return input
  }

  const handleTest = async (): Promise<void> => {
    const errors = validate()
    setFieldErrors(errors)
    setTestResult(null)
    setTestError(null)
    if (Object.keys(errors).length > 0) return
    setTesting(true)
    try {
      const result = await call('conn.test', { id: props.editing?.id, input: buildInput() })
      setTestResult(result)
    } catch (e) {
      setTestError(errorMessage(e))
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    const errors = validate()
    setFieldErrors(errors)
    setSaveError(null)
    if (Object.keys(errors).length > 0) return
    setSaving(true)
    try {
      const saved = await call('conn.save', { id: props.editing?.id, input: buildInput() })
      props.onSaved(saved)
    } catch (e) {
      setSaveError(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={props.open}
      title={props.editing ? `编辑连接：${props.editing.name}` : '新建数据库连接'}
      closeOnEscape={false}
      onClose={() => {
        if (!saving && !testing) props.onClose()
      }}
      footer={
        <>
          <Button variant="ghost" onClick={() => void handleTest()} loading={testing}>
            测试连接
          </Button>
          <span className="spacer" />
          <Button variant="ghost" onClick={props.onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} loading={saving}>
            {props.editing ? '保存修改' : '创建连接'}
          </Button>
        </>
      }
    >
      {saveError instanceof ApiError && (
        <div className="mb-2">
          <Callout kind="danger" title={`保存失败（${saveError.code}）`}>
            <div className="pre-wrap">{saveError.message}</div>
            {saveError.hint && <div className="small mt-1">建议：{saveError.hint}</div>}
          </Callout>
        </div>
      )}
      {saveError !== null && !(saveError instanceof ApiError) && (
        <div className="mb-2">
          <Callout kind="danger" title="保存失败">
            <div className="pre-wrap">{errorMessage(saveError)}</div>
          </Callout>
        </div>
      )}

      <Field label="连接名称" error={fieldErrors.name}>
        <Input value={form.name} onChange={(v) => patch('name', v)} placeholder="例如：本地开发库" autoFocus />
      </Field>

      <div className="grid-2">
        <Field label="主机" error={fieldErrors.host}>
          <Input value={form.host} onChange={(v) => patch('host', v)} placeholder="127.0.0.1" />
        </Field>
        <Field label="端口" error={fieldErrors.port}>
          <Input value={form.port} onChange={(v) => patch('port', v)} type="number" placeholder="3306" />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="用户名" error={fieldErrors.user}>
          <Input value={form.user} onChange={(v) => patch('user', v)} placeholder="root" />
        </Field>
        <Field
          label="密码"
          hint={
            props.editing
              ? '只写，不会回显；留空表示不修改已保存的密码'
              : '只写，保存后不会回显；可留空'
          }
        >
          <Input
            value={form.password}
            onChange={(v) => patch('password', v)}
            type="password"
            placeholder={props.editing?.hasStoredPassword ? '已保存密码（留空不修改）' : '数据库密码'}
          />
        </Field>
      </div>

      {props.editing && props.editing.hasStoredPassword && (
        <div className="mb-2">
          <Checkbox
            checked={form.clearPassword}
            onChange={(checked) => patch('clearPassword', checked)}
            label="清除已保存的密码（下次连接需要重新输入）"
          />
        </div>
      )}

      <div className="grid-2">
        <Field label="默认数据库" hint="可选，连接后仍可在工作区切换">
          <Input value={form.database} onChange={(v) => patch('database', v)} placeholder="可选" />
        </Field>
        <Field label="SSL 模式">
          <Select<SslMode>
            value={form.ssl}
            onChange={(v) => patch('ssl', v)}
            options={[
              { value: 'disabled', label: 'disabled（不加密）' },
              { value: 'preferred', label: 'preferred（优先加密）' },
              { value: 'required', label: 'required（强制加密）' }
            ]}
          />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="字符集">
          <Input value={form.charset} onChange={(v) => patch('charset', v)} placeholder="utf8mb4" />
        </Field>
        <Field
          label="连接超时（毫秒）"
          error={fieldErrors.connectTimeoutMs}
          hint={props.editing ? '留空保持原值（默认 10000）' : '默认 10000'}
        >
          <Input
            value={form.connectTimeoutMs}
            onChange={(v) => patch('connectTimeoutMs', v)}
            type="number"
            placeholder={props.editing ? '留空保持原值' : '10000'}
          />
        </Field>
      </div>

      {testError && (
        <Callout kind="danger" title="测试连接失败">
          <div className="pre-wrap">{testError}</div>
        </Callout>
      )}

      {testResult && (
        <Callout
          kind={testResult.ok ? 'ok' : 'danger'}
          title={testResult.ok ? '测试连接成功' : '测试连接失败'}
        >
          <div className="small">
            目标 <span className="mono">{testResult.host}</span> · 延迟 {testResult.latencyMs} ms
            {testResult.serverVersion ? ` · 服务端 ${testResult.serverVersion}` : ''}
            {testResult.serverFlavor ? ` · ${testResult.serverFlavor}` : ''}
            {testResult.sslActive !== undefined ? ` · SSL ${testResult.sslActive ? '已启用' : '未启用'}` : ''}
          </div>
          {testResult.error && <div className="pre-wrap mt-1">{testResult.error}</div>}
          {testResult.hint && <div className="small mt-1">建议：{testResult.hint}</div>}
        </Callout>
      )}
    </Modal>
  )
}
