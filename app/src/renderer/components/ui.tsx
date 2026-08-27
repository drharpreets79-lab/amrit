/* Shared UI primitives and formatting helpers intentionally live together. */
/* eslint-disable react-refresh/only-export-components */
import type React from 'react'
import { useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { AlertCircle, CalendarDays, CheckCircle2, ChevronDown, HelpCircle, Info, LoaderCircle, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { i18n } from '../i18n'

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

export function Button({ className, children, variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }): React.JSX.Element {
  return <button className={cx('button', `button--${variant}`, className)} {...props}>{children}</button>
}

export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }): React.JSX.Element {
  return <button className="icon-button" aria-label={label} title={label} {...props}>{children}</button>
}

export function Input({ label, hint, error, id, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string }): React.JSX.Element {
  const inputId = id ?? props.name
  return (
    <label className={cx('field', className)} htmlFor={inputId}>
      {label && <span className="field__label">{label}{props.required && <span aria-hidden="true"> *</span>}</span>}
      <input id={inputId} className={cx('input', error && 'input--error')} aria-invalid={Boolean(error)} aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined} {...props} />
      {error ? <span id={`${inputId}-error`} className="field__error">{error}</span> : hint ? <span id={`${inputId}-hint`} className="field__hint">{hint}</span> : null}
    </label>
  )
}

export function Select({ label, hint, error, id, className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label?: string; hint?: string; error?: string }): React.JSX.Element {
  const selectId = id ?? props.name
  return (
    <label className={cx('field', className)} htmlFor={selectId}>
      {label && <span className="field__label">{label}{props.required && <span aria-hidden="true"> *</span>}</span>}
      <select id={selectId} className={cx('select', error && 'input--error')} aria-invalid={Boolean(error)} aria-describedby={error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined} {...props}>{children}</select>
      {error ? <span id={`${selectId}-error`} className="field__error">{error}</span> : hint ? <span id={`${selectId}-hint`} className="field__hint">{hint}</span> : null}
    </label>
  )
}

export interface MultiOption { value: string; label: string; hint?: string }

/** Options a combobox filters on: the code, the label and whatever secondary text it carries. */
const optionHaystack = (option: MultiOption): string =>
  `${option.value} ${option.label} ${option.hint ?? ''}`.toLowerCase()

/**
 * One dropdown for the whole application: type to filter, arrow keys to move, Enter to take.
 *
 * Every coded field in this software draws on a catalogue that can run to thousands of
 * entries — 2,380 organisms, 399 antimicrobials, 252 countries — and a native `<select>`
 * offers no way through one but scrolling. So the control is a listbox the operator narrows
 * by typing, and the match runs over the code as well as the label, because a laboratory
 * that knows an isolate is `ECO` should not have to remember how the catalogue spells
 * *Escherichia coli*.
 *
 * What is stored is always `option.value` — the standard code — never the display text. The
 * label is what a person reads; the code is what leaves the building in an export.
 *
 * A value that is not in `options` is still shown rather than blanked: catalogues are
 * versioned and deactivated entries outlive the records that reference them.
 */
