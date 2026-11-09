/**
 * 知乎「显卡日报」读取器。
 *
 * 专栏：https://www.zhihu.com/column/c_1433942042578157568
 *
 * 知乎对普通网页请求有登录墙，但移动端 UA 可以正常读取专栏文章列表
 * （含全文 HTML）；单篇文章页也能用移动端 UA 直接拿到正文。
 * 这里只读公开内容，不做登录、不写知乎账号数据。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const COLUMN_URL = 'https://www.zhihu.com/column/c_1433942042578157568'
const COLUMN_ID = 'c_1433942042578157568'
const API_BASE = 'https://www.zhihu.com/api/v4'
const ARTICLE_BASE = 'https://zhuanlan.zhihu.com/p/'
const UA = 'ZhihuHybrid android 10 com.zhihu.android/9.0.0'
const REQUEST_TIMEOUT_MS = 20000

export class ZhihuError extends Error {
  constructor(message, code = 'ZHIHU_ERROR') {
    super(message)
    this.name = 'ZhihuError'
    this.code = code
  }
}

async function fetchWithTimeout(url, options = {}, signal) {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  try {
    return await fetch(url, {
      ...options,
      signal: requestSignal,
      headers: {
        'user-agent': UA,
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(options.headers || {}),
      },
    })
  } catch (error) {
    if (signal && signal.aborted) throw new ZhihuError('知乎请求已取消', 'ZHIHU_ABORTED')
    if (error && error.name === 'TimeoutError') {
      throw new ZhihuError('知乎请求超时（20 秒）', 'ZHIHU_TIMEOUT')
    }
    throw new ZhihuError(`连接知乎失败：${error.message || error}`, 'ZHIHU_NETWORK')
  }
}

function articleIdFrom(urlOrId) {
  const text = String(urlOrId || '').trim()
  const match = text.match(/\/p\/(\d+)/) || text.match(/articles\/(\d+)/) || text.match(/^(\d{6,})$/)
  return match ? match[1] : ''
}

function normalizeArticle(raw) {
  const url = String(raw.url || '')
  const id = articleIdFrom(url) || String(raw.id || '')
  const contentHtml = String(raw.content || '')
  const text = htmlToText(contentHtml)
  return {
    id,
    title: String(raw.title || '').trim(),
    url: url || (id ? `${ARTICLE_BASE}${id}` : ''),
    created: Number(raw.created) || null,
    updated: Number(raw.updated) || null,
    excerpt: String(raw.excerpt || '').trim(),
    contentHtml,
    text,
    images: extractImages(contentHtml),
    voteupCount: Number(raw.voteup_count) || null,
    commentCount: Number(raw.comment_count) || null,
  }
}

/** 最近文章列表（知乎接口，含全文）。 */
export async function listArticles(limit = 10, offset = 0, signal) {
  const safeLimit = Math.min(20, Math.max(1, Math.trunc(Number(limit) || 10)))
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0))
  const url = `${API_BASE}/columns/${COLUMN_ID}/articles?limit=${safeLimit}&offset=${safeOffset}`
  const response = await fetchWithTimeout(
    url,
    { headers: { accept: 'application/json' } },
    signal,
  )
  if (!response.ok) {
    throw new ZhihuError(`知乎专栏接口 HTTP ${response.status}`, 'ZHIHU_HTTP')
  }
  let json
  try {
    json = await response.json()
  } catch (error) {
    throw new ZhihuError(`知乎专栏接口返回了无法解析的内容：${error.message}`, 'ZHIHU_PARSE')
  }
  const data = Array.isArray(json.data) ? json.data : []
  return data.map(normalizeArticle).filter((article) => article.id && article.title)
}

export async function latestArticle(signal) {
  const articles = await listArticles(1, 0, signal)
  if (articles.length === 0) throw new ZhihuError('知乎专栏没有返回文章', 'ZHIHU_EMPTY')
  return articles[0]
}

/**
 * 读取指定文章：优先读取文章页 SSR 正文；失败时在最近 100 篇列表中查找。
 * @param {string} urlOrId 文章链接或纯数字 ID
 */
export async function readArticle(urlOrId, signal) {
  const id = articleIdFrom(urlOrId)
  if (!id) {
    throw new ZhihuError('文章参数无效：请传知乎文章链接（zhuanlan.zhihu.com/p/...）或文章 ID', 'ZHIHU_ARGS')
  }

  const pageUrl = `${ARTICLE_BASE}${id}`
  try {
    const response = await fetchWithTimeout(pageUrl, { redirect: 'follow' }, signal)
    if (response.ok) {
      const html = await response.text()
      const article = parseArticlePage(html, id)
      if (article && article.text) return article
    }
  } catch (error) {
    if (error && error.code === 'ZHIHU_ABORTED') throw error
    // 页面读取失败时回退到列表查找。
  }

  for (let offset = 0; offset < 100; offset += 20) {
    const articles = await listArticles(20, offset, signal)
    const found = articles.find((article) => article.id === id)
    if (found) return found
    if (articles.length < 20) break
  }
  throw new ZhihuError(`最近 100 篇日报中没有找到文章 ${id}`, 'ZHIHU_NOT_FOUND')
}

