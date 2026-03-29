import { useState, useEffect } from 'react'
import { Loader2, Check, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ProviderIcon } from '@/components/ui/provider-icon'
import { toast } from 'sonner'

interface ProviderInfo {
  id: string
  name: string
  icon: string
}

interface SettingsFieldDef {
  key: string
  label: string
  type: string
  required: boolean
  placeholder?: string
}

export function SettingsIntegrations() {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [schemas, setSchemas] = useState<Record<string, SettingsFieldDef[]>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, boolean | null>>({})

  useEffect(() => {
    window.ticketImport.listProviders().then(async (provs) => {
      setProviders(provs)
      const schemaMap: Record<string, SettingsFieldDef[]> = {}
      for (const p of provs) {
        schemaMap[p.id] = await window.ticketImport.getSettingsSchema(p.id)
      }
      setSchemas(schemaMap)

      // Load saved values from localStorage
      try {
        const raw = localStorage.getItem('hive-settings')
        if (raw) {
          const parsed = JSON.parse(raw)
          const saved: Record<string, string> = {}
          for (const fields of Object.values(schemaMap)) {
            for (const field of fields) {
              const val = parsed?.state?.[field.key]
              if (typeof val === 'string') saved[field.key] = val
            }
          }
          setValues(saved)
        }
      } catch {
        // ignore
      }
    })
  }, [])

  const handleFieldChange = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }))
    setTestResult({})

    // Persist to localStorage (same store as hive-settings)
    try {
      const raw = localStorage.getItem('hive-settings') ?? '{}'
      const parsed = JSON.parse(raw)
      if (!parsed.state) parsed.state = {}
      parsed.state[key] = value
      localStorage.setItem('hive-settings', JSON.stringify(parsed))
    } catch {
      // ignore
    }
  }

  const handleTest = async (providerId: string) => {
    setTesting(providerId)
    setTestResult((prev) => ({ ...prev, [providerId]: null }))

    try {
      const providerSettings: Record<string, string> = {}
      const fields = schemas[providerId] ?? []
      for (const f of fields) {
        if (values[f.key]) providerSettings[f.key] = values[f.key]
      }

      const result = await window.ticketImport.authenticate(providerId, providerSettings)
      setTestResult((prev) => ({ ...prev, [providerId]: result.success }))
      if (result.success) {
        toast.success(`${providers.find((p) => p.id === providerId)?.name}: Connected!`)
      } else {
        toast.error(result.error ?? 'Authentication failed')
      }
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [providerId]: false }))
      toast.error(`Test failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-1">Integrations</h3>
        <p className="text-xs text-muted-foreground">
          Configure connections to external platforms for ticket import.
        </p>
      </div>

      {providers.map((provider) => {
        const fields = schemas[provider.id] ?? []
        const result = testResult[provider.id]

        return (
          <div key={provider.id} className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ProviderIcon provider={provider.icon} size="md" />
                <h4 className="text-sm font-medium">{provider.name}</h4>
              </div>
              <div className="flex items-center gap-2">
                {result === true && <Check className="h-4 w-4 text-green-500" />}
                {result === false && <X className="h-4 w-4 text-red-500" />}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={testing !== null}
                  onClick={() => handleTest(provider.id)}
                >
                  {testing === provider.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  ) : null}
                  Test connection
                </Button>
              </div>
            </div>

            {fields.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No configuration needed. Uses GitHub CLI authentication by default.
              </p>
            ) : (
              fields.map((field) => (
                <div key={field.key} className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    {field.label}
                    {!field.required && (
                      <span className="text-muted-foreground/50 ml-1">(optional)</span>
                    )}
                  </label>
                  <Input
                    type={field.type === 'password' ? 'password' : 'text'}
                    placeholder={field.placeholder}
                    value={values[field.key] ?? ''}
                    onChange={(e) => handleFieldChange(field.key, e.target.value)}
                    className="text-sm h-8"
                  />
                </div>
              ))
            )}
          </div>
        )
      })}
    </div>
  )
}
