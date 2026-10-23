// maskMongoSecrets (the shared masker, re-exported for the Mongo workspace's persistence):
// password-like keys in any quoting, positional passwords of changeUserPassword / auth,
// credentials in connection strings, half-typed passwords, commented-out credentials, and what
// must stay untouched (passwordDigestor, non-string values, a quote inside a comment).
import { describe, expect, it } from 'vitest'
import { maskMongoSecrets } from './mask'

describe('maskMongoSecrets', () => {
  it('masks password keys whatever the key or value quoting', () => {
    expect(maskMongoSecrets('db.createUser({ user: "app", pwd: "S3cret!", roles: [] })')).toBe(
      'db.createUser({ user: "app", pwd: "***", roles: [] })'
    )
    expect(maskMongoSecrets(`db.runCommand({ createUser: 'u', "pwd": 'a\\'b', roles: [] })`)).toBe(
      `db.runCommand({ createUser: 'u', "pwd": '***', roles: [] })`
    )
    expect(maskMongoSecrets("db.updateUser('u', { 'password': `tpl` })")).toBe(
      "db.updateUser('u', { 'password': `***` })"
    )
    expect(maskMongoSecrets("{ newPassword: 'n1', clientSecret: 'c1', apiKey: 'k1' }")).toBe(
      "{ newPassword: '***', clientSecret: '***', apiKey: '***' }"
    )
    expect(maskMongoSecrets("{ kms: { aws: { accessKeyId: 'AK', secretAccessKey: 'SK' } } }")).toBe(
      "{ kms: { aws: { accessKeyId: 'AK', secretAccessKey: '***' } } }"
    )
  })

  it('masks positional passwords and connection-string credentials', () => {
    expect(maskMongoSecrets("db.changeUserPassword('app', 'n3w')")).toBe(
      "db.changeUserPassword('app', '***')"
    )
    expect(maskMongoSecrets("db.getSiblingDB('admin').auth('root', \"pw\")")).toBe(
      "db.getSiblingDB('admin').auth('root', \"***\")"
    )
    expect(maskMongoSecrets("db.auth({ user: 'root', pwd: 'pw' })")).toBe(
      "db.auth({ user: 'root', pwd: '***' })"
    )
    expect(maskMongoSecrets("connect('mongodb+srv://app:Pa55@c0.mongodb.net/shop')")).toBe(
      "connect('mongodb+srv://app:***@c0.mongodb.net/shop')"
    )
  })

  it('masks a half-typed password (unterminated string)', () => {
    expect(maskMongoSecrets("db.createUser({ user: 'u', pwd: 'Sup3rSe")).toBe(
      "db.createUser({ user: 'u', pwd: '***'"
    )
  })

  it('leaves non-secrets alone', () => {
    const text = [
      "db.createUser({ user: 'u', pwd: passwordPrompt(), passwordDigestor: 'server' })",
      "db.users.find({ password: { $exists: true } }) // isn't a value",
      "db.users.find({ note: 'pwd: x' })"
    ].join('\n')
    expect(maskMongoSecrets(text)).toBe(text)
    expect(maskMongoSecrets('')).toBe('')
  })

  it('masks a commented-out credential, and dotted keys of $set', () => {
    expect(maskMongoSecrets("db.users.find({}) // pwd: 'S3cret'")).toBe(
      "db.users.find({}) // pwd: '***'"
    )
    expect(maskMongoSecrets("db.u.updateOne({}, { $set: { 'auth.password': 'S3cret' } })")).toBe(
      "db.u.updateOne({}, { $set: { 'auth.password': '***' } })"
    )
  })
})
