// Crops a Lottie JSON composition to a rectangle and packs it as a dotLottie
// file for the pet registry.
//
//   node scripts/crop-lottie.mjs <source.json> <out.lottie> <id> <x> <y> <width> <height>
//
// The crop rectangle is in source composition coordinates. Every root layer is
// shifted so the rectangle's top-left corner becomes the new origin, and the
// composition size is set to the rectangle's size. Layers are never dropped:
// anything outside the rectangle is simply clipped by the composition bounds.
import { readFileSync, writeFileSync } from 'node:fs'
import { crc32, deflateRawSync } from 'node:zlib'

const [source, output, id, ...rect] = process.argv.slice(2)
if (!source || !output || !id || rect.length !== 4) {
  console.error(
    'usage: node scripts/crop-lottie.mjs <source.json> <out.lottie> <id> <x> <y> <width> <height>'
  )
  process.exit(1)
}

const [x, y, width, height] = rect.map(Number)
const animation = JSON.parse(readFileSync(source, 'utf8'))

function shiftPosition(position) {
  if (position.s) {
    // Split position: one animatable property per axis.
    shiftScalar(position.x, x)
    shiftScalar(position.y, y)
    return
  }
  if (position.a) {
    for (const keyframe of position.k) {
      if (keyframe.s) keyframe.s = [keyframe.s[0] - x, keyframe.s[1] - y, ...keyframe.s.slice(2)]
      if (keyframe.e) keyframe.e = [keyframe.e[0] - x, keyframe.e[1] - y, ...keyframe.e.slice(2)]
    }
    return
  }
  position.k = [position.k[0] - x, position.k[1] - y, ...position.k.slice(2)]
}

function shiftScalar(property, delta) {
  if (property.a) {
    for (const keyframe of property.k) {
      if (keyframe.s) keyframe.s = keyframe.s.map((value) => value - delta)
      if (keyframe.e) keyframe.e = keyframe.e.map((value) => value - delta)
    }
    return
  }
  property.k -= delta
}

for (const layer of animation.layers) {
  if (layer.parent === undefined || layer.parent === null) shiftPosition(layer.ks.p)
}
animation.w = width
animation.h = height

const manifest = {
  animations: [{ id, mode: 'normal', direction: 1 }],
  author: 'Tedooo OS',
  generator: 'crop-lottie.mjs',
  version: '1.0'
}

writeFileSync(
  output,
  zip([
    ['manifest.json', Buffer.from(JSON.stringify(manifest))],
    [`animations/${id}.json`, Buffer.from(JSON.stringify(animation))]
  ])
)
console.log(`${output}: ${width}x${height} from (${x}, ${y})`)

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
