import { describe, expect, it } from 'vitest'
import { crc32, readZip, writeZip } from './zip'

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('reads back what it writes', async () => {
    const image = new Uint8Array(1000).map((_, i) => (i * 7) & 0xff)
    const zip = await writeZip([
      { name: 'project.json', data: new Blob(['{"a":1}']) },
      { name: 'assets/素材.png', data: new Blob([image]) },
    ])
    const files = await readZip(zip)
    expect([...files.keys()]).toEqual(['project.json', 'assets/素材.png'])
    expect(await (await files.get('project.json')!()).text()).toBe('{"a":1}')
    expect(new Uint8Array(await (await files.get('assets/素材.png')!()).arrayBuffer())).toEqual(image)
  })
})
