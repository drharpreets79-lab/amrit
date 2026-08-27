import type React from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'

import { EmptyState, IconButton } from './ui'

export interface TableColumn<T> {
  key: string
  label: string
  render?: (row: T) => ReactNode
  sortValue?: (row: T) => string | number
  className?: string
}

export function DataTable<T>({ rows, columns, keyFor, emptyTitle, emptyMessage, sort, onSort, onRowClick, selectedKey, caption }: {
  rows: T[]
  columns: Array<TableColumn<T>>
  keyFor: (row: T, index: number) => string | number
  emptyTitle?: string
  emptyMessage?: string
  sort?: { key: string; direction: 'asc' | 'desc' }
  onSort?: (key: string) => void
  onRowClick?: (row: T) => void
  selectedKey?: string | number
  caption?: string
}): React.JSX.Element {
  const { t } = useTranslation('common')
  if (!rows.length) return <EmptyState title={emptyTitle ?? t('table.emptyTitle')} message={emptyMessage ?? t('table.emptyMessage')} />
  return (
    <div className="table-wrap">
      <table className="data-table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead><tr>{columns.map((column) => <th key={column.key} className={column.className}>{onSort && column.sortValue ? <button className="sort-button" onClick={() => onSort(column.key)}>{column.label}{sort?.key === column.key ? sort.direction === 'asc' ? <ChevronUp size={15} /> : <ChevronDown size={15} /> : null}</button> : column.label}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => {
          const key = keyFor(row, index)
          return <tr key={key} className={onRowClick ? 'data-table__clickable' : undefined} data-selected={selectedKey === key || undefined} onClick={() => onRowClick?.(row)}>{columns.map((column) => <td key={column.key} className={column.className}>{column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? '—')}</td>)}</tr>
        })}</tbody>
      </table>
    </div>
  )
}

export function Pager({ page, pageCount, onChange }: { page: number; pageCount: number; onChange: (page: number) => void }): React.JSX.Element {
  const { t } = useTranslation('common')
  return <nav className="pager" aria-label={t('table.pages')}><IconButton label={t('table.previousPage')} disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronUp className="rotate-left" size={18} /></IconButton><span><Trans i18nKey="common:table.pageOf" values={{ page, pageCount: Math.max(pageCount, 1) }} components={[<strong key="page" />]} /></span><IconButton label={t('table.nextPage')} disabled={page >= pageCount} onClick={() => onChange(page + 1)}><ChevronDown className="rotate-left" size={18} /></IconButton></nav>
}

