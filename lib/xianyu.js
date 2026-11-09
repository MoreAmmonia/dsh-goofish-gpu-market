/**
 * 闲鱼（goofish.com）MTOP 客户端。
 *
 * 闲鱼的网页接口要求登录状态：请求头里必须带浏览器登录后的 Cookie。
 * 本模块不保存、不上传 Cookie，只从插件配置 / 环境变量 / 本地文件读取，
 * 并负责刷新 `_m_h5_tk` 令牌、计算 MTOP 签名、解析搜索结果与商品详情。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const APP_KEY = '34839810'
const BASE = 'https://h5api.m.goofish.com/h5/'
const SEARCH_API = 'mtop.taobao.idlemtopsearch.pc.search'
const DETAIL_API = 'mtop.taobao.idle.pc.detail'
const REQUEST_TIMEOUT_MS = 20000

/**
 * 搜索结果卡片缓存：详情接口被闲鱼风控拦截时，用它回退。
 * 只保存在当前进程内，不写磁盘，重启即清空。
 */
const recentCards = new Map()
const RECENT_CARDS_LIMIT = 300

function rememberCard(item) {
  if (!item || !item.id) return
  recentCards.delete(item.id)
  recentCards.set(item.id, item)
  if (recentCards.size > RECENT_CARDS_LIMIT) {
    const oldest = recentCards.keys().next().value
    recentCards.delete(oldest)
  }
}

export function cachedItem(id) {
  return recentCards.get(String(id || '')) || null
}

export class XianyuError extends Error {
  constructor(message, code = 'XIANYU_ERROR') {
    super(message)
    this.name = 'XianyuError'
    this.code = code
  }
}

/** 默认 Cookie 文件：$DSH_HOME/xianyu-cookie.txt，未设置 DSH_HOME 时用 ~/.dsh。 */
export function cookieFilePath(config = {}) {
  if (typeof config.cookieFile === 'string' && config.cookieFile.trim()) {
    return expandHome(config.cookieFile.trim())
  }
  if (process.env.XIANYU_COOKIE_FILE) return expandHome(process.env.XIANYU_COOKIE_FILE)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'xianyu-cookie.txt')
}

function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

/**
 * 读取闲鱼 Cookie。优先级：config.cookie / XIANYU_COOKIE > Cookie 文件。
 * 支持从 DevTools 直接粘贴的 `Cookie: a=b; c=d` 请求头，也支持每行一个 `a=b`。
 */
export async function loadCookie(config = {}) {
  const inline =
    (typeof config.cookie === 'string' && config.cookie.trim()) ||
    (process.env.XIANYU_COOKIE || '').trim()
  if (inline) {
    const header = normalizeCookieHeader(inline)
    if (header) return { header, source: 'config/env' }
  }

  const file = cookieFilePath(config)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { header: '', source: file, missing: true }
    }
    throw new XianyuError(`读取闲鱼 Cookie 文件失败：${file}（${error.message}）`, 'COOKIE_IO')
  }
  const header = normalizeCookieHeader(text)
  if (!header) {
    return { header: '', source: file, missing: true, empty: true }
  }
  return { header, source: file }
}

function normalizeCookieHeader(raw) {
  let text = String(raw || '').trim()
  if (!text) return ''
  text = text.replace(/^cookie\s*:\s*/i, '')
  const pairs = new Map()
  for (const segment of text.split(/[;\r\n]+/)) {
    const item = segment.trim()
    if (!item || item.startsWith('#')) continue
    const eq = item.indexOf('=')
    if (eq <= 0) continue
    const key = item.slice(0, eq).trim()
    const value = item.slice(eq + 1).trim()
    if (!key) continue
    pairs.set(key, value)
  }
  return [...pairs].map(([key, value]) => `${key}=${value}`).join('; ')
}

class CookieJar {
  constructor(header) {
    this.map = new Map()
    if (header) {
      for (const segment of header.split(';')) {
        const item = segment.trim()
        const eq = item.indexOf('=')
        if (eq > 0) this.map.set(item.slice(0, eq).trim(), item.slice(eq + 1).trim())
      }
    }
  }

  get(name) {
    return this.map.get(name)
  }