export function Combobox({
  label, value, onChange, options, name, id, required, hint, error, placeholder, disabled,
  allowCustom = false, maxVisible = 60
}: {
  label?: string
  value: string
  onChange: (value: string) => void
  options: MultiOption[]
  name: string
  id?: string
  required?: boolean
  hint?: string
  error?: string
  placeholder?: string
  disabled?: boolean
  /** Lets the operator commit text that is not in the catalogue, kept verbatim. */
  allowCustom?: boolean
  maxVisible?: number
}): React.JSX.Element {
  const { t } = useTranslation('common')
  const inputId = id ?? name
  const listId = `${inputId}-listbox`
  const [open, setOpen] = useState(false)
  /** `null` means "not being edited": the box shows the selection rather than a search term. */
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  const selected = options.find((option) => option.value === value)
  // A value the catalogue no longer lists still has to be readable, so it falls through as
  // its own text instead of leaving an empty box that hides what the record holds.
  const selectionText = selected?.label ?? value
  const text = query ?? selectionText
  const needle = (query ?? '').trim().toLowerCase()
  const matches = useMemo(
    () => (needle ? options.filter((option) => optionHaystack(option).includes(needle)) : options),
    [needle, options]
  )
  const visible = matches.slice(0, maxVisible)

  useEffect(() => { if (active >= visible.length) setActive(0) }, [visible.length, active])

  /** Closing on an outside click rather than on blur, so clicking an option is not a blur. */
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) { setOpen(false); setQuery(null) }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const commit = (next: string): void => { onChange(next); setQuery(null); setOpen(false) }
  const exactMatch = (candidate: string): MultiOption | undefined => {
    const wanted = candidate.trim().toLowerCase()
    if (!wanted) return undefined
    return options.find((option) => option.value.toLowerCase() === wanted)
      ?? options.find((option) => option.label.toLowerCase() === wanted)
  }
  /**
   * Typing is a search, with one exception: text that *is* a catalogue code is taken as the
   * selection straight away. That is how a code pasted from a worksheet — or typed by
   * someone who works in codes all day — lands without a second gesture.
   */
  const type = (next: string): void => {
    setQuery(next)
    setOpen(true)
    setActive(0)
    const exact = exactMatch(next)
    if (exact && exact.value.toLowerCase() === next.trim().toLowerCase()) commit(exact.value)
  }
  const keyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { setOpen(true); return }
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) => (current + step + visible.length) % Math.max(visible.length, 1))
      return
    }
    if (event.key === 'Enter') {
      if (!open && !query) return
      event.preventDefault()
      const chosen = visible[active] ?? exactMatch(text)
      if (chosen) commit(chosen.value)
      else if (allowCustom && text.trim()) commit(text.trim())
      return
    }
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); setQuery(null) }
  }
  /**
   * Leaving the field must not quietly change what it holds. A half-typed search reverts;
   * only a catalogue match, or free text where the field allows it, is kept.
   */
  const blur = (): void => {
    if (query === null) return
    const exact = exactMatch(query)
    if (exact) commit(exact.value)
    else if (allowCustom && query.trim()) commit(query.trim())
    else { setQuery(null); setOpen(false) }
  }

  const described = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined
  // A grid row hides its labels — the column heading is the label there — but the control
  // still has to have a name, so the field's own key becomes one when nothing is visible.
  const fallbackName = label ? undefined : name.replace(/[-_]+/g, ' ').trim()
  return (
    <div className={cx('field', 'combobox-field')}>
      {label && <label className="field__label" htmlFor={inputId}>{label}{required && <span aria-hidden="true"> *</span>}</label>}
      <div className={cx('combobox', open && 'combobox--open')} ref={containerRef}>
        <input
          id={inputId}
          name={name}
          className={cx('input', 'combobox__input', error && 'input--error')}
          role="combobox"
          type="text"
          autoComplete="off"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && visible[active] ? `${listId}-${active}` : undefined}
          aria-invalid={Boolean(error)}
          aria-describedby={described}
          aria-label={fallbackName}
          required={required}
          disabled={disabled}
          placeholder={placeholder ?? t('selectPlaceholder')}
          value={text}
          onChange={(event) => type(event.target.value)}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={blur}
          onKeyDown={keyDown}
        />
        {value && !disabled && <button type="button" className="combobox__clear" aria-label={t('combobox.clear', { label: label ?? fallbackName ?? name })} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(''); setQuery(null) }}><X size={14} /></button>}
        <ChevronDown className="combobox__chevron" size={16} aria-hidden="true" />
        {open && <ul className="combobox__options" id={listId} role="listbox" aria-label={label ?? fallbackName ?? name}>
          {visible.length === 0 && <li className="combobox__none" role="presentation">{allowCustom && text.trim() ? t('combobox.useTyped', { value: text.trim() }) : t('combobox.noMatch', { query: text })}</li>}
          {visible.map((option, index) => (
            <li
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              className={cx('combobox__option', index === active && 'combobox__option--active', option.value === value && 'combobox__option--on')}
              onMouseEnter={() => setActive(index)}
              // Mouse-down rather than click, so choosing an option is not first a blur that
              // reverts the search term. Click is kept as well: an activation that arrives
              // without a preceding mouse-down — assistive technology, synthetic events —
              // must still select, and by then this element has already unmounted if the
              // mouse-down handler ran, so it cannot fire twice.
              onMouseDown={(event) => { event.preventDefault(); commit(option.value) }}
              onClick={() => commit(option.value)}
            >
              <span>{option.label}</span>
              {(option.value !== option.label || option.hint) && <small>{option.value}{option.hint ? ` · ${option.hint}` : ''}</small>}
            </li>
          ))}
          {matches.length > visible.length && <li className="combobox__none" role="presentation">{t('combobox.more', { count: matches.length - visible.length })}</li>}
        </ul>}
      </div>
      {error ? <span id={`${inputId}-error`} className="field__error">{error}</span> : hint ? <span id={`${inputId}-hint`} className="field__hint">{hint}</span> : null}
    </div>
  )
}

