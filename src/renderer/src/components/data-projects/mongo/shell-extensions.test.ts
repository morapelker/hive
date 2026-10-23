// Shell tab editor helpers: parse-error diagnostics per statement (positioned in the document)
// and the ⌘↵ statement range.
import { describe, expect, it } from 'vitest'
import { mongoShellDiagnostics, mongoStatementRange } from './shell-extensions'

describe('mongoShellDiagnostics', () => {
  it('accepts supported statements', () => {
    expect(
      mongoShellDiagnostics(
        "use shop\ndb.orders.find({ status: 'A' }).sort({ at: -1 })\nshow collections"
      )
    ).toEqual([])
  })

  it('underlines what the shell cannot run, inside the right statement', () => {
    const doc = 'db.orders.find({})\ndb.orders.forEach(d => print(d))'
    const diagnostics = mongoShellDiagnostics(doc)
    expect(diagnostics).toHaveLength(1)
    const [d] = diagnostics
    expect(d.severity).toBe('error')
    expect(d.from).toBeGreaterThanOrEqual(doc.indexOf('\n') + 1)
    expect(d.to).toBeGreaterThan(d.from)
    expect(d.to).toBeLessThanOrEqual(doc.length)
    expect(d.message.length).toBeGreaterThan(0)
  })

  it('reports syntax errors', () => {
    expect(mongoShellDiagnostics('db.orders.find({ a: 1 ')).toHaveLength(1)
    expect(mongoShellDiagnostics("db.orders.find({ a: require('fs') })")).toHaveLength(1)
  })
})

describe('mongoStatementRange', () => {
  it('returns the statement under the cursor', () => {
    const doc = 'db.a.find()\n\ndb.b.find()\n  .limit(1)'
    expect(mongoStatementRange(doc, 3)).toEqual({ from: 0, to: 11 })
    const second = doc.indexOf('db.b')
    expect(mongoStatementRange(doc, doc.length)).toEqual({ from: second, to: doc.length })
    expect(mongoStatementRange(doc, 12)).toBeNull()
  })
})
