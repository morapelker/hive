// The one mongosh masker behind query history, the assistant and the renderer's persisted
// drafts: the union of what the former server and renderer maskers each caught.
import { describe, expect, it } from 'vitest'

import { isMongoSecretKey, maskMongoSecrets } from './mask'

describe('maskMongoSecrets', () => {
  const cases: Array<[string, string]> = [
    // Dotted / dashed / quoted keys ($set paths, JSON documents).
    [
      'db.users.updateOne({_id:1},{$set:{"auth.password":"Hunter2"}})',
      'db.users.updateOne({_id:1},{$set:{"auth.password":"***"}})'
    ],
    ['{"smtp-password": "hunter2"}', '{"smtp-password": "***"}'],
    [
      'db.x.updateOne({}, {$set: {"services.password.bcrypt": "h"}})',
      'db.x.updateOne({}, {$set: {"services.password.bcrypt": "***"}})'
    ],
    ["db.updateUser('u', { ['pwd']: 'x1' })", "db.updateUser('u', { ['pwd']: '***' })"],
    // Keys the old server masker missed, and ones the old renderer masker missed.
    [
      'db.s.insertOne({ sessionToken: "tok", apiKey: "k", "x-auth-token": "t" })',
      'db.s.insertOne({ sessionToken: "***", apiKey: "***", "x-auth-token": "***" })'
    ],
    [
      "{ createUser: 'app', passphrase: 'S3cretPw', secretKey: 'sk', privateKey: 'pk' }",
      "{ createUser: 'app', passphrase: '***', secretKey: '***', privateKey: '***' }"
    ],
    [
      "{ kms: { aws: { accessKeyId: 'AK', secretAccessKey: 'SK' }, azure: { accessKey: 'AZ' } } }",
      "{ kms: { aws: { accessKeyId: 'AK', secretAccessKey: '***' }, azure: { accessKey: '***' } } }"
    ],
    // Positional passwords, old and new shells.
    ["db.createUser('app', 'S3cretPw')", "db.createUser('app', '***')"],
    ["db.addUser('app','S3cretPw')", "db.addUser('app','***')"],
    ["db.changeUserPassword('app', 'NewPw3')", "db.changeUserPassword('app', '***')"],
    ['db.getSiblingDB("admin").auth("root", "pw")', 'db.getSiblingDB("admin").auth("root", "***")'],
    ["db.auth(getUser({ a: [1, 2] }), 'pw')", "db.auth(getUser({ a: [1, 2] }), '***')"],
    // Every string of a + concatenation.
    ["{ pwd: 'S3cret' + 'Pw' }", "{ pwd: '***' + '***' }"],
    ["db.auth('app', 'S3cret' + 'Pw')", "db.auth('app', '***' + '***')"],
    [
      'db.createUser({ user: "u", pwd: pre + "a\\"b" + cfg.tail + `c`, roles: [] })',
      'db.createUser({ user: "u", pwd: pre + "***" + cfg.tail + `***`, roles: [] })'
    ],
    // Comments, half-typed strings and URLs.
    [
      "// db.auth('app', 'S3cret')\n/* pwd: \"x\" */ db.a.find()",
      "// db.auth('app', '***')\n/* pwd: \"***\" */ db.a.find()"
    ],
    ["db.createUser({ user: 'u', pwd: 'Sup3rSe", "db.createUser({ user: 'u', pwd: '***'"],
    [
      'connect("mongodb://root:mongo@pw@127.0.0.1:27018/admin")',
      'connect("mongodb://root:***@127.0.0.1:27018/admin")'
    ]
  ]
  it.each(cases)('%j', (input, expected) => {
    const masked = maskMongoSecrets(input)
    expect(masked).toBe(expected)
    expect(maskMongoSecrets(masked)).toBe(masked)
  })

  it('reads apostrophes of prose around shell code as letters', () => {
    expect(maskMongoSecrets("what's wrong with db.auth('app', 'MPw1')? it's weird")).toBe(
      "what's wrong with db.auth('app', '***')? it's weird"
    )
    expect(maskMongoSecrets("I'm using { pwd: 'MPw2' } // don't")).toBe(
      "I'm using { pwd: '***' } // don't"
    )
  })

  it('leaves settings, non-string values and ordinary fields alone', () => {
    for (const text of [
      "db.createUser({ user: 'u', pwd: passwordPrompt(), passwordDigestor: 'server' })",
      'db.users.find({ password: { $exists: true } }).sort({ pwdChangedAt: -1, passwordHint: 1 })',
      "db.users.find({ note: 'pwd: x', name: 'password' })",
      "db.createSearchIndex('s', { mappings: { fields: { t: { type: 'autocomplete', tokenization: 'edgeGram' } } } })",
      "db.auth({ user: 'root', mechanism: 'SCRAM-SHA-256' })",
      ''
    ])
      expect(maskMongoSecrets(text), text).toBe(text)
  })

  it('tests key names like the shell writes them', () => {
    for (const key of ['pwd', 'newPassword', 'auth.password', 'smtp-password', 'clientSecret'])
      expect(isMongoSecretKey(key), key).toBe(true)
    for (const key of ['passwordDigestor', 'tokenization', 'accessKeyId', 'user', 'tokens'])
      expect(isMongoSecretKey(key), key).toBe(false)
  })

  it('is linear on long runs and deep nesting', () => {
    const K = 128 * 1024
    const elapsed = (fn: () => void): number => {
      const t0 = performance.now()
      fn()
      return performance.now() - t0
    }
    for (const run of ['a.', 'a-']) {
      const text = `connect('mongodb://u:pw@h/db') ${run.repeat(K)}`
      maskMongoSecrets(text) // warm up
      expect(
        elapsed(() => maskMongoSecrets(text)),
        run
      ).toBeLessThan(100)
      expect(maskMongoSecrets(text)).toContain('mongodb://u:***@h/db')
    }
    for (const text of [
      'db.auth('.repeat(30_000),
      `{ pwd: ${"'a' + ".repeat(40_000)}'x' }`,
      "// pwd: 'x'\n".repeat(20_000),
      '([{'.repeat(40_000)
    ]) {
      maskMongoSecrets(text)
      expect(
        elapsed(() => maskMongoSecrets(text)),
        text.slice(0, 20)
      ).toBeLessThan(250)
    }
  })
})
