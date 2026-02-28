/** DB key for the single JSON blob of app settings (useSettingsStore, openPathWithPreferredEditor, etc.). */
export const APP_SETTINGS_DB_KEY = 'app_settings'

export interface Setting {
  key: string
  value: string
}

export interface DetectedApp {
  id: string
  name: string
  command: string
  available: boolean
}
