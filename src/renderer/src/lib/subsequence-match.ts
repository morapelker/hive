export interface SubsequenceMatch {
  matched: boolean
  indices: number[]
  score: number // lower is better (sum of gaps between consecutive matches)
}

export function subsequenceMatch(query: string, target: string): SubsequenceMatch {
  if (query.length === 0) return { matched: true, indices: [], score: 0 }

  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const indices: number[] = []
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti)
      qi++
    }
  }
  if (qi < q.length) return { matched: false, indices: [], score: Infinity }
  let score = 0
  for (let i = 1; i < indices.length; i++) {
    score += indices[i] - indices[i - 1] - 1
  }
  return { matched: true, indices, score }
}
