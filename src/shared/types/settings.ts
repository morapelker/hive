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