/**
 * A catalogue choice that also accepts a value the catalogue does not hold.
 *
 * Kept as its own name because that permission is a decision about the data, not about the
 * widget: a laboratory must be able to record a method its coded list has not caught up
 * with, and every such value is stored verbatim so it is visible as an outlier later.
 */
export function CustomSelect({ label, value, onChange, options, required, hint, name, placeholder, disabled }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string; hint?: string }>; required?: boolean; hint?: string; name: string; placeholder?: string; disabled?: boolean }): React.JSX.Element {
  return <Combobox label={label} name={name} value={value} options={options} required={required} hint={hint} placeholder={placeholder} disabled={disabled} allowCustom onChange={onChange} />
}

/**
 * A date, entered with the platform's calendar rather than typed.
 *
 * Stored and emitted as ISO `YYYY-MM-DD`, which is what every consumer downstream — the
 * SQLite columns, the FHIR and WHONET exports, the epidemiological week calculation —
 * already expects. What the operator sees is their locale's order, because the browser
 * renders a `date` input in the locale, so an Indian clerk reads DD/MM/YYYY without the
 * stored value ever being ambiguous.
 */
export function DateInput({ label, value, onChange, name, id, required, hint, error, min, max, disabled }: {
  label?: string
  value: string
  onChange: (value: string) => void
  name: string
  id?: string
  required?: boolean
  hint?: string
  error?: string
  min?: string
  max?: string
  disabled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('common')
  const inputId = id ?? name
  const inputRef = useRef<HTMLInputElement>(null)
  // Chromium only shows the calendar on the small indicator glyph. The button gives the
  // whole control an obvious way in, which is the difference between a date field people
  // use and one they type around.
  const openPicker = (): void => {
    const element = inputRef.current as (HTMLInputElement & { showPicker?: () => void }) | null
    element?.focus()
    try { element?.showPicker?.() } catch { /* unsupported or not user-activated; typing still works */ }
  }
  return (
    <div className="field date-field">
      {label && <label className="field__label" htmlFor={inputId}>{label}{required && <span aria-hidden="true"> *</span>}</label>}
      <div className="date-field__control">
        <input
          ref={inputRef}
          id={inputId}
          name={name}
          type="date"
          className={cx('input', error && 'input--error')}
          value={value}
          min={min}
          max={max}
          required={required}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        <IconButton label={t('dateField.open', { label: label ?? name })} disabled={disabled} onClick={openPicker}><CalendarDays size={16} /></IconButton>
      </div>
      {error ? <span id={`${inputId}-error`} className="field__error">{error}</span> : hint ? <span id={`${inputId}-hint`} className="field__hint">{hint}</span> : null}
    </div>
  )
}

/** Catalogue-backed multiple selection. Values absent from `options` are kept and shown as
 * retained entries so an inherited or deactivated code is never silently dropped on save.
 *
 * The search box doubles as a fast entry path: Enter adds the top match, and a
 * comma/newline separated list of codes is resolved in one go. Catalogues larger than
 * `browseLimit` stay collapsed until something is typed, so a 2,000-entry organism master
 * does not bury the rest of the form. */
export function MultiSelect({ label, hint, name, values, options, onChange, placeholder, emptyLabel, maxVisible = 80, browseLimit = 40, onQueryChange }: { label: string; hint?: string; name: string; values: string[]; options: MultiOption[]; onChange: (values: string[]) => void; placeholder?: string; emptyLabel?: string; maxVisible?: number; browseLimit?: number
  /**
   * What the operator has typed, for a field whose catalogue is too large to hold in the page.
   *
   * Phase 24. Every other use of this control filters a list the renderer already has. The
   * diagnosis picker cannot: the bundled classification is thousands of codes, and shipping
   * all of them into the renderer to filter them there would move the work to the process
   * with less memory. The caller uses this to search in the main process and widen `options`.
   */
  onQueryChange?: (query: string) => void }): React.JSX.Element {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const [unmatched, setUnmatched] = useState<string[]>([])
  const labels = new Map(options.map((option) => [option.value, option.label]))
  const needle = query.trim().toLowerCase()
  const matches = options.filter((option) => !needle || `${option.value} ${option.label} ${option.hint ?? ''}`.toLowerCase().includes(needle))
  const search = (next: string): void => { setQuery(next); onQueryChange?.(next) }
  const browsable = needle.length > 0 || options.length <= browseLimit
  const visible = browsable ? matches.slice(0, maxVisible) : []
  const toggle = (value: string): void => onChange(values.includes(value) ? values.filter((item) => item !== value) : [...values, value])
  const resolve = (token: string): string | undefined => {
    const wanted = token.trim().toLowerCase()
    if (!wanted) return undefined
    return options.find((option) => option.value.toLowerCase() === wanted)?.value
      ?? options.find((option) => option.label.toLowerCase() === wanted)?.value
  }
  /** Enter commits: a list of codes resolves each token, a single term takes the top match. */
  const commit = (): void => {
    const tokens = query.split(/[,;\n\t]+/).map((token) => token.trim()).filter(Boolean)
    if (!tokens.length) return
    const added: string[] = []
    const missing: string[] = []
    for (const token of tokens) {
      const resolved = resolve(token) ?? (tokens.length === 1 ? matches[0]?.value : undefined)
      if (resolved) { if (!values.includes(resolved) && !added.includes(resolved)) added.push(resolved) } else missing.push(token)
    }
    setUnmatched(missing)
    if (added.length) { onChange([...values, ...added]); setQuery('') }
  }
  return (
    <div className="multi-select">
      <span className="field__label">{label}</span>
      {hint && <span className="field__hint">{hint}</span>}
      <div className="multi-select__chips">
        {values.length === 0 ? <span className="multi-select__empty">{emptyLabel ?? t('multiSelect.empty')}</span> : values.map((value) => (
          <span className="chip" key={value}>
            <span>{labels.get(value) ?? value}</span>
            <small>{value}</small>
            <button type="button" aria-label={t('multiSelect.remove', { label: labels.get(value) ?? value })} onClick={() => toggle(value)}><X size={13} /></button>
          </span>
        ))}
        {values.length > 1 && <button type="button" className="multi-select__clear" onClick={() => onChange([])}>{t('clearAll')}</button>}
      </div>
      <div className="multi-select__search">
        <SearchInput value={query} onChange={(next) => { search(next); setUnmatched([]) }} placeholder={placeholder ?? t('multiSelect.placeholder')} label={t('multiSelect.search', { label: label.toLowerCase() })} onEnter={commit} />
        <Button variant="secondary" disabled={!needle} onClick={commit}>{t('add')}</Button>
      </div>
      {unmatched.length > 0 && <span className="field__error">{t('multiSelect.notInCatalogue', { values: unmatched.join(', ') })}</span>}
      {browsable
        ? <ul className="multi-select__options" aria-label={t('multiSelect.options', { label })}>
          {visible.length === 0 && <li className="multi-select__none">{t('multiSelect.noMatch', { query })}</li>}
          {visible.map((option) => {
            const selected = values.includes(option.value)
            return <li key={option.value}><button type="button" name={`${name}-option`} className={cx('multi-select__option', selected && 'multi-select__option--on')} aria-pressed={selected} onClick={() => toggle(option.value)}>
              <span>{option.label}</span><small>{option.value}{option.hint ? ` · ${option.hint}` : ''}</small>
            </button></li>
          })}
        </ul>
        : <p className="multi-select__prompt">{t('multiSelect.prompt', { count: options.length })}</p>}
      <span className="field__hint">{browsable
        ? t('multiSelect.selectedShowing', { count: values.length, visible: visible.length, matches: matches.length })
        : t('multiSelect.selected', { count: values.length })}</span>
    </div>
  )
}

export function Textarea({ label, hint, error, id, className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; hint?: string; error?: string }): React.JSX.Element {
  const textareaId = id ?? props.name
  return (
    <label className={cx('field', className)} htmlFor={textareaId}>
      {label && <span className="field__label">{label}{props.required && <span aria-hidden="true"> *</span>}</span>}
      <textarea id={textareaId} className={cx('textarea', error && 'input--error')} aria-invalid={Boolean(error)} aria-describedby={error ? `${textareaId}-error` : hint ? `${textareaId}-hint` : undefined} {...props} />
      {error ? <span id={`${textareaId}-error`} className="field__error">{error}</span> : hint ? <span id={`${textareaId}-hint`} className="field__hint">{hint}</span> : null}
    </label>
  )
}

export function SearchInput({ value, onChange, placeholder = i18n.t('common:searchPlaceholder'), label = i18n.t('common:search'), onEnter }: { value: string; onChange: (value: string) => void; placeholder?: string; label?: string; onEnter?: () => void }): React.JSX.Element {
  return <label className="search-input"><Search size={17} aria-hidden="true" /><span className="sr-only">{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} onKeyDown={onEnter ? (event) => { if (event.key === 'Enter') { event.preventDefault(); onEnter() } } : undefined} /></label>
}

export function PageHeader({ eyebrow, title, purpose, actions, onHelp }: { eyebrow?: string; title: string; purpose: string; actions?: ReactNode; onHelp?: () => void }): React.JSX.Element {
  return (
    <header className="page-header">
      <div className="page-header__copy">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{purpose}</p>
      </div>
      <div className="page-header__actions">
        {actions}
        {onHelp && <Button variant="ghost" onClick={onHelp}><HelpCircle size={17} /> {i18n.t('common:help')}</Button>}
      </div>
    </header>
  )
}

export function Section({ title, description, actions, children, className }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string }): React.JSX.Element {
  return (
    <section className={cx('section-card', className)}>
      {(title || actions) && <div className="section-card__header"><div>{title && <h2>{title}</h2>}{description && <p>{description}</p>}</div>{actions && <div className="section-card__actions">{actions}</div>}</div>}
      {children}
    </section>
  )
}