function parseArticlePage(html, id) {
  const headline = metaContent(html, 'headline') || tagContent(html, 'title')
  const published = metaContent(html, 'datePublished')
  let contentHtml = ''
  const richTag = html.match(/<div[^>]*class="[^"]*\bRichText\b[^"]*"[^>]*>/i)
  if (richTag && richTag.index !== undefined) {
    contentHtml = balancedDivInner(html, richTag.index)
  }
  if (!contentHtml) {
    const articleStart = html.indexOf('<article')
    if (articleStart >= 0) {
      const articleEnd = html.indexOf('</article>', articleStart)
      if (articleEnd > articleStart) {
        contentHtml = html.slice(articleStart, articleEnd + '</article>'.length)
      }
    }
  }
  const text = htmlToText(contentHtml)
  if (!text) return null
  const created = published ? Math.floor(Date.parse(published) / 1000) : null
  return {
    id,
    title: decodeEntities(headline || '').trim(),
    url: `${ARTICLE_BASE}${id}`,
    created: Number.isFinite(created) ? created : null,
    updated: null,
    excerpt: text.slice(0, 180),
    contentHtml,
    text,
    images: extractImages(contentHtml),
    voteupCount: null,
    commentCount: null,
  }
}

function metaContent(html, prop) {
  const matcher = new RegExp(
    `<meta[^>]*itemProp=["']${prop}["'][^>]*content=["']([^"']*)["'][^>]*>`,
    'i',
  )
  const match = html.match(matcher)
  if (match) return match[1]
  const reverse = new RegExp(
    `<meta[^>]*content=["']([^"']*)["'][^>]*itemProp=["']${prop}["'][^>]*>`,
    'i',
  )
  const reverseMatch = html.match(reverse)
  return reverseMatch ? reverseMatch[1] : ''
}

function tagContent(html, tag) {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return match ? decodeEntities(match[1]).trim() : ''
}

function balancedDivInner(html, openIndex) {
  const tagPattern = /<div\b[^>]*>|<\/div>/gi
  tagPattern.lastIndex = openIndex
  let depth = 0
  let innerStart = -1
  let match
  while ((match = tagPattern.exec(html)) !== null) {
    if (match[0].startsWith('</')) {
      depth -= 1
      if (depth === 0) {
        return html.slice(innerStart, match.index)
      }
    } else {
      depth += 1
      if (depth === 1) innerStart = match.index + match[0].length
    }
  }
  return ''
}

function imgSource(tag) {
  const original = tag.match(/\bdata-original=["']([^"']+)["']/i)
  if (original) return decodeEntities(original[1])
  const lazy = tag.match(/\bdata-src=["']([^"']+)["']/i)
  if (lazy) return decodeEntities(lazy[1])
  const src = tag.match(/\bsrc=["']([^"']+)["']/i)
  return src ? decodeEntities(src[1]) : ''
}

export function extractImages(html) {
  const images = []
  const seen = new Set()
  const matcher = /<img\b[^>]*>/gi
  let match
  while ((match = matcher.exec(String(html || ''))) !== null) {
    const source = imgSource(match[0])
    if (!source || source.startsWith('data:') || seen.has(source)) continue
    seen.add(source)
    images.push(source)
  }
  return images
}

/** 把知乎正文 HTML 转成适合模型阅读的纯文本，图片保留为 [图片: url]。 */
export function htmlToText(html) {
  let text = String(html || '')
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
  text = text.replace(/<figure\b[\s\S]*?<\/figure>/gi, (block) => {
    const images = extractImages(block)
    const caption = block.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i)
    const captionText = caption ? decodeEntities(caption[1].replace(/<[^>]+>/g, '')).trim() : ''
    const parts = images.map((url) => `[图片: ${url}]`)
    if (captionText) parts.push(captionText)
    return parts.length > 0 ? `\n\n${parts.join('\n')}\n\n` : '\n\n'
  })
  text = text.replace(/<img\b[^>]*>/gi, (tag) => {
    const source = imgSource(tag)
    return source ? `\n\n[图片: ${source}]\n\n` : ''
  })
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<li[^>]*>/gi, '\n- ')
  text = text.replace(/<h([1-6])[^>]*>/gi, (_match, level) => `\n\n${'#'.repeat(Number(level))} `)
  text = text.replace(/<\/(p|div|section|h[1-6]|li|blockquote|tr|table|figure)>/gi, '\n\n')
  text = text.replace(/<[^>]+>/g, '')
  text = decodeEntities(text)
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function decodeEntities(value) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  }
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
    if (code[0] === '#') {
      const hex = code[1] && code[1].toLowerCase() === 'x'
      const number = hex ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10)
      if (Number.isFinite(number)) {
        try {
          return String.fromCodePoint(number)
        } catch {
          return entity
        }
      }
      return entity
    }
    const key = code.toLowerCase()
    return Object.hasOwn(named, key) ? named[key] : entity
  })
}

