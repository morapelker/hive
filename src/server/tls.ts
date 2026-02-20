import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import crypto from 'node:crypto'

export function generateTlsCerts(outputDir: string): void {
  const certPath = join(outputDir, 'server.crt')
  const keyPath = join(outputDir, 'server.key')

  // Idempotent: do not overwrite existing certs
  if (existsSync(certPath) && existsSync(keyPath)) return

  mkdirSync(outputDir, { recursive: true })

  // Generate ECDSA P-256 private key
  execSync(
    `openssl ecparam -genkey -name prime256v1 -noout -out "${keyPath}"`,
    { stdio: 'pipe' }
  )

  // Generate self-signed certificate (10 years)
  execSync(
    `openssl req -new -x509 -key "${keyPath}" -out "${certPath}" -days 3650 -subj "/CN=hive-headless"`,
    { stdio: 'pipe' }
  )
}

export function getCertFingerprint(certPath: string): string {
  const certPem = readFileSync(certPath, 'utf-8')
  // Extract DER from PEM
  const b64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s/g, '')
  const der = Buffer.from(b64, 'base64')
  return crypto.createHash('sha256').update(der).digest('hex')
}

export function ensureTlsCerts(
  tlsDir: string,
  storeFingerprintFn: (fingerprint: string) => void
): string {
  generateTlsCerts(tlsDir)

  const certPath = join(tlsDir, 'server.crt')
  const fingerprint = getCertFingerprint(certPath)
  storeFingerprintFn(fingerprint)

  return fingerprint
}
