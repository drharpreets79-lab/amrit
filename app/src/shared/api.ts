import type { DatasetLicence } from '../main/data-licences'
import type { GeoLookupResult } from '../main/geo-directory'
import type { CountryAddressFormat } from './address'
import type { PlaceCandidate } from './geo-directory'
import type {
  AnalysisFilters,
  AnalysisResult,
  AppBootstrap,
  AuditEntry,
  BreakpointImportResult,
  BreakpointUpdateResult,
  CountryOption,
  CountryProfile,
  ImportPreview,
  ImportProfile,
  IsolateRecord,
  Laboratory,
  LaboratoryCloneResult,
  MasterDefinition,
  MasterKind,
  OneHealthAuthStatus,
  OmicsRecord,
  OneHealthExportFormat,
  OneHealthRole,
  Row,
  SyncConfig,
  SyncStatus
} from './types'

/** One concept as the terminology service reports it. */
export interface TerminologyConceptView { code: string; display: string }

/** What `$expand` answers: the page, and how many matched in total. */
export interface TerminologyExpansionView {
  ok: boolean
  reason: string
  value?: { system: string; total: number; offset: number; concepts: TerminologyConceptView[] }
}

export interface TerminologyLookupView {
  ok: boolean
  reason: string
  value?: TerminologyConceptView
}

