import { expect, test } from 'claude-code/testing'

import { layoutGraph } from './view'

// M merges B and C, both children of D:   M
//                                         |\
//                                         B C
//                                         |/
//                                         D
const commits = [
  { hash: 'M', parents: ['B', 'C'] },
  { hash: 'B', parents: ['D'] },
  { hash: 'C', parents: ['D'] },
  { hash: 'D', parents: [] },
]

test('the graph puts a merged branch on its own lane and joins it back', () => {
  const g = layoutGraph(commits)
  expect(g.rows.map((r: any) => r.idx)).toEqual([0, 0, 1, 0])
  expect(g.rows.map((r: any) => r.merge)).toEqual([true, false, false, false])
  // M: two lines leave downwards, one to lane 0 and one to lane 1
  expect(g.rows[0].segs.filter((s: any) => s.y1 === 0.5).map((s: any) => s.x2).sort()).toEqual([0, 1])
  // C (lane 1) draws a curve back to D's lane 0
  expect(g.rows[2].segs.some((s: any) => s.x1 === 1 && s.x2 === 0 && s.curve)).toBe(true)
  // D is reached from above by its lane
  expect(g.rows[3].segs.some((s: any) => s.y1 === 0 && s.x2 === 0)).toBe(true)
})

test('a straight history stays on one lane', () => {
  const g = layoutGraph([{ hash: 'c', parents: ['b'] }, { hash: 'b', parents: ['a'] }, { hash: 'a', parents: [] }])
  expect(g.rows.map((r: any) => r.idx)).toEqual([0, 0, 0])
  expect(g.width).toBe(20)
})
