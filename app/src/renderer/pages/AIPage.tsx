/* Initial provider discovery runs once; subsequent changes are explicitly saved/tested by the user. */
/* eslint-disable react-hooks/exhaustive-deps */
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Bot, CheckCircle2, Cpu, Download, ExternalLink, KeyRound, MessageSquareText, Send, Server, ShieldCheck, Trash2, User } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { i18n } from '../i18n'
import { useToast } from '../components/Toast'
import { Button, CustomSelect, HelpDrawer, InlineNotice, Input, PageHeader, Section, Select, StatusPill, Switch, Textarea, formatError } from '../components/ui'

interface ChatMessage { role: 'user' | 'assistant'; text: string; provider?: string }
interface AISettings { provider: string; endpoint: string; model: string; apiKey: string; enabled: boolean; externalOptIn: boolean; redactIdentifiers: boolean }
const DEFAULTS: AISettings = { provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: '', apiKey: '', enabled: false, externalOptIn: false, redactIdentifiers: true }
const TEMPLATES = ['free', 'trend_narrative', 'code_organism', 'code_specimen', 'ast_sanity', 'column_mapping', 'panel_suggestion'] as const

export function AIPage(): React.JSX.Element {
  const { t } = useTranslation('ai')
  const { notify } = useToast()
  const [settings, setSettings] = useState<AISettings>(DEFAULTS)
  const [models, setModels] = useState<string[]>([])
  const [pullName, setPullName] = useState('')
  const [question, setQuestion] = useState('')
  const [template, setTemplate] = useState('free')
  const [messages, setMessages] = useState<ChatMessage[]>(() => [{ role: 'assistant', text: i18n.t('ai:greeting') }])
  const [busy, setBusy] = useState('')
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false)
  const [help, setHelp] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const load = async (): Promise<void> => {
    try {
      const preferences = await window.amrit.preferences.get()
      setSettings({ provider: preferences.llm_provider || DEFAULTS.provider, endpoint: preferences.llm_base_url || DEFAULTS.endpoint, model: preferences.llm_model || '', apiKey: '', enabled: preferences.llm_network_enabled === 'true' || preferences.llm_network_enabled === '1', externalOptIn: preferences.llm_external_opt_in === 'true' || preferences.llm_external_opt_in === '1', redactIdentifiers: preferences.llm_redact_phi !== 'false' && preferences.llm_redact_phi !== '0' })
      setApiKeyConfigured(preferences.llm_api_key_configured === 'true' || preferences.llm_api_key_configured === '1')
    } catch (caught) { notify(t('notify.loadFailed'), formatError(caught), 'error') }
    try { setModels(await window.amrit.llm.models()) } catch { setModels([]) }
  }
  useEffect(() => { void load() }, [])
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [messages])
  const update = <K extends keyof AISettings>(key: K, value: AISettings[K]): void => setSettings((current) => ({ ...current, [key]: value }))
  const save = async (): Promise<void> => {
    if (settings.provider !== 'ollama' && settings.enabled && !settings.externalOptIn) { notify(t('notify.consentRequired'), t('notify.consentDetail'), 'error'); return }
    setBusy('save')
    const networkEnabled = settings.provider === 'ollama' ? settings.enabled : settings.enabled && settings.externalOptIn
    try { await window.amrit.preferences.save({ llm_provider: settings.provider, llm_base_url: settings.endpoint, llm_model: settings.model, llm_api_key: settings.apiKey, llm_network_enabled: String(networkEnabled), llm_external_opt_in: String(settings.externalOptIn), llm_redact_phi: String(settings.redactIdentifiers) }); notify(t('notify.saved'), settings.apiKey ? t('notify.savedKey') : t('notify.savedNoKey')); if (settings.apiKey) setApiKeyConfigured(true); setSettings((current) => ({ ...current, apiKey: '' })) }
    catch (caught) { notify(t('notify.saveFailed'), formatError(caught), 'error') } finally { setBusy('') }
  }
  const clearApiKey = async (): Promise<void> => {
    if (!window.confirm(t('notify.confirmClearKey'))) return
    setBusy('clear-key')
    try {
      await window.amrit.preferences.save({ llm_api_key_clear: '1' })
      setApiKeyConfigured(false)
      update('apiKey', '')
      notify(t('notify.keyCleared'), t('notify.keyClearedDetail'))
    } catch (caught) { notify(t('notify.keyClearFailed'), formatError(caught), 'error') } finally { setBusy('') }
  }
  const testConnection = async (): Promise<void> => {
    setBusy('test'); setTest(null)
    try { const result = await window.amrit.llm.test(); setTest(result) } catch (caught) { setTest({ ok: false, message: formatError(caught) }) } finally { setBusy('') }
  }
  const pull = async (): Promise<void> => {
    if (!pullName.trim()) return
    setBusy('pull')
    try { await window.amrit.llm.pull(pullName.trim()); notify(t('notify.pulled'), pullName.trim()); setPullName(''); setModels(await window.amrit.llm.models()) }
    catch (caught) { notify(t('notify.pullFailed'), formatError(caught), 'error') } finally { setBusy('') }
  }
  const removeModel = async (model: string): Promise<void> => {
    if (!window.confirm(t('notify.confirmDeleteModel', { model }))) return
    try { await window.amrit.llm.delete(model); notify(t('notify.modelDeleted'), model); setModels(await window.amrit.llm.models()) } catch (caught) { notify(t('notify.modelDeleteFailed'), formatError(caught), 'error') }
  }
  const ask = async (): Promise<void> => {
    const prompt = question.trim(); if (!prompt || busy) return
    setMessages((current) => [...current, { role: 'user', text: prompt }]); setQuestion(''); setBusy('ask')
    try { const result = await window.amrit.llm.ask(template, { text: prompt, summary: prompt, privacy: settings.redactIdentifiers ? 'redact' : 'approved-input-only' }); setMessages((current) => [...current, { role: 'assistant', text: result.text, provider: result.provider }]) }
    catch (caught) { setMessages((current) => [...current, { role: 'assistant', text: t('workspace.unavailable', { reason: formatError(caught) }), provider: 'error' }]) } finally { setBusy('') }
  }
  const hosted = settings.provider !== 'ollama' && settings.provider !== 'disabled'
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} onHelp={() => setHelp(true)} />
    <InlineNotice tone="warning" title={t('reviewTitle')}>{t('reviewBody')}</InlineNotice>
    <div className="ai-layout">
      <Section title={t('workspace.title')} description={t('workspace.description')} className="chat-card">
        <div className="chat-toolbar"><Select aria-label={t('workspace.task')} value={template} onChange={(event) => setTemplate(event.target.value)}>{TEMPLATES.map((name) => <option key={name} value={name}>{t(`templates.${name}`)}</option>)}</Select><StatusPill label={settings.enabled ? t('workspace.enabled', { provider: settings.provider }) : t('workspace.disabled')} tone={settings.enabled ? 'green' : 'neutral'} /></div>
        <div className="chat-messages" ref={scrollRef}>{messages.map((message, index) => <div className={`chat-message chat-message--${message.role}`} key={index}><span>{message.role === 'assistant' ? <Bot size={18} /> : <User size={18} />}</span><div><strong>{message.role === 'assistant' ? t('workspace.assistant') : t('workspace.you')}</strong><p>{message.text}</p>{message.provider && <small>{message.provider}</small>}</div></div>)}{busy === 'ask' && <div className="chat-message chat-message--assistant"><span><Bot size={18} /></span><div><strong>{t('workspace.assistant')}</strong><p className="typing"><i /><i /><i /></p></div></div>}</div>
        <div className="chat-composer"><Textarea aria-label={t('workspace.message')} rows={3} value={question} placeholder={t('workspace.placeholder')} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void ask() }} onChange={(event) => setQuestion(event.target.value)} /><Button disabled={!settings.enabled || !question.trim() || Boolean(busy)} onClick={() => void ask()}><Send size={17} /> {t('workspace.send')}</Button></div><small className="composer-hint">{t('workspace.composerHint')}</small>
      </Section>
      <div>
        <Section title={t('provider.title')} description={t('provider.description')}>
          <Switch checked={settings.enabled} onChange={(value) => update('enabled', value)} label={t('provider.enable')} description={t('provider.enableDetail')} />
          <CustomSelect label={t('provider.label')} name="ai-provider" value={settings.provider} onChange={(value) => update('provider', value)} options={[{ value: 'ollama', label: t('provider.ollama') }, { value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }]} />
          <Input label={t('provider.endpoint')} value={settings.endpoint} onChange={(event) => update('endpoint', event.target.value)} />
          {settings.provider === 'ollama' ? <Select label={t('provider.model')} value={settings.model} onChange={(event) => update('model', event.target.value)}><option value="">{t('provider.selectLocalModel')}</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</Select> : <><Input label={t('provider.modelName')} value={settings.model} onChange={(event) => update('model', event.target.value)} /><Input label={t('provider.apiKey')} type="password" autoComplete="new-password" value={settings.apiKey} placeholder={apiKeyConfigured ? t('provider.apiKeyReplace') : t('provider.apiKeyEnter')} onChange={(event) => update('apiKey', event.target.value)} /><div className="key-storage-state"><StatusPill label={apiKeyConfigured ? t('provider.storedKey') : t('provider.noStoredKey')} tone={apiKeyConfigured ? 'green' : 'neutral'} /><Button variant="ghost" className="danger-text" disabled={!apiKeyConfigured || Boolean(busy)} onClick={() => void clearApiKey()}><Trash2 size={15} />{busy === 'clear-key' ? t('provider.clearing') : t('provider.clearKey')}</Button></div></>}
          {hosted && <Switch checked={settings.externalOptIn} onChange={(value) => update('externalOptIn', value)} label={t('provider.externalOptIn')} description={t('provider.externalOptInDetail')} />}
          <Switch checked={settings.redactIdentifiers} onChange={(value) => update('redactIdentifiers', value)} label={t('provider.redact')} description={t('provider.redactDetail')} />
          <div className="form-actions"><Button variant="secondary" disabled={Boolean(busy)} onClick={() => void testConnection()}>{busy === 'test' ? t('provider.testing') : t('provider.testProvider')}</Button><Button disabled={Boolean(busy)} onClick={() => void save()}>{busy === 'save' ? t('provider.saving') : t('provider.saveSettings')}</Button></div>
          {test && <InlineNotice tone={test.ok ? 'success' : 'danger'} title={test.ok ? t('provider.ready') : t('provider.unavailable')}>{test.message}</InlineNotice>}
        </Section>
        {settings.provider === 'ollama' && <Section title={t('models.title')} description={t('models.description')}><div className="model-pull"><Input aria-label={t('models.name')} value={pullName} placeholder={t('models.placeholder')} onChange={(event) => setPullName(event.target.value)} /><Button variant="secondary" disabled={!pullName.trim() || Boolean(busy)} onClick={() => void pull()}><Download size={16} />{busy === 'pull' ? t('models.downloading') : t('models.pull')}</Button></div>{models.length ? <div className="model-list">{models.map((model) => <div key={model}><Cpu size={17} /><span>{model}</span><Button variant="ghost" className="danger-text" onClick={() => void removeModel(model)}><Trash2 size={15} /><span className="sr-only">{t('models.delete', { model })}</span></Button></div>)}</div> : <p className="muted">{t('models.none')}</p>}<Button variant="ghost" onClick={() => void window.amrit.openExternal('https://ollama.com/library')}>{t('models.browse')} <ExternalLink size={15} /></Button></Section>}
        <Section title={t('safety.title')}><div className="ai-safety-list"><div><ShieldCheck size={17} /><span>{t('safety.fallback')}</span></div><div><KeyRound size={17} /><span>{t('safety.credentials')}</span></div><div><Server size={17} /><span>{t('safety.network')}</span></div><div><MessageSquareText size={17} /><span>{t('safety.reasoning')}</span></div><div><CheckCircle2 size={17} /><span>{t('safety.verification')}</span></div></div></Section>
      </div>
    </div>
    <HelpDrawer open={help} title={t('title')} onClose={() => setHelp(false)}><p>{t('help.optional')}</p><h3>{t('help.privacyTitle')}</h3><p>{t('help.privacyBody')}</p><h3>{t('help.scopeTitle')}</h3><p>{t('help.scopeBody')}</p></HelpDrawer>
  </>
}