export interface AMRITApi {
  bootstrap(): Promise<AppBootstrap>
  /**
   * Terminology search, for a picker that must offer more codes than fit in a static list.
   *
   * Phase 24. `total` is the number of matches and not the size of the page, so a picker can
   * say how much it did not show. A system this deployment has disabled answers `ok: false`
   * with the reason rather than an empty page, because an empty page reads as "no such code".
   */
  terminology: {
    expand(system: string, filter?: string, count?: number): Promise<TerminologyExpansionView>
    lookup(system: string, code: string): Promise<TerminologyLookupView>
  }
  /** Re-read the active country profile. Bootstrap already carries it; this is for refresh. */
  countryProfile(): Promise<CountryProfile>
  /**
   * Every ISO 3166-1 country, by name and by both codes.
   *
   * Wherever a country is asked for, the operator picks a name and the record keeps the
   * alpha-3 — so no deployment ever again has "India", "INDIA" and "Bharat" as three
   * different countries in the same column.
   */
  countries(): Promise<CountryOption[]>
  /** The address form for a country: which fields it uses, requires and what it calls them. */
  addressFormat(countryCode: string): Promise<CountryAddressFormat>
  /**
   * Placing a facility. Never a patient — a residence carries a coarsened postal code and
   * giving it a coordinate would undo the coarsening.
   */
  geo: {
    /** What a postal code means here: the places it covers, and the best point for it. */
    postalCode(countryCode: string, postalCode: string, subdivisionCode?: string): Promise<GeoLookupResult>
    /** Places whose name matches. The route for a country with no postal system. */
    locality(countryCode: string, query: string): Promise<PlaceCandidate[]>
    /** The selected laboratory country's reporting hierarchy, loaded on demand. */
    reportingUnits(countryCode: string): Promise<Row[]>
  }
  /** Bundled reference data and its licence terms, for the licences view. */
  dataLicences(): Promise<DatasetLicence[]>
  deployment: {
    /** The stored overrides and the profile they resolve to. */
    get(): Promise<{ overrides: Record<string, unknown>; profile: CountryProfile }>
    /** Validate and store overrides. Namespace changes need confirmIrreversible. */
    save(overrides: Record<string, unknown>, options?: { confirmIrreversible?: boolean }): Promise<CountryProfile>
    /** Select the base country and discard overrides from the previous country. */
    selectCountry(countryCode: string, options?: { confirmCountryChange?: boolean }): Promise<CountryProfile>
    /** Discard every override and return to the base profile. */
    reset(): Promise<CountryProfile>
    /** Validate a logo file by its bytes, re-encode it, and store it on the profile. */
    logo(path: string): Promise<CountryProfile>
    /** Write the effective profile to `path` — the handoff to a country's own build. */
    export(path: string): Promise<string>
    /** Adopt the editable fields of a profile document as this deployment's overrides. */
    import(path: string, options?: { confirmIrreversible?: boolean }): Promise<CountryProfile>
  }
  chooseFile(options?: { filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>
  chooseSave(options: { defaultPath: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>
  openExternal(url: string): Promise<void>
  labs: {
    list(): Promise<Laboratory[]>
    save(lab: Laboratory): Promise<Laboratory>
    clone(sourceCode: string, targetLab: Laboratory): Promise<LaboratoryCloneResult>
    delete(code: string): Promise<void>
    select(code: string): Promise<Laboratory>
  }
  masters: {
    definitions(): Promise<MasterDefinition[]>
    list(kind: MasterKind, options?: { labCode?: string; query?: string; includeInactive?: boolean; limit?: number }): Promise<Row[]>
    save(kind: MasterKind, row: Row, labCode?: string): Promise<Row>
    delete(kind: MasterKind, key: ScalarKey, labCode?: string): Promise<void>
    toggle(kind: MasterKind, key: ScalarKey, active: boolean, labCode?: string): Promise<void>
  }
  records: {
    list(filters: Record<string, unknown>): Promise<IsolateRecord[]>
    get(id: number): Promise<IsolateRecord | null>
    save(record: IsolateRecord): Promise<{ id: number; alerts: unknown[]; comments: unknown[] }>
    delete(id: number): Promise<void>
    duplicate(record: IsolateRecord): Promise<IsolateRecord | null>
  }
  panels: { match(context: Record<string, unknown>): Promise<Row[]> }
  omics: {
    list(isolateId: number): Promise<OmicsRecord[]>
    /** Inspects a chosen file and, when small enough, copies it into the managed workspace. */
    attach(isolateId: number, path: string, options?: { copy?: boolean }): Promise<Partial<OmicsRecord>>
    save(entry: OmicsRecord): Promise<OmicsRecord>
    delete(id: number): Promise<void>
    reveal(id: number): Promise<void>
  }
  imports: {
    preview(
      path: string,
      labCode: string,
      mapping?: Record<string, string>,
      options?: { delimiter?: string; defaults?: Record<string, string> }
    ): Promise<ImportPreview>
    commit(preview: ImportPreview, labCode: string): Promise<{ imported: number; drafts: number }>
    template(path: string, labCode: string): Promise<string>
    profiles(labCode: string): Promise<ImportProfile[]>
    saveProfile(profile: ImportProfile): Promise<ImportProfile>
    deleteProfile(id: number): Promise<void>
    history(labCode: string): Promise<Row[]>
  }
  analysis: {
    run(filters: AnalysisFilters): Promise<AnalysisResult>
    macros(labCode: string): Promise<Row[]>
    saveMacro(labCode: string, macro: Row): Promise<Row>
    deleteMacro(id: number): Promise<void>
  }
  exports: { save(format: 'whonet' | 'fhir' | 'hl7' | 'measure' | 'json' | 'csv', filters: AnalysisFilters, path: string): Promise<string> }
  breakpoints: {
    import(path: string, source?: Record<string, string>): Promise<BreakpointImportResult>
    download(url?: string): Promise<{ path: string; result?: BreakpointImportResult }>
    sets(): Promise<Row[]>
    activate(id: number): Promise<Row>
    /**
     * Fetch and stage the current EUCAST table in one step.
     *
     * EUCAST publishes its breakpoints free of charge and permits redistribution with
     * attribution, so unlike CLSI it can be pulled straight into the catalogue rather than
     * downloaded to disk for the operator to import by hand.
     */
    updateEucast(): Promise<BreakpointUpdateResult>
    /** What is installed, and what the published table says, so the button can say why. */
    eucastStatus(): Promise<{ installed: string | null; installedRows: number; bundled: string | null; sourceUrl: string; licence: string }>
  }
  sync: {
    get(): Promise<{ config: SyncConfig; status: SyncStatus }>
    save(config: SyncConfig): Promise<SyncConfig>
    start(config?: SyncConfig): Promise<SyncStatus>
    stop(): Promise<SyncStatus>
    test(config?: SyncConfig): Promise<{ ok: boolean; message: string }>
    configureToken(config?: SyncConfig): Promise<SyncConfig>
    requestAccess(config?: SyncConfig): Promise<{ status: 'pending' | 'registered'; detail: string; requestedAt: string }>
    /**
     * Open the operating system's location-privacy settings.
     *
     * Location services being switched off is fixed in the operating system, not in this
     * application, so the only useful thing a laboratory can be given is the screen where
     * it is switched on.
     */
    openLocationSettings(): Promise<{ opened: boolean; detail: string }>
    /**
     * What this build can expect from the computer's location service.
     *
     * A development build cannot read Core Location at all — the Info.plist that asks macOS
     * for permission belongs to the packaged application — so the screen has to be able to
     * say that instead of reporting a mystery.
     */
    locationSupport(): Promise<{ platform: string; packaged: boolean; supported: boolean; detail: string }>
    onStatus(callback: (status: SyncStatus) => void): () => void
  }
  audit: { list(limit?: number): Promise<AuditEntry[]> }
  privacy: {
    /**
     * Expire row-level data older than the profile's retention period.
     * Defaults to a dry run: the caller sees what would go before anything is destroyed.
     */
    purge(options?: { dryRun?: boolean }): Promise<{
      applied: boolean; dryRun: boolean; retentionDays: number | null; cutoff: string | null; removed: Row[]
    }>
    /** Shred the audit payloads naming a subject, leaving the chain verifiable. */
    eraseAudit(objectType: string, objectId: string, reason: string): Promise<{ erased: number; alreadyErased: number }>
  }
  preferences: { get(): Promise<Record<string, string>>; save(values: Record<string, string>): Promise<void> }
  llm: {
    ask(template: string, fields: Record<string, string>): Promise<{ text: string; provider: string }>
    models(): Promise<string[]>
    pull(model: string): Promise<void>
    delete(model: string): Promise<void>
    test(): Promise<{ ok: boolean; message: string }>
  }
  oneHealth: {
    authStatus(): Promise<OneHealthAuthStatus>
    bootstrapAdmin(username: string, password: string): Promise<OneHealthAuthStatus>
    login(username: string, password: string): Promise<OneHealthAuthStatus>
    logout(): Promise<OneHealthAuthStatus>
    users(): Promise<Row[]>
    createUser(input: { username: string; password: string; roles: OneHealthRole[] }): Promise<Row>
    modules(): Promise<Row[]>
    capture(module: string, payload: Row): Promise<Row>
    records(module?: string): Promise<Row[]>
    metrics(module: string): Promise<Row>
    enqueue(module: string): Promise<Row>
    export(format: OneHealthExportFormat, module: string, path: string): Promise<string>
    backup(path: string): Promise<{ path: string; sha256: string }>
    alerts(module?: string): Promise<Row[]>
    reviewAlert(id: string, input: { status: 'reviewed' | 'dismissed' | 'escalated'; note?: string }): Promise<Row>
    actions(module?: string): Promise<Row[]>
    createAction(input: Row): Promise<Row>
    updateAction(id: string, input: { status: string; evidence?: string }): Promise<Row>
    audit(limit?: number): Promise<Row[]>
    verifyAudit(): Promise<Row>
    outbox(): Promise<Row[]>
  }
}

export type ScalarKey = string | number

declare global {
  interface Window {
    amrit: AMRITApi
  }
}
