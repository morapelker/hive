const overrides = new WeakMap<object, Map<PropertyKey, unknown>>()

export const setLegacyApiOverride = (
  target: object,
  property: PropertyKey,
  value: unknown
): void => {
  const existing = overrides.get(target)
  if (existing) {
    existing.set(property, value)
    return
  }

  overrides.set(target, new Map([[property, value]]))
}

export const getLegacyApiOverride = (
  target: object,
  property: PropertyKey
): { readonly found: true; readonly value: unknown } | { readonly found: false } => {
  const value = overrides.get(target)
  if (!value?.has(property)) return { found: false }
  return { found: true, value: value.get(property) }
}
