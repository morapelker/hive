// Rebuild the four cumulative variants from the untouched, checked-in corgi.
// Run: node apps/hive/scripts/generate-corgi-variants.mjs
// All additions are native Lottie vectors, parented to the original character rig.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

const assetDir = new URL('../src/renderer/src/pet/registry/corgi/assets/', import.meta.url)
const digits = JSON.parse(readFileSync(new URL('../digit-glyphs.json', assetDir), 'utf8'))
const source = readFileSync(new URL('corgi-anim.lottie', assetDir))
const entries = unzip(source)
const original = JSON.parse(entries.find(([name]) => name.startsWith('animations/'))[1])
const still = (k) => ({ a: 0, k })
const color = (hex) => [...hex.match(/\w\w/g).map((part) => parseInt(part, 16) / 255), 1]
const palette = {
  fur: 'ff7d38',
  furShade: 'e96529',
  cream: 'f9e6b7',
  gold: 'ffc847',
  goldShade: 'df922b',
  goldLight: 'ffeaa0',
  red: 'e74750',
  redShade: 'b52d46',
  redLight: 'ff7273',
  jewel: '2baba4'
}

function transform(p = [0, 0, 0]) {
  return { o: still(100), r: still(0), p: still(p), a: still([0, 0, 0]), s: still([100, 100, 100]) }
}

function keyframes(values, times = [0, 22.5, 45, 67.5, 90]) {
  return {
    a: 1,
    k: values.map((value, index) => ({
      t: times[index],
      s: Array.isArray(value) ? value : [value],
      ...(index < values.length - 1 ? { i: { x: 0.667, y: 1 }, o: { x: 0.333, y: 0 } } : {})
    }))
  }
}

// A node is [x, y, incoming dx, incoming dy, outgoing dx, outgoing dy].
function bezier(nodes, closed = true) {
  return {
    v: nodes.map(([x, y]) => [x, y]),
    i: nodes.map((node) => [node[2] ?? 0, node[3] ?? 0]),
    o: nodes.map((node) => [node[4] ?? 0, node[5] ?? 0]),
    c: closed
  }
}

function shape(name, nodes, hex, { morph, stroke, width = 3, closed = true } = {}) {
  const paths = morph ? morph.map((frame) => bezier(frame, closed)) : null
  const ks = paths ? keyframes(paths.map((path) => [path])) : still(bezier(nodes, closed))
  return {
    ty: 'gr',
    nm: name,
    it: [
      { ty: 'sh', nm: name, ks },
      ...(hex ? [{ ty: 'fl', c: still(color(hex)), o: still(100), r: 1 }] : []),
      ...(stroke
        ? [{ ty: 'st', c: still(color(stroke)), o: still(100), w: still(width), lc: 2, lj: 2 }]
        : []),
      { ty: 'tr', ...transform([0, 0]) }
    ]
  }
}

function ellipse(name, p, size, hex) {
  return {
    ty: 'gr',
    nm: name,
    it: [
      { ty: 'el', p: still(p), s: still(size) },
      { ty: 'fl', c: still(color(hex)), o: still(100), r: 1 },
      { ty: 'tr', ...transform([0, 0]) }
    ]
  }
}

function layer(ind, name, parent, p, shapes) {
  return {
    ddd: 0,
    ind,
    ty: 4,
    nm: name,
    parent,
    sr: 1,
    ks: transform(p),
    ao: 0,
    shapes,
    ip: 0,
    op: 90.000004,
    st: 0,
    bm: 0
  }
}

function addTail(rig) {
  const tail = rig.layers.find((item) => item.ind === 9)
  tail.nm = 'Long tail · wagging cream tip'
  tail.ks.a = still([0, 0, 0])
  tail.ks.r = keyframes([-5, 9, -5, 9, -5])
  const silhouette = [
    [-12, 9, 0, 18, 42, -2],
    [102, -10, -42, 22, 58, -30],
    [229, -133, -3, 45, 12, 28],
    [213, -42, 20, -20, -40, 52],
    [94, 42, 56, -6, -44, 4],
    [0, 39, 28, 6, -10, -2]
  ]
  tail.shapes = [
    shape(
      'Cream brush tip',
      [
        [147, -49, 27, -17, 39, -33],
        [229, -133, -3, 45, 12, 28],
        [213, -42, 20, -20, -12, 16],
        [182, -11],
        [187, -35],
        [163, -19],
        [171, -45],
        [149, -31]
      ],
      palette.cream
    ),
    shape(
      'Soft underside',
      [
        [-2, 23, 0, 0, 52, 6],
        [124, 14, -38, 15, 48, -20],
        [218, -56, -20, 24, -35, 52],
        [94, 42, 56, -6, -44, 4],
        [0, 39]
      ],
      palette.furShade
    ),
    shape('Long tail silhouette', silhouette, palette.fur)
  ]
}

