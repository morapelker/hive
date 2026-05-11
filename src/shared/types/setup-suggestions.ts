export type SuggestionCategory = 'env' | 'install' | 'postinstall'

export type SuggestionItem = {
  id: string
  command: string
  label: string
  category: SuggestionCategory
  defaultChecked: boolean
}
