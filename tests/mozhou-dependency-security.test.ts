import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const expressRequire = createRequire(require.resolve('express'))
const epubRequire = createRequire(require.resolve('epub2'))
const rateLimitRequire = createRequire(require.resolve('express-rate-limit'))

describe('墨舟安全补丁的真实依赖消费路径', () => {
  it('Express 的代理子网不把短 IPv4-mapped IPv6 前缀误作信任所有 IPv4', () => {
    const proxyaddr = expressRequire('proxy-addr') as { compile: (subnet: string) => (address: string) => boolean }
    expect(proxyaddr.compile('::ffff:10.0.0.0/8')('203.0.113.7')).toBe(false)
    expect(proxyaddr.compile('10.0.0.0/8')('10.2.3.4')).toBe(true)
    expect(proxyaddr.compile('10.0.0.0/8')('203.0.113.7')).toBe(false)
  })

  it('EPUB 解析使用升级后的 ZIP 实现，正文和章尾无损往返', () => {
    const AdmZip = epubRequire('adm-zip') as new (input?: Buffer) => { addFile: (name: string, data: Buffer) => void; toBuffer: () => Buffer; readAsText: (name: string) => string }
    expect(epubRequire('adm-zip/package.json').version).toBe('0.6.1')
    const body = '桥下的水带走一枚铜钥匙。\nThe ending stays intact. & < >'
    const zip = new AdmZip(); zip.addFile('chapter.xhtml', Buffer.from(body))
    expect(new AdmZip(zip.toBuffer()).readAsText('chapter.xhtml')).toBe(body)
  })

  it('限流器的 IP 库按完整 fe80::/10 判断链路本地地址', () => {
    const { Address6 } = rateLimitRequire('ip-address') as { Address6: new (value: string) => { isLinkLocal: () => boolean } }
    expect(new Address6('febf::1').isLinkLocal()).toBe(true)
    expect(new Address6('2001:db8::1').isLinkLocal()).toBe(false)
  })
})
