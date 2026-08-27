import { contextBridge, ipcRenderer } from 'electron'
import type { AMRITApi } from '../shared/api'
import type { SyncStatus } from '../shared/types'
import { channels } from '../shared/channels'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args)

const api: AMRITApi = {
  bootstrap: () => invoke(channels.bootstrap),
  countryProfile: () => invoke(channels.countryProfileGet),
  countries: () => invoke(channels.countriesList),
  addressFormat: (countryCode) => invoke(channels.addressFormatGet, countryCode),
  terminology: {
    expand: (system: string, filter?: string, count?: number) =>
      invoke(channels.terminologyExpand, system, filter ?? '', count ?? 50),
    lookup: (system: string, code: string) => invoke(channels.terminologyLookup, system, code)
  },
  geo: {
    postalCode: (countryCode, postalCode, subdivisionCode) =>
      invoke(channels.geoPostalLookup, countryCode, postalCode, subdivisionCode),
    locality: (countryCode, query) => invoke(channels.geoLocalitySearch, countryCode, query),
    reportingUnits: (countryCode) => invoke(channels.geoReportingUnits, countryCode)
  },
  dataLicences: () => invoke(channels.dataLicences),
  deployment: {
    get: () => invoke(channels.deploymentSettingsGet),
    save: (overrides, options) => invoke(channels.deploymentSettingsSave, overrides, options),
    selectCountry: (countryCode, options) => invoke(channels.deploymentSettingsCountry, countryCode, options),
    reset: () => invoke(channels.deploymentSettingsReset),
    logo: (path) => invoke(channels.deploymentSettingsLogo, path),
    export: (path) => invoke(channels.deploymentSettingsExport, path),
    import: (path, options) => invoke(channels.deploymentSettingsImport, path, options)
  },
  chooseFile: (options) => invoke(channels.chooseFile, options),
  chooseSave: (options) => invoke(channels.chooseSave, options),
  openExternal: (url) => invoke(channels.openExternal, url),
  labs: {
    list: () => invoke(channels.labsList),
    save: (lab) => invoke(channels.labsSave, lab),
    clone: (sourceCode, targetLab) => invoke(channels.labsClone, sourceCode, targetLab),
    delete: (code) => invoke(channels.labsDelete, code),
    select: (code) => invoke(channels.labsSelect, code)
  },
  masters: {
    definitions: () => invoke(channels.masterDefinitions),
    list: (kind, options) => invoke(channels.masterList, kind, options),
    save: (kind, row, labCode) => invoke(channels.masterSave, kind, row, labCode),
    delete: (kind, key, labCode) => invoke(channels.masterDelete, kind, key, labCode),
    toggle: (kind, key, active, labCode) => invoke(channels.masterToggle, kind, key, active, labCode)
  },
  records: {
    list: (filters) => invoke(channels.recordsList, filters),
    get: (id) => invoke(channels.recordsGet, id),
    save: (record) => invoke(channels.recordsSave, record),
    delete: (id) => invoke(channels.recordsDelete, id),
    duplicate: (record) => invoke(channels.recordsDuplicate, record)
  },
  panels: { match: (context) => invoke(channels.panelsMatch, context) },
  omics: {
    list: (isolateId) => invoke(channels.omicsList, isolateId),
    attach: (isolateId, path, options) => invoke(channels.omicsAttach, isolateId, path, options),
    save: (entry) => invoke(channels.omicsSave, entry),
    delete: (id) => invoke(channels.omicsDelete, id),
    reveal: (id) => invoke(channels.omicsReveal, id)
  },
  imports: {
    preview: (path, labCode, mapping, options) => invoke(channels.importPreview, path, labCode, mapping, options),
    commit: (preview, labCode) => invoke(channels.importCommit, preview, labCode),
    template: (path, labCode) => invoke(channels.importTemplate, path, labCode),
    profiles: (labCode) => invoke(channels.importProfiles, labCode),
    saveProfile: (profile) => invoke(channels.importProfileSave, profile),
    deleteProfile: (id) => invoke(channels.importProfileDelete, id),
    history: (labCode) => invoke(channels.importHistory, labCode)
  },
  analysis: {
    run: (filters) => invoke(channels.analysisRun, filters),
    macros: (labCode) => invoke(channels.analysisMacros, labCode),
    saveMacro: (labCode, macro) => invoke(channels.analysisMacroSave, labCode, macro),
    deleteMacro: (id) => invoke(channels.analysisMacroDelete, id)
  },
  exports: { save: (format, filters, path) => invoke(channels.exportData, format, filters, path) },
  breakpoints: {
    import: (path, source) => invoke(channels.breakpointImport, path, source),
    download: (url) => invoke(channels.breakpointDownload, url),
    sets: () => invoke(channels.breakpointSets),
    activate: (id) => invoke(channels.breakpointActivate, id),
    updateEucast: () => invoke(channels.breakpointEucastUpdate),
    eucastStatus: () => invoke(channels.breakpointEucastStatus)
  },
  sync: {
    get: () => invoke(channels.syncGet),
    save: (config) => invoke(channels.syncSave, config),
    start: (config) => invoke(channels.syncStart, config),
    stop: () => invoke(channels.syncStop),
    test: (config) => invoke(channels.syncTest, config),
    configureToken: (config) => invoke(channels.syncConfigureToken, config),
    requestAccess: (config) => invoke(channels.syncRequestAccess, config),
    openLocationSettings: () => invoke(channels.syncOpenLocationSettings),
    locationSupport: () => invoke(channels.syncLocationSupport),
    onStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, status: SyncStatus): void => callback(status)
      ipcRenderer.on(channels.syncStatusEvent, listener)
      return () => ipcRenderer.removeListener(channels.syncStatusEvent, listener)
    }
  },
  audit: { list: (limit) => invoke(channels.auditList, limit) },
  privacy: {
    purge: (options) => invoke(channels.privacyRetentionPurge, options),
    eraseAudit: (objectType, objectId, reason) => invoke(channels.privacyAuditErase, objectType, objectId, reason)
  },
  preferences: {
    get: () => invoke(channels.preferencesGet),
    save: (values) => invoke(channels.preferencesSave, values)
  },
  llm: {
    ask: (template, fields) => invoke(channels.llmAsk, template, fields),
    models: () => invoke(channels.llmModels),
    pull: (model) => invoke(channels.llmPull, model),
    delete: (model) => invoke(channels.llmDelete, model),
    test: () => invoke(channels.llmTest)
  },
  oneHealth: {
    authStatus: () => invoke(channels.oneHealthAuthStatus),
    bootstrapAdmin: (username, password) => invoke(channels.oneHealthBootstrapAdmin, username, password),
    login: (username, password) => invoke(channels.oneHealthLogin, username, password),
    logout: () => invoke(channels.oneHealthLogout),
    users: () => invoke(channels.oneHealthUsers),
    createUser: (input) => invoke(channels.oneHealthUserCreate, input),
    modules: () => invoke(channels.oneHealthModules),
    capture: (module, payload) => invoke(channels.oneHealthCapture, module, payload),
    records: (module) => invoke(channels.oneHealthRecords, module),
    metrics: (module) => invoke(channels.oneHealthMetrics, module),
    enqueue: (module) => invoke(channels.oneHealthEnqueue, module),
    export: (format, module, path) => invoke(channels.oneHealthExport, format, module, path),
    backup: (path) => invoke(channels.oneHealthBackup, path),
    alerts: (module) => invoke(channels.oneHealthAlerts, module),
    reviewAlert: (id, input) => invoke(channels.oneHealthAlertReview, id, input),
    actions: (module) => invoke(channels.oneHealthActions, module),
    createAction: (input) => invoke(channels.oneHealthActionCreate, input),
    updateAction: (id, input) => invoke(channels.oneHealthActionUpdate, id, input),
    audit: (limit) => invoke(channels.oneHealthAudit, limit),
    verifyAudit: () => invoke(channels.oneHealthAuditVerify),
    outbox: () => invoke(channels.oneHealthOutbox)
  }
}

contextBridge.exposeInMainWorld('amrit', Object.freeze(api))