export function LoadingState({ label }: { label?: string }): React.JSX.Element {
  return <div className="state-panel" role="status"><LoaderCircle className="spin" size={24} /><strong>{label ?? i18n.t('common:loading')}</strong><span>{i18n.t('common:pleaseWait')}</span></div>
}

export function EmptyState({ title, message, action }: { title: string; message: string; action?: ReactNode }): React.JSX.Element {
  return <div className="state-panel state-panel--empty"><Info size={25} /><strong>{title}</strong><span>{message}</span>{action}</div>
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }): React.JSX.Element {
  return <div className="state-panel state-panel--error" role="alert"><AlertCircle size={25} /><strong>{i18n.t('common:somethingNeedsAttention')}</strong><span>{message}</span>{onRetry && <Button variant="secondary" onClick={onRetry}>{i18n.t('common:tryAgain')}</Button>}</div>
}

export function InlineNotice({ tone = 'info', title, children }: { tone?: 'info' | 'success' | 'warning' | 'danger'; title?: string; children: ReactNode }): React.JSX.Element {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'danger' || tone === 'warning' ? AlertCircle : Info
  return <div className={cx('notice', `notice--${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}><Icon size={19} /><div>{title && <strong>{title}</strong>}<span>{children}</span></div></div>
}

export function StatusPill({ label, tone = 'neutral', pulse = false }: { label: string; tone?: 'neutral' | 'blue' | 'orange' | 'green' | 'red'; pulse?: boolean }): React.JSX.Element {
  return <span className={cx('status-pill', `status-pill--${tone}`, pulse && 'status-pill--pulse')}><i aria-hidden="true" />{label}</span>
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function useFocusContainment(open: boolean, onClose: () => void): React.RefObject<HTMLElement | null> {
  const containerRef = useRef<HTMLElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return undefined
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const container = containerRef.current
    const frame = window.requestAnimationFrame(() => {
      const first = container?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      ;(first ?? container)?.focus()
    })
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !container) return
      const controls = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => element.getClientRects().length > 0)
      if (!controls.length) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = controls[0]!
      const last = controls[controls.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown)
      returnFocusRef.current?.focus()
    }
  }, [open])

  return containerRef
}

export function Modal({ title, description, open, children, actions, onClose, width = 'medium' }: { title: string; description?: string; open: boolean; children: ReactNode; actions?: ReactNode; onClose: () => void; width?: 'small' | 'medium' | 'large' }): React.JSX.Element | null {
  const titleId = useId()
  const descriptionId = useId()
  const focusRef = useFocusContainment(open, onClose)
  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section ref={focusRef} className={cx('modal', `modal--${width}`)} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1}>
        <header><div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div><IconButton label={i18n.t('common:closeDialog')} onClick={onClose}><X size={20} /></IconButton></header>
        <div className="modal__body">{children}</div>
        {actions && <footer>{actions}</footer>}
      </section>
    </div>
  )
}

/** Electron renderers have no `window.prompt`; calling it throws. Use this instead whenever a
 * single value has to be collected before an action. */
export function PromptModal({ open, title, description, label, defaultValue = '', confirmLabel, placeholder, onCancel, onConfirm }: { open: boolean; title: string; description?: string; label: string; defaultValue?: string; confirmLabel?: string; placeholder?: string; onCancel: () => void; onConfirm: (value: string) => void }): React.JSX.Element | null {
  const [value, setValue] = useState(defaultValue)
  useEffect(() => { if (open) setValue(defaultValue) }, [open, defaultValue])
  if (!open) return null
  const submit = (): void => { const trimmed = value.trim(); if (trimmed) onConfirm(trimmed) }
  return (
    <Modal open={open} title={title} description={description} width="small" onClose={onCancel} actions={<><Button variant="secondary" onClick={onCancel}>{i18n.t('common:cancel')}</Button><Button disabled={!value.trim()} onClick={submit}>{confirmLabel ?? i18n.t('common:save')}</Button></>}>
      <Input label={label} name="prompt-value" value={value} placeholder={placeholder} autoFocus onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }} />
    </Modal>
  )
}

export function HelpDrawer({ open, title, children, onClose }: { open: boolean; title: string; children: ReactNode; onClose: () => void }): React.JSX.Element | null {
  const titleId = useId()
  const focusRef = useFocusContainment(open, onClose)
  if (!open) return null
  return <aside ref={focusRef} className="help-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><header><div><span className="eyebrow">{i18n.t('common:contextualHelp')}</span><h2 id={titleId}>{title}</h2></div><IconButton label={i18n.t('common:closeHelp')} onClick={onClose}><X size={20} /></IconButton></header><div className="help-drawer__body">{children}</div></aside>
}

export function Switch({ checked, onChange, label, description, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: string; disabled?: boolean }): React.JSX.Element {
  return <label className={cx('switch-row', disabled && 'switch-row--disabled')}><span><strong>{label}</strong>{description && <small>{description}</small>}</span><input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} disabled={disabled} /><i aria-hidden="true" /></label>
}

export function FieldGrid({ children, columns = 2 }: { children: ReactNode; columns?: 1 | 2 | 3 | 4 }): React.JSX.Element {
  return <div className={`field-grid field-grid--${columns}`}>{children}</div>
}

/** Zod reports a failing field as `path: message`; these read badly in a toast. */
const SCHEMA_HINTS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/Too small: expected string to have >=(\d+) characters/, (match) => i18n.t('common:schemaHints.tooShort', { count: Number(match[1]) })],
  [/Too big: expected string to have <=(\d+) characters/, (match) => i18n.t('common:schemaHints.tooLong', { count: Number(match[1]) })],
  [/Invalid string: must match pattern/, () => i18n.t('common:schemaHints.invalidPattern')],
  [/Invalid input: expected string/, () => i18n.t('common:schemaHints.required')],
  [/Invalid option: expected one of/, () => i18n.t('common:schemaHints.invalidOption')]
]

/**
 * Turns a thrown value into something worth showing. Electron prefixes every rejected
 * `ipcRenderer.invoke` with the channel name, and validation failures arrive as raw schema
 * text; neither belongs in front of an operator.
 */
export function formatError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (!raw) return i18n.t('common:unexpectedError')
  const message = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:Error|TypeError):\s*/, '')
    .trim()
  const field = message.match(/^([A-Za-z_][\w.]*):\s*(.+)$/)
  if (field) {
    const [, name, detail] = field
    for (const [pattern, describe] of SCHEMA_HINTS) {
      const matched = detail!.match(pattern)
      if (matched) return `${name!.replace(/[_.]/g, ' ')} ${describe(matched)}.`
    }
  }
  return message || i18n.t('common:unexpectedError')
}