function addCrown(rig) {
  const crown = layer(
    20,
    'Crown · follows head',
    5,
    [180, 24, 0],
    [
      ellipse('Jewel highlight', [0, -15], [6, 7], 'e8fff8'),
      shape(
        'Teal jewel',
        [
          [0, -29],
          [10, -16],
          [0, -3],
          [-10, -16]
        ],
        palette.jewel
      ),
      shape(
        'Crown rim highlight',
        [
          [-51, -4],
          [48, -4]
        ],
        null,
        { stroke: palette.goldLight, width: 5, closed: false }
      ),
      shape(
        'Crown band',
        [
          [-55, -19],
          [53, -19],
          [48, 8, 0, 0, -27, 6],
          [-50, 8, 28, 6]
        ],
        palette.goldShade
      ),
      shape(
        'Crown light',
        [
          [-59, -68],
          [-28, -39],
          [0, -88],
          [0, -17],
          [-52, -17]
        ],
        palette.goldLight
      ),
      shape(
        'Three point crown',
        [
          [-59, -68],
          [-28, -39],
          [0, -88],
          [29, -39],
          [61, -68],
          [53, -17, 0, 0, -24, 5],
          [-52, -17, 24, 5]
        ],
        palette.gold
      ),
      ...[
        [-59, -68],
        [0, -88],
        [61, -68]
      ].map((p) => ellipse('Crown pearl', p, [12, 12], palette.gold))
    ]
  )
  crown.ks.s = still([120, 120, 100])
  crown.ks.r = keyframes([-5, -2, -5, -2, -5])
  rig.layers.unshift(crown)
}

function addCape(rig, superCorgi) {
  // The shoulder stays fixed; only the cloth's trailing control points flutter.
  const cloth = (wave) => [
    [0, 0, 0, 0, 76, -29],
    [154, -70 + wave, -65, -14, 82, 20],
    [415, -155 - wave, -70, 60, -24, 38],
    [373, 24 + wave, 2, -52, -69, 12],
    [167, 54 - wave, 71, 24, -70, -24],
    [5, 34, 44, 10, -8, -10]
  ]
  const fold = (wave) => [
    [5, 22, 0, 0, 91, -1],
    [179, -5 + wave, -60, -15, 50, 20],
    [391, -77 - wave, -38, 34, -10, 29],
    [373, 24 + wave, 2, -52, -69, 12],
    [167, 54 - wave, 71, 24, -70, -24],
    [5, 34]
  ]
  const sheen = (wave) => [
    [12, 2, 0, 0, 80, -14],
    [157, -56 + wave, -60, -15, 82, 20],
    [380, -124 - wave, -48, 32, -56, 12],
    [169, -35 + wave, 66, 18, -76, -15],
    [12, 10]
  ]
  const waves = [0, 18, 0, -16, 0]
  const cape = layer(
    21,
    'Cape · rippling cloth',
    10,
    [140, 37, 0],
    [
      shape('Cloth highlight', null, palette.redLight, { morph: waves.map(sheen) }),
      shape('Cloth underside', null, palette.redShade, { morph: waves.map(fold) }),
      shape('Red cape', null, palette.red, { morph: waves.map(cloth) })
    ]
  )
  rig.layers.splice(
    rig.layers.findIndex((item) => item.ind === 7),
    0,
    cape
  )
  const clasp = layer(
    22,
    'Cape · gold shoulder clasp',
    10,
    [141, 64, 0],
    [
      ellipse('Clasp shine', [-3, -4], [7, 7], palette.goldLight),
      ellipse('Clasp', [0, 0], [28, 28], palette.gold),
      ellipse('Clasp setting', [0, 2], [36, 36], palette.redShade)
    ]
  )
  rig.layers.splice(
    rig.layers.findIndex((item) => item.ind === 8),
    0,
    clasp
  )
  if (superCorgi) {
    const counter = layer(23, 'Super corgi · editable session count', 21, [231, 24, 0], [])
    counter.ty = 5
    delete counter.shapes
    counter.t = {
      a: [],
      m: { g: 1, a: still([0, 0]) },
      d: {
        sid: 'session-count',
        k: [
          {
            t: 0,
            s: {
              t: '5',
              f: 'Geist-ExtraBold',
              s: 90,
              j: 2,
              tr: 0,
              lh: 108,
              fc: color(palette.goldLight).slice(0, 3)
            }
          }
        ]
      }
    }
    // A little cloth-following motion keeps the lettering seated in the cape.
    counter.ks.p = keyframes([
      [231, 24, 0],
      [231, 28, 0],
      [231, 24, 0],
      [231, 20, 0],
      [231, 24, 0]
    ])
    rig.layers.splice(rig.layers.indexOf(cape), 0, counter)
  }
}