  absorb(response) {
    let cookies = []
    try {
      cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : []
    } catch {
      cookies = []
    }
    for (const line of cookies) {
      const pair = String(line).split(';')[0]
      const eq = pair.indexOf('=')
      if (eq > 0) this.map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
    return cookies.length > 0
  }

  header() {
    return [...this.map].map(([key, value]) => `${key}=${value}`).join('; ')
  }
}

function md5(value) {
  return createHash('md5').update(value, 'utf8').digest('hex')
}

function retCode(json) {
  const ret = json && json.ret
  if (Array.isArray(ret) && ret.length > 0) return String(ret[0])
  if (typeof ret === 'string') return ret
  return ''
}

function needsToken(code) {
  return (
    /TOKEN_EMPTY|TOKEN_EXOIRED|TOKEN_EXPIRED|令牌为空|令牌过期/i.test(code) ||
    /令牌为空|令牌过期/.test(code)
  )
}

function authMessage(config, detail) {
  const file = cookieFilePath(config)
  return [
    '闲鱼接口需要登录 Cookie，当前 Cookie 缺失或已失效。',
    `请把浏览器中 goofish.com 的请求 Cookie 写入文件：${file}`,
    '文件内容可以是一行 `key=value; key2=value2`，也可以直接粘贴 DevTools 里的 `Cookie:` 请求头。',
    '获取方法：在浏览器登录 goofish.com → F12 → Network → 任选一个请求 → 复制 Request Headers 里的 Cookie。',
    '也可以在插件配置中设置 cookie（内联）或 cookieFile（路径），或设置环境变量 XIANYU_COOKIE。',
    detail ? `接口返回：${detail}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function classify(code, json, config) {
  if (/USER_VALIDATE/i.test(code)) {
    return new XianyuError(
      '闲鱼详情接口触发了人机验证（FAIL_SYS_USER_VALIDATE）。可以稍后重试，或先在浏览器打开商品链接完成验证；搜索接口不受影响。',
      'XIANYU_VALIDATE',
    )
  }
  if (/RGV587|SESSION_EXPIRED|SID_INVALID|need_login/i.test(code)) {
    return new XianyuError(authMessage(config, code), 'XIANYU_AUTH')
  }
  if (/FAIL_SYS_API_NOT_FOUNDED/i.test(code)) {
    return new XianyuError(`闲鱼接口不存在或已变更：${code}`, 'XIANYU_API')
  }
  const message = json && json.message ? `：${json.message}` : ''
  return new XianyuError(`闲鱼接口返回错误：${code || '未知错误'}${message}`, 'XIANYU_API')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function mtop(api, data, config, signal) {
  const jar = config.__cookieJar || new CookieJar('')
  const body = JSON.stringify(data)
  let lastNetworkError

  for (let networkAttempt = 0; networkAttempt < 2; networkAttempt += 1) {
    for (let tokenAttempt = 0; tokenAttempt < 3; tokenAttempt += 1) {
      const t = Date.now().toString()
      const params = new URLSearchParams({
        jsv: '2.7.2',
        appKey: APP_KEY,
        t,
        v: '1.0',
        type: 'originaljson',
        accountSite: 'xianyu',
        dataType: 'json',
        timeout: '20000',
        api,
        sessionOption: 'AutoLoginOnly',
        spm_cnt: 'a21ybx.search.0.0',
      })
      const token = (jar.get('_m_h5_tk') || '').split('_')[0]
      if (token) params.set('sign', md5(`${token}&${t}&${APP_KEY}&${body}`))

      const url = `${BASE}${api}/1.0/?${params.toString()}`
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

      let response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'user-agent': UA,
            accept: 'application/json',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            origin: 'https://www.goofish.com',
            referer: 'https://www.goofish.com/',
            cookie: jar.header(),
          },
          body: new URLSearchParams({ data: body }).toString(),
          signal: requestSignal,
        })
      } catch (error) {
        lastNetworkError = error
        if (signal && signal.aborted) throw new XianyuError('闲鱼请求已取消', 'XIANYU_ABORTED')
        if (error && error.name === 'TimeoutError') {
          throw new XianyuError('闲鱼请求超时（20 秒）', 'XIANYU_TIMEOUT')
        }
        break
      }

      const gained = jar.absorb(response)
      const text = await response.text()
      let json
      try {
        json = JSON.parse(text)
      } catch {
        if (!response.ok) {
          throw new XianyuError(`闲鱼接口 HTTP ${response.status}`, 'XIANYU_HTTP')
        }
        throw new XianyuError('闲鱼接口返回了无法解析的内容', 'XIANYU_PARSE')
      }

      const code = retCode(json)
      if (needsToken(code) && (gained || jar.get('_m_h5_tk')) && tokenAttempt < 2) {
        await sleep(150)
        continue
      }
      if (!/^SUCCESS/i.test(code)) throw classify(code, json, config)
      return json
    }

    if (lastNetworkError) {
      if (networkAttempt === 0) {
        await sleep(400)
        continue
      }
      throw new XianyuError(
        `连接闲鱼失败：${lastNetworkError.message || lastNetworkError}`,
        'XIANYU_NETWORK',
      )
    }
  }
  throw new XianyuError('闲鱼请求失败', 'XIANYU_NETWORK')
}

export async function openSession(config = {}) {
  const loaded = await loadCookie(config)
  return {
    ...config,
    __cookieJar: new CookieJar(loaded.header),
    __cookieSource: loaded.source,
    __cookieMissing: Boolean(loaded.missing),
  }
}

function textOf(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.value === 'string' || typeof value.value === 'number') {
      return String(value.value)
    }
  }
  return ''
}

export function parsePrice(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = textOf(value).replace(/[,，\s]/g, '')
  if (!text) return null
  if (/面议|免费|咨询/.test(text)) return 0
  const match = text.match(/(\d+(?:\.\d+)?)(万)?/)
  if (!match) return null
  let price = Number(match[1])
  if (!Number.isFinite(price)) return null
  if (match[2]) price *= 10000
  return Math.round(price * 100) / 100
}

function itemIdOf(value) {
  const text = String(value || '').trim()
  const fromUrl = text.match(/[?&]id=(\d+)/) || text.match(/\/item\/(\d+)/)
  if (fromUrl) return fromUrl[1]
  const digits = text.match(/^\d{6,}$/)
  return digits ? digits[0] : text
}

function parseTimestamp(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return number > 1e12 ? number : number * 1000
}

export function formatDateTime(value) {
  const ms = parseTimestamp(value)
  if (!ms) return ''
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString()
  }
}

const TAG_ALIASES = {
  freeShippingIcon: '包邮',
  sevenIcon: '7天无理由',
}

/** 把搜索结果 fishTags 里的 r1-r5 标签压成可读文本，跳过纯图标名。 */
function searchTags(groups) {
  if (!groups || typeof groups !== 'object') return []
  const tags = []
  for (const key of ['r1', 'r2', 'r3', 'r4', 'r5']) {
    const list = groups[key] && groups[key].tagList
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const content = entry && entry.data && entry.data.content
      if (typeof content !== 'string' || !content) continue
      const text = TAG_ALIASES[content] || (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(content) ? '' : content)
      if (text && !tags.includes(text)) tags.push(text)
      if (tags.length >= 8) return tags
    }
  }
  return tags
}

function normalizeSearchItem(entry) {
  const main = entry && entry.data && entry.data.item && entry.data.item.main
  const content = (main && main.exContent) || {}
  const args = (main && main.clickParam && main.clickParam.args) || {}
  const id = String(content.itemId || args.item_id || '')
  const priceText = textOf(content.price).trim()
  const tags = searchTags(content.fishTags)
  const wantFromTag = tags
    .map((tag) => tag.match(/^(\d+)人想要$/))
    .find((match) => match !== null)
  const want = numberOrNull(content.want)
  return {
    id,
    title: String(content.title || '').trim(),
    priceText,
    price: parsePrice(content.price),
    area: String(content.area || '').trim(),
    seller: String(content.userNickName || content.userNick || '').trim(),
    image: String(content.picUrl || '').trim(),
    tags,
    want: want !== null && want > 0 ? want : wantFromTag ? Number(wantFromTag[1]) : null,
    publishTime: parseTimestamp(args.publishTime || args.publish_time || content.publishTime),
    url: id ? `https://www.goofish.com/item?id=${id}` : '',
  }
}

export function priceStats(items) {
  const prices = items
    .map((item) => item.price)
    .filter((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
  if (prices.length === 0) return null
  const sum = prices.reduce((total, value) => total + value, 0)
  const middle = Math.floor(prices.length / 2)
  const median =
    prices.length % 2 === 0 ? (prices[middle - 1] + prices[middle]) / 2 : prices[middle]
  return {
    count: prices.length,
    min: prices[0],
    max: prices[prices.length - 1],
    average: Math.round((sum / prices.length) * 100) / 100,
    median: Math.round(median * 100) / 100,
  }
}

const SORTS = {
  relevance: {},
  price_asc: { sortField: 'price', sortValue: 'asc' },
  price_desc: { sortField: 'price', sortValue: 'desc' },
  newest: { sortField: 'create', sortValue: 'desc' },
}

/**
 * 搜索闲鱼商品。minPrice/maxPrice 在本地过滤，避免依赖不稳定的筛选参数。
 * @returns {Promise<{keyword:string,page:number,items:object[],stats:object|null,hasMore:boolean}>}
 */
export async function searchItems(keyword, options = {}, config = {}, signal) {
  const page = clampInt(options.page, 1, 50, 1)
  const limit = clampInt(options.limit, 1, 30, 15)
  const sort = Object.hasOwn(SORTS, options.sort) ? options.sort : 'relevance'
  const minPrice = toPositiveNumber(options.minPrice)
  const maxPrice = toPositiveNumber(options.maxPrice)

  const data = {
    keyword: String(keyword || '').trim(),
    pageNumber: page,
    rowsPerPage: limit,
    sortValue: '',
    sortField: '',
    searchReqFromPage: 'pcSearch',
    specialSkuIds: [],
    extraFilterValue: '{}',
    userPositionJson: '{}',
    ...SORTS[sort],
  }
  if (!data.keyword) throw new XianyuError('关键词不能为空', 'XIANYU_ARGS')

  const json = await mtop(SEARCH_API, data, config, signal)
  const rawList =
    json && json.data && Array.isArray(json.data.resultList) ? json.data.resultList : []
  const allItems = rawList.map(normalizeSearchItem).filter((item) => item.id && item.title)

  // 先缓存整页结果（含被价格筛选掉的），供详情接口被验证拦截时回退。
  for (const item of allItems) rememberCard(item)

  let items = allItems
  if (minPrice !== null) items = items.filter((item) => item.price === null || item.price >= minPrice)
  if (maxPrice !== null) items = items.filter((item) => item.price === null || item.price <= maxPrice)

  if (sort === 'price_asc' || sort === 'price_desc') {
    const direction = sort === 'price_asc' ? 1 : -1
    items.sort((a, b) => {
      if (a.price === null && b.price === null) return 0
      if (a.price === null) return 1
      if (b.price === null) return -1
      return (a.price - b.price) * direction
    })
  }

  return {
    keyword: data.keyword,
    page,
    items,
    stats: priceStats(items),
    hasMore: rawList.length >= limit,
  }
}

function cardAsDetail(card, source) {
  const tags = Array.isArray(card.tags) ? card.tags : []
  return {
    id: card.id,
    title: card.title,
    price: card.price,
    priceText: card.priceText,
    originalPrice: null,
    transportFee: null,
    transportFeeText: tags.includes('包邮') ? '包邮' : '',
    description: '',
    status: '',
    browseCount: null,
    wantCount: typeof card.want === 'number' ? card.want : null,
    collectCount: null,
    createdAt: card.publishTime || null,
    labels: tags,
    images: card.image ? [card.image] : [],
    seller: {
      nick: card.seller,
      city: card.area,
      signature: '',
      soldCount: null,
      replyRatio: '',
      registeredDays: null,
      zhimaAuth: false,
    },
    url: card.url,
    partial: true,
    partialSource: source === 'cache' ? '搜索结果缓存' : '搜索结果',
  }
}

async function fetchItemDetail(id, config, signal) {
  const json = await mtop(DETAIL_API, { itemId: id }, config, signal)
  const data = (json && json.data) || {}
  const item = data.itemDO || data.item || data.itemDto || null
  if (!item) {
    throw new XianyuError('闲鱼没有返回该商品的信息（可能已下架或删除）', 'XIANYU_NOT_FOUND')
  }
  const seller = data.sellerDO || data.seller || item.sellerDO || {}
  const images = Array.isArray(item.imageInfos)
    ? item.imageInfos.map((image) => image && (image.url || image.originalUrl)).filter(Boolean)
    : Array.isArray(item.images)
      ? item.images.map((image) => (typeof image === 'string' ? image : image && image.url)).filter(Boolean)
      : []
  const price = parsePrice(item.soldPrice ?? item.price ?? item.minPrice)
  const originalPrice = parsePrice(item.originalPrice)
  const transportFee = parsePrice(item.transportFee)
  const labels = Array.isArray(item.itemLabelExtList)
    ? item.itemLabelExtList.map((label) => label && label.text).filter(Boolean)
    : []
  const description = stripHtml(item.desc || item.richTextDesc || '')

  return {
    id: String(item.itemId || id),
    title: String(item.title || '').trim(),
    price,
    priceText: textOf(item.soldPrice ?? item.price ?? item.minPrice).trim(),
    originalPrice,
    transportFee,
    transportFeeText: textOf(item.transportFee).trim(),
    description,
    status: String(item.itemStatusStr ?? item.itemStatus ?? '').trim(),
    browseCount: numberOrNull(item.browseCnt),
    wantCount: numberOrNull(item.wantCnt),
    collectCount: numberOrNull(item.collectCnt),
    createdAt: parseTimestamp(item.gmtCreate),
    labels,
    images,
    seller: {
      nick: String(seller.nick || seller.userNick || '').trim(),
      city: String(seller.city || seller.publishCity || '').trim(),
      signature: String(seller.signature || '').trim(),
      soldCount: numberOrNull(seller.hasSoldNumInteger),
      replyRatio: String(seller.replyRatio24h || '').trim(),
      registeredDays: numberOrNull(seller.userRegDay),
      zhimaAuth: Boolean(seller.zhimaAuth),
    },
    url: `https://www.goofish.com/item?id=${item.itemId || id}`,
  }
}

/**
 * 商品详情。详情接口被闲鱼人机验证拦截时，回退到搜索结果卡片：
 * 先查本次进程的搜索缓存；没有缓存再用调用方给的关键词搜一次。
 */
export async function getItem(itemId, config = {}, signal, options = {}) {
  const id = itemIdOf(itemId)
  if (!/^\d{6,}$/.test(id)) {
    throw new XianyuError('商品 ID 无效：请传闲鱼商品 ID 或包含 id=... 的商品链接', 'XIANYU_ARGS')
  }

  try {
    return await fetchItemDetail(id, config, signal)
  } catch (error) {
    if (!(error instanceof XianyuError) || error.code !== 'XIANYU_VALIDATE') throw error

    const cached = cachedItem(id)
    if (cached) return cardAsDetail(cached, 'cache')

    const keyword = String(options.keyword || '').trim()
    if (keyword) {
      const result = await searchItems(keyword, { limit: 30 }, config, signal)
      const found = result.items.find((item) => item.id === id)
      if (found) return cardAsDetail(found, 'search')
    }

    throw new XianyuError(
      [
        `闲鱼详情接口要求人机验证（FAIL_SYS_USER_VALIDATE），暂时拿不到 ${id} 的完整详情。`,
        `处理办法：1) 在浏览器打开 https://www.goofish.com/item?id=${id} 完成一次验证后重试；`,
        '2) 先用 xianyu_search 搜关键词，再调用 xianyu_item（会复用搜索结果卡片）；',
        '3) 调用 xianyu_item 时传 keyword，让插件在搜索结果里找同一商品。',
      ].join('\n'),
      'XIANYU_VALIDATE',
    )
  }
}

function stripHtml(value) {
  return decodeBasicEntities(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeBasicEntities(value) {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function toPositiveNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}
