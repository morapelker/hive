/** DB key for the single JSON blob of app settings (useSettingsStore, openPathWithPreferredEditor, etc.). */
export const APP_SETTINGS_DB_KEY = 'app_settings'

export const DEFAULT_HIVE_ENTERPRISE_SERVER_URL = 'https://hive.tedooo.com'

export interface Setting {
  key: string
  value: string
}

export interface TeleportSettings {
  url: string
  bootstrapToken: string
}

export interface DetectedApp {
  id: string
  name: string
  command: string
  available: boolean
}
