import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import type { MasterObjectField } from '../../shared/types'
import { Button, Input, Select, Textarea } from './ui'

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const parsed = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  if (!value.trim()) return undefined
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

const scalarText = (value: unknown): string => value == null ? '' : typeof value === 'object' ? '' : String(value)

/**
 * Repeatable rows of a declared shape — guidance notes, response codes and the like — so a
 * stored array is edited as labelled fields instead of hand-written JSON. Keys outside the
 * declared fields (source provenance, identifiers) ride along untouched.
 */
export function ObjectListEditor({ label, hint, name, fields, itemLabel = 'entry', rows, onChange }: {
  label: string
  hint?: string
  name: string
  fields: MasterObjectField[]
  itemLabel?: string
  rows: Array<Record<string, unknown>>
  onChange: (rows: Array<Record<string, unknown>>) => void
}): React.JSX.Element {
  const { t } = useTranslation('common')
  const patch = (index: number, key: string, value: unknown): void =>
    onChange(rows.map((row, position) => position === index ? { ...row, [key]: value } : row))
  const add = (): void => onChange([...rows, Object.fromEntries(fields.map((field) => [field.key, field.type === 'number' ? 0 : '']))])
  return (
    <div className="object-list">
      <div className="object-list__head">
        <div><span className="field__label">{label}</span>{hint && <span className="field__hint">{hint}</span>}</div>
        <Button variant="secondary" onClick={add}><Plus size={15} /> {t('editor.add', { item: itemLabel })}</Button>
      </div>
      {rows.length === 0
        ? <p className="object-list__empty">{t('editor.noneRecorded', { item: itemLabel })}</p>
        : rows.map((row, index) => (
          <div className="object-list__row" key={index}>
            <div className="object-list__fields">
              {fields.map((field) => {
                const value = row[field.key]
                const common = { label: field.label, name: `${name}-${index}-${field.key}`, disabled: field.readonly, placeholder: field.placeholder }
                if (field.type === 'textarea') return <Textarea key={field.key} {...common} rows={2} value={scalarText(value)} onChange={(event) => patch(index, field.key, event.target.value)} />
                if (field.type === 'select') return <Select key={field.key} {...common} value={scalarText(value)} onChange={(event) => patch(index, field.key, event.target.value)}>
                  <option value="">{t('editor.notSet')}</option>
                  {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  {scalarText(value) && !(field.options ?? []).some((option) => option.value === scalarText(value)) && <option value={scalarText(value)}>{t('editor.fromSource', { value: scalarText(value) })}</option>}
                </Select>
                return <Input key={field.key} {...common} type={field.type === 'number' ? 'number' : 'text'} value={scalarText(value)}
                  onChange={(event) => patch(index, field.key, field.type === 'number' ? (event.target.value === '' ? null : Number(event.target.value)) : event.target.value)} />
              })}
            </div>
            <Button variant="ghost" className="danger-text" aria-label={`Remove ${itemLabel} ${index + 1}`} onClick={() => onChange(rows.filter((_item, position) => position !== index))}><Trash2 size={15} /></Button>
          </div>
        ))}
    </div>
  )
}

/**
 * Free-form metadata as labelled key/value rows. A nested value has no flat representation, so
 * it keeps a JSON field of its own rather than being dropped or flattened lossily.
 */
export function KeyValueEditor({ label, hint, name, value, onChange }: {
  label: string
  hint?: string
  name: string
  value: unknown
  onChange: (value: Record<string, unknown>) => void
}): React.JSX.Element {
  const { t } = useTranslation('common')
  const source = isPlainObject(value) ? value : isPlainObject(parsed(value)) ? parsed(value) as Record<string, unknown> : {}
  const entries = Object.entries(source)
  const write = (next: Array<[string, unknown]>): void => onChange(Object.fromEntries(next.filter(([key]) => key.trim())))
  const rename = (index: number, key: string): void => write(entries.map((entry, position) => position === index ? [key, entry[1]] : entry))
  const set = (index: number, item: unknown): void => write(entries.map((entry, position) => position === index ? [entry[0], item] : entry))
  return (
    <div className="object-list">
      <div className="object-list__head">
        <div><span className="field__label">{label}</span>{hint && <span className="field__hint">{hint}</span>}</div>
        <Button variant="secondary" onClick={() => write([...entries, ['', '']])}><Plus size={15} /> {t('editor.addProperty')}</Button>
      </div>
      {entries.length === 0
        ? <p className="object-list__empty">{t('editor.noProperties')}</p>
        : entries.map(([key, item], index) => (
          <div className="object-list__row" key={`${key}-${index}`}>
            <div className="object-list__fields">
              <Input label="Property" name={`${name}-${index}-key`} value={key} onChange={(event) => rename(index, event.target.value)} />
              {typeof item === 'object' && item !== null
                ? <Textarea label="Structured value (JSON)" name={`${name}-${index}-json`} rows={2} value={JSON.stringify(item)} hint="Nested value; edited as JSON." onChange={(event) => { const next = parsed(event.target.value); if (next !== undefined) set(index, next) }} />
                : <Input label="Value" name={`${name}-${index}-value`} value={scalarText(item)} onChange={(event) => set(index, event.target.value)} />}
            </div>
            <Button variant="ghost" className="danger-text" aria-label={`Remove property ${key || index + 1}`} onClick={() => write(entries.filter((_entry, position) => position !== index))}><Trash2 size={15} /></Button>
          </div>
        ))}
    </div>
  )
}

/** Renders a stored payload as readable rows; falls back to the original text when it is not JSON. */
export function StructuredDetail({ text, emptyLabel = 'No additional details recorded.' }: { text?: string; emptyLabel?: string }): React.JSX.Element {
  if (!text?.trim()) return <p className="structured-detail__empty">{emptyLabel}</p>
  const value = parsed(text)
  if (value === undefined) return <p className="structured-detail__text">{text}</p>
  const rows: Array<[string, unknown]> = isPlainObject(value)
    ? Object.entries(value)
    : Array.isArray(value) ? value.map((item, index) => [`#${index + 1}`, item]) : [['Value', value]]
  if (!rows.length) return <p className="structured-detail__empty">{emptyLabel}</p>
  return <dl className="structured-detail">
    {rows.map(([key, item]) => <div key={key}>
      <dt>{key.replace(/[_-]+/g, ' ')}</dt>
      <dd>{item == null ? '—' : typeof item === 'object' ? <StructuredDetail text={JSON.stringify(item)} /> : String(item)}</dd>
    </div>)}
  </dl>
}
