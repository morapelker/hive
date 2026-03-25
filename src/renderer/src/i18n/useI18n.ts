import { useMemo } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { DEFAULT_LOCALE, messages, type AppLocale } from './messages'

type Primitive = string | number | boolean

function getMessageNode(locale: AppLocale, key: string): string | null {
  const tryResolve = (targetLocale: AppLocale): string | null => {
    let node: unknown = messages[targetLocale]
    for (const segment of key.split('.')) {
      if (!node || typeof node !== 'object' || !(segment in node)) {
        return null
      }
      node = (node as Record<string, unknown>)[segment]
    }
    return typeof node === 'string' ? node : null
  }

  return tryResolve(locale) ?? tryResolve(DEFAULT_LOCALE)
}

function interpolate(template: string, params?: Record<string, Primitive>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_match, token: string) => {
    const value = params[token]
    return value === undefined ? `{${token}}` : String(value)
  })
}

export function translate(
  locale: AppLocale,
  key: string,
  params?: Record<string, Primitive>
): string {
  const template = getMessageNode(locale, key) ?? key
  return interpolate(template, params)
}

export function useI18n(): {
  locale: AppLocale
  supportsFirstCharHint: boolean
  t: (key: string, params?: Record<string, Primitive>) => string
} {
  const locale = useSettingsStore((state) => state.locale ?? DEFAULT_LOCALE)

  return useMemo(
    () => ({
      locale,
      supportsFirstCharHint: locale === 'en',
      t: (key: string, params?: Record<string, Primitive>) => translate(locale, key, params)
    }),
    [locale]
  )
}
