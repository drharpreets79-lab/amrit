import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { PANEL_REQUIREMENT_TYPES, isEssentialRequirement, type PanelAntibioticMember } from '../../shared/types'
import { Button, cx, Input, MultiSelect, Select, StatusPill, type MultiOption } from './ui'

/**
 * Membership plus per-member requirement type for one AST panel — antibiotics, or the genomic
 * AMR markers prescribed alongside them. Essential members are pre-loaded during isolate entry;
 * optional members are offered there as add-ons.
 */
export function PanelAntibioticsEditor({ label, hint, name, members, options, onChange, itemLabel = 'antibiotic', showOptionGroup = true }: {
  label: string
  hint?: string
  name: string
  members: PanelAntibioticMember[]
  options: MultiOption[]
  onChange: (members: PanelAntibioticMember[]) => void
  itemLabel?: string
  /** Option groups express "test one of these"; genomic markers have no such grouping. */
  showOptionGroup?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('common')
  const labels = new Map(options.map((option) => [option.value, option.label]))
  const essentialCount = members.filter((member) => isEssentialRequirement(member.requirement_type)).length
  const resequence = (next: PanelAntibioticMember[]): PanelAntibioticMember[] => next.map((member, index) => ({ ...member, sort_order: (index + 1) * 10 }))
  const setMembership = (codes: string[]): void => {
    const existing = new Map(members.map((member) => [member.code, member]))
    onChange(resequence(codes.map((code) => existing.get(code) ?? { code, name: labels.get(code) ?? code, requirement_type: 'core', option_group: '', notes: '' })))
  }
  const patch = (code: string, changes: Partial<PanelAntibioticMember>): void =>
    onChange(members.map((member) => member.code === code ? { ...member, ...changes } : member))
  const move = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= members.length) return
    const next = [...members]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved!)
    onChange(resequence(next))
  }
  return (
    <div className="panel-antibiotics">
      <MultiSelect
        label={label}
        hint={hint}
        name={name}
        values={members.map((member) => member.code)}
        options={options}
        onChange={setMembership}
        placeholder={`Search the ${itemLabel} catalogue, or paste codes separated by commas…`}
        emptyLabel={`No ${itemLabel} is part of this panel yet.`}
      />
      {members.length > 0 && <>
        <div className="panel-antibiotics__summary">
          <StatusPill label={`${essentialCount} essential`} tone="green" />
          <StatusPill label={`${members.length - essentialCount} optional`} tone="orange" />
        </div>
        <div className={cx('panel-antibiotics__grid', !showOptionGroup && 'panel-antibiotics__grid--compact')}>
          <div className="panel-antibiotics__head"><span>{itemLabel === 'antibiotic' ? 'Antibiotic' : 'Marker'}</span><span>{t('editor.requirement')}</span>{showOptionGroup && <span>{t('editor.optionGroup')}</span>}<span>{t('editor.order')}</span><span /></div>
          {members.map((member, index) => (
            <div className="panel-antibiotics__row" key={member.code || index}>
              <div><strong>{member.name || labels.get(member.code) || member.code}</strong><small>{member.code}</small></div>
              <Select aria-label={`${member.code} requirement type`} value={String(member.requirement_type ?? 'core')} onChange={(event) => patch(member.code, { requirement_type: event.target.value })}>
                {PANEL_REQUIREMENT_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                {!PANEL_REQUIREMENT_TYPES.some((option) => option.value === String(member.requirement_type ?? 'core')) &&
                  <option value={String(member.requirement_type)}>{t('editor.fromSource', { value: String(member.requirement_type) })}</option>}
              </Select>
              {showOptionGroup && <Input aria-label={`${member.code} option group`} value={String(member.option_group ?? '')} placeholder="Only for one-of choices" onChange={(event) => patch(member.code, { option_group: event.target.value })} />}
              <div className="panel-antibiotics__order">
                <span>{member.sort_order ?? (index + 1) * 10}</span>
                <Button variant="ghost" aria-label={`Move ${member.code} earlier`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} /></Button>
                <Button variant="ghost" aria-label={`Move ${member.code} later`} disabled={index === members.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></Button>
              </div>
              <Button variant="ghost" className="danger-text" aria-label={`Remove ${member.code} from panel`} onClick={() => setMembership(members.filter((item) => item.code !== member.code).map((item) => item.code))}><Trash2 size={15} /></Button>
            </div>
          ))}
        </div>
      </>}
    </div>
  )
}