function addTrail(rig) {
  const positions = [
    [690, -42],
    [773, 16],
    [704, 100],
    [589, -127]
  ]
  for (const [index, [x, y]] of positions.entries()) {
    const size = index % 2 ? 16 : 23
    const sparkle = layer(
      30 + index,
      'Super corgi · golden sparkle ' + (index + 1),
      10,
      [x, y, 0],
      [
        shape(
          'Four point sparkle',
          [
            [0, -size],
            [size * 0.28, -size * 0.28],
            [size, 0],
            [size * 0.28, size * 0.28],
            [0, size],
            [-size * 0.28, size * 0.28],
            [-size, 0],
            [-size * 0.28, -size * 0.28]
          ],
          palette.gold
        )
      ]
    )
    const pulse = index % 2 ? [40, 100, 40, 100, 40] : [100, 40, 100, 40, 100]
    sparkle.ks.s = keyframes(pulse.map((s) => [s, s, 100]))
    sparkle.ks.o = keyframes(pulse.map((s) => 50 + s * 0.5))
    sparkle.ks.p = keyframes([
      [x, y, 0],
      [x + 12, y - 9, 0],
      [x, y, 0],
      [x - 10, y + 7, 0],
      [x, y, 0]
    ])
    rig.layers.push(sparkle)
  }
}

for (let level = 2; level <= 5; level++) {
  const animation = structuredClone(original)
  const rig = animation.assets.find((asset) => asset.id === 'comp_0')
  if (!rig || !rig.layers.some((item) => item.ind === 9 && item.nm === 'duoi Outlines')) {
    throw new Error('The original corgi rig changed; check attachment points before regenerating.')
  }
  animation.nm = `Corgi · ${level} active sessions`
  addTail(rig)
  if (level >= 3) addCrown(rig)
  if (level >= 4) addCape(rig, level === 5)
  if (level >= 5) {
    addTrail(rig)
    animation.fonts = digits.fonts
    animation.chars = structuredClone(digits.chars)
    for (const glyph of animation.chars)
      glyph.data.shapes[0].it.push({ ty: 'tr', ...transform([0, 0]) })
    animation.slots = {
      'session-count': { p: { k: rig.layers.find((item) => item.ind === 23).t.d.k } }
    }
  }
  const id = `corgi-level-${level}`
  const manifest = {
    version: '1.0',
    generator: 'generate-corgi-variants.mjs',
    author: 'Tedooo Code',
    animations: [{ id, loop: true, speed: 1 }]
  }
  const output = new URL(`${id}.lottie`, assetDir)
  writeFileSync(
    output,
    zip([
      ['manifest.json', Buffer.from(JSON.stringify(manifest))],
      [`animations/${id}.json`, Buffer.from(JSON.stringify(animation))]
    ])
  )
  console.log(fileURLToPath(output))
}

// The source archive uses ordinary deflate entries with no data descriptors.
function unzip(buffer) {
  const result = []
  let offset = 0
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8)
    const size = buffer.readUInt32LE(offset + 18)
    const nameSize = buffer.readUInt16LE(offset + 26)
    const extraSize = buffer.readUInt16LE(offset + 28)
    const name = buffer.subarray(offset + 30, offset + 30 + nameSize).toString()
    const start = offset + 30 + nameSize + extraSize
    const data = buffer.subarray(start, start + size)
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP method: ${method}`)
    result.push([name, method === 8 ? inflateRawSync(data) : data])
    offset = start + size
  }
  return result
}

// Minimal ZIP writer (deflate, no extra fields), enough for dotLottie players.
function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, data] of entries) {
    const nameBuffer = Buffer.from(name)
    const compressed = deflateRawSync(data)
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuffer, compressed)
    centrals.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + compressed.length
  }
  const centralSize = centrals.reduce((sum, buffer) => sum + buffer.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, ...centrals, end])
}