export function formatDate(created) {
  if (!created) return ''
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(new Date(created * 1000))
      .replace(/\//g, '-')
  } catch {
    return ''
  }
}

/** 文章标题里的“11月9日”优先于接口时间，跨年时按接口年份修正。 */
export function reportDate(article) {
  const fromCreated = formatDate(article.created)
  const match = String(article.title || '').match(/(\d{1,2})月(\d{1,2})日/)
  if (!match || !fromCreated) return fromCreated
  const [year, month, day] = fromCreated.split('-').map(Number)
  const titleMonth = Number(match[1])
  const titleDay = Number(match[2])
  let titleYear = year
  if (titleMonth - month > 6) titleYear -= 1
  if (month - titleMonth > 6) titleYear += 1
  return `${titleYear}-${String(titleMonth).padStart(2, '0')}-${String(titleDay).padStart(2, '0')}`
}

/** 解析 N/A 卡价格指数与涨跌。 */
export function extractIndices(text) {
  const source = String(text || '')
  const result = {}
  const patterns = [
    {
      key: 'n',
      matcher:
        /(?:N卡|GeForce|NVIDIA)指数(?:报)?\s*([\d.]+)\s*点[，,;；]?\s*(?:收)?(跌|涨|平|下跌|上涨)\s*([\d.]+)?\s*(?:点|个百分点)/g,
    },
    {
      key: 'a',
      matcher:
        /(?:A卡|Radeon|AMD)指数(?:报)?\s*([\d.]+)\s*点[，,;；]?\s*(?:收)?(跌|涨|平|下跌|上涨)\s*([\d.]+)?\s*(?:点|个百分点)/g,
    },
  ]
  for (const { key, matcher } of patterns) {
    const match = matcher.exec(source)
    if (!match) continue
    const direction = match[2].includes('跌') ? '跌' : match[2].includes('涨') ? '涨' : '平'
    result[key] = {
      value: Number(match[1]),
      direction,
      change: match[3] === undefined ? 0 : Number(match[3]),
    }
  }
  return result
}

/** 从正文中挑出与价格/涨跌有关的短句。 */
export function extractPoints(text, limit = 8) {
  const sentences = String(text || '')
    .split(/[。！？\n]/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 8 && sentence.length <= 180)
  const keywords = /显卡|价格|报价|指数|涨|跌|内存|固态|硬盘|CPU|RTX|RX\s?\d|GTX|B\d{3}/
  const seen = new Set()
  const points = []
  for (const sentence of sentences) {
    if (!keywords.test(sentence)) continue
    if (/^欢迎来到/.test(sentence)) continue
    const key = sentence.replace(/\s+/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    points.push(sentence)
    if (points.length >= limit) break
  }
  return points
}

export function summarize(text, maxLength = 360) {
  const paragraphs = String(text || '')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith('[图片'))
  const summary = paragraphs.slice(0, 2).join('\n')
  return summary.length > maxLength ? `${summary.slice(0, maxLength)}…` : summary
}

/**
 * 把行情图（多为价格表）下载到系统临时目录，返回本地路径供 read_image 查看。
 * @returns {Promise<Array<{url:string,path:string}>>}
 */
export async function downloadImages(article, limit = 3, signal) {
  const urls = (article.images || []).slice(0, Math.max(1, Math.min(6, limit)))
  if (urls.length === 0) return []
  const dir = path.join(os.tmpdir(), 'dsh-gpu-daily')
  await mkdir(dir, { recursive: true })
  const results = []
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]
    try {
      const response = await fetchWithTimeout(
        url,
        { headers: { referer: 'https://www.zhihu.com/' } },
        signal,
      )
      if (!response.ok) continue
      const contentType = response.headers.get('content-type') || ''
      const extension = contentType.includes('png')
        ? 'png'
        : contentType.includes('webp')
          ? 'webp'
          : contentType.includes('gif')
            ? 'gif'
            : 'jpg'
      const date = reportDate(article) || 'report'
      const file = path.join(dir, `${date}-${article.id}-${index + 1}.${extension}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      await writeFile(file, buffer)
      results.push({ url, path: file })
    } catch (error) {
      if (error && error.code === 'ZHIHU_ABORTED') throw error
      // 单张图片失败不影响整篇日报。
    }
  }
  return results
}
