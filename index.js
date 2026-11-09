/**
 * 闲鱼 & 显卡日报工具插件（Host 端）。
 *
 * 向 Agent 注册三个工具：
 * - xianyu_search：搜索闲鱼在售商品，带价格统计
 * - xianyu_item：查看商品价格、描述、卖家与图片
 * - gpu_daily：读取知乎「显卡日报」的每日行情、历史列表与全文
 */
import { formatArticleList, formatItemDetail, formatReport, formatSearchResult } from './lib/format.js'
import {
  extractIndices,
  extractPoints,
  formatDate,
  latestArticle,
  listArticles,
  readArticle,
  reportDate,
  summarize,
  downloadImages,
} from './lib/zhihu.js'
import { getItem, openSession, searchItems } from './lib/xianyu.js'

export const inject = ['tools']

const textOutput = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: String(value) }]
  },
}

const XIANYU_COOKIE_HINT =
  '需要闲鱼登录 Cookie：把 goofish.com 请求头里的 Cookie 写入 ~/.dsh/xianyu-cookie.txt，或在插件配置里设置 cookie/cookieFile。'

function enrichArticle(article) {
  const text = article.text || ''
  return {
    ...article,
    date: reportDate(article),
    createdDate: formatDate(article.created),
    indices: extractIndices(text),
    summary: summarize(text),
    points: extractPoints(text),
  }
}

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

export function apply(ctx, config = {}) {
  const settings = { ...config }

  ctx.tools.register({
    name: 'xianyu_search',
    description:
      '搜索闲鱼在售商品，返回标题、价格、地区、卖家、商品 ID 与链接，并统计本页价格区间/中位数/均价。适合二手显卡、内存、整机等比价。' +
      XIANYU_COOKIE_HINT,
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '搜索关键词，例如 "RTX 4090"、"DDR5 32G"、"iPhone 15 Pro"。',
        },
        page: {
          type: 'integer',
          description: '页码，默认 1；范围 1-50。',
        },
        limit: {
          type: 'integer',
          description: '返回条数，默认 15；范围 1-30。',
        },
        sort: {
          type: 'string',
          enum: ['relevance', 'price_asc', 'price_desc', 'newest'],
          description: '排序：relevance 综合（默认）、price_asc 价格低到高、price_desc 价格高到低、newest 最新发布。',
        },
        min_price: {
          type: 'number',
          description: '最低价格（元），可选；在返回结果中本地过滤。',
        },
        max_price: {
          type: 'number',
          description: '最高价格（元），可选；在返回结果中本地过滤。',
        },
      },
      required: ['keyword'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const keyword = String(args.keyword || '').trim()
      if (!keyword) throw new Error('keyword 不能为空')
      const session = await openSession(settings)
      const result = await searchItems(
        keyword,
        {
          page: args.page,
          limit: args.limit,
          sort: args.sort,
          minPrice: args.min_price,
          maxPrice: args.max_price,
        },
        session,
        exec.signal,
      )
      result.minPrice = args.min_price ?? null
      result.maxPrice = args.max_price ?? null
      return formatSearchResult(result)
    },
  })

  ctx.tools.register({
    name: 'xianyu_item',
    description:
      '查看闲鱼商品详情：售价、原价、运费、描述、成色标签、卖家资料、浏览/想要/收藏数与图片。id 可传商品 ID 或闲鱼商品链接；详情接口要求人机验证时会回退到搜索结果卡片（可传 keyword 帮助定位）。' +
      XIANYU_COOKIE_HINT,
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '闲鱼商品 ID（如 827048882387）或包含 id=... 的商品链接。',
        },
        keyword: {
          type: 'string',
          description:
            '可选。详情接口被人机验证拦截时，用这个关键词重新搜索并匹配同一商品 ID；通常传之前 xianyu_search 用的关键词。',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const session = await openSession(settings)
      const item = await getItem(args.id, session, exec.signal, { keyword: args.keyword })
      return formatItemDetail(item)
    },
  })

  ctx.tools.register({
    name: 'gpu_daily',
    description:
      '读取知乎「显卡日报」的每日行情。latest 返回最新一期：N/A 卡价格指数与涨跌、行情要点、价格表图片和全文；list 列出最近几期并可按关键词筛选；read 读取指定文章。' +
      '价格表通常是图片，设 download_images=true 会把图片保存到本地并返回路径，再用 read_image 查看。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['latest', 'list', 'read'],
          description: 'latest 最新一期（默认）；list 最近几期；read 读取指定文章。',
        },
        query: {
          type: 'string',
          description: 'action=list 时按关键词过滤标题/摘要/正文，例如 "5080"、"11月9日"。',
        },
        limit: {
          type: 'integer',
          description: 'action=list 时返回条数，默认 5；范围 1-20。',
        },
        article: {
          type: 'string',
          description: 'action=read 时必填：知乎文章链接（zhuanlan.zhihu.com/p/...）或文章 ID。',
        },
        download_images: {
          type: 'boolean',
          description: '是否把文中前 3 张图片（通常是显卡/内存价格表）下载到本地，默认 false。',
        },
      },
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const action = args.action || 'latest'

      if (action === 'read') {
        const reference = String(args.article || '').trim()
        if (!reference) throw new Error('action=read 时必须提供 article（文章链接或 ID）')
        const article = enrichArticle(await readArticle(reference, exec.signal))
        const downloaded = args.download_images
          ? await downloadImages(article, 3, exec.signal)
          : []
        return formatReport(article, downloaded)
      }

      if (action === 'list') {
        const limit = clamp(args.limit, 1, 20, 5)
        const query = String(args.query || '').trim().toLowerCase()
        const fetchCount = query ? Math.min(20, Math.max(limit * 3, 12)) : limit
        let articles = await listArticles(fetchCount, 0, exec.signal)
        articles = articles.map((article) => ({
          ...article,
          date: reportDate(article),
          indices: extractIndices(article.text),
        }))
        if (query) {
          articles = articles
            .filter((article) =>
              `${article.title} ${article.excerpt} ${article.text}`.toLowerCase().includes(query),
            )
            .slice(0, limit)
        } else {
          articles = articles.slice(0, limit)
        }
        return formatArticleList(articles, query)
      }

      const article = enrichArticle(await latestArticle(exec.signal))
      const downloaded = args.download_images
        ? await downloadImages(article, 3, exec.signal)
        : []
      return formatReport(article, downloaded)
    },
  })
}
