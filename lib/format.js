/** 面向模型的 Markdown 格式化：搜索结果、商品详情、显卡日报。 */

function money(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  return `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
}

function moneyRange(stats) {
  if (!stats) return ''
  return `${money(stats.min)}–${money(stats.max)}`
}

function preview(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

export function formatSearchResult(result) {
  const lines = [`# 闲鱼搜索 · ${result.keyword}`, '']
  const meta = [`第 ${result.page} 页`, `返回 ${result.items.length} 条`]
  if (result.stats) {
    meta.push(
      `价格 ${moneyRange(result.stats)}（中位数 ${money(result.stats.median)}，均价 ${money(result.stats.average)}，样本 ${result.stats.count}）`,
    )
  }
  lines.push(meta.join(' · '))
  if (result.minPrice !== null || result.maxPrice !== null) {
    const from = result.minPrice === null ? '不限' : money(result.minPrice)
    const to = result.maxPrice === null ? '不限' : money(result.maxPrice)
    lines.push(`价格筛选：${from} – ${to}（本地过滤）`)
  }
  lines.push('')

  if (result.items.length === 0) {
    lines.push('没有找到符合条件的商品。可以换关键词，或放宽价格筛选/页码。')
    return lines.join('\n')
  }

  result.items.forEach((item, index) => {
    const price = item.price === null ? item.priceText || '价格未知' : money(item.price)
    lines.push(`${index + 1}. **${item.title}** — ${price}`)
    const details = []
    if (item.area) details.push(item.area)
    if (item.seller) details.push(`卖家：${item.seller}`)
    if (item.tags && item.tags.length > 0) details.push(item.tags.slice(0, 2).join(' / '))
    details.push(`ID：${item.id}`)
    lines.push(`   ${details.join(' · ')}`)
    lines.push(`   ${item.url}`)
  })

  lines.push('')
  lines.push('提示：需要完整描述、图片和卖家资料时，用 xianyu_item 传商品 ID。')
  return lines.join('\n')
}

export function formatItemDetail(item) {
  const lines = [`# 闲鱼商品 · ${item.title || item.id}`, '']
  if (item.partial) {
    lines.push(
      '> 闲鱼详情接口触发了人机验证，以下为搜索结果卡片信息；描述、完整图片、浏览/收藏数请在浏览器打开链接查看。',
    )
    lines.push('')
  }
  const priceLabel =
    item.price === 0 && /免费/.test(item.priceText || '')
      ? '免费送'
      : item.price === 0 && /面议/.test(item.priceText || '')
        ? '面议'
        : item.price === null
          ? '价格未知'
          : money(item.price)
  const original = item.originalPrice ? `（原价 ${money(item.originalPrice)}）` : ''
  lines.push(`- 价格：${priceLabel}${original}`)
  if (item.transportFee !== null) {
    lines.push(`- 运费：${item.transportFee === 0 ? '包邮' : money(item.transportFee)}`)
  } else if (/包邮/.test(item.transportFeeText || '')) {
    lines.push('- 运费：包邮')
  }
  if (item.status) lines.push(`- 状态：${item.status}`)
  if (item.createdAt) {
    const date = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(item.createdAt))
    lines.push(`- 发布：${date}`)
  }
  const stats = []
  if (item.browseCount !== null) stats.push(`浏览 ${item.browseCount}`)
  if (item.wantCount !== null && item.wantCount > 0) stats.push(`想要 ${item.wantCount}`)
  if (item.collectCount !== null) stats.push(`收藏 ${item.collectCount}`)
  if (stats.length > 0) lines.push(`- 热度：${stats.join(' · ')}`)
  if (item.labels.length > 0) lines.push(`- 标签：${item.labels.join(' / ')}`)

  const seller = item.seller || {}
  const sellerParts = []
  if (seller.nick) sellerParts.push(seller.nick)
  if (seller.city) sellerParts.push(seller.city)
  if (seller.soldCount !== null) sellerParts.push(`已售 ${seller.soldCount} 件`)
  if (seller.replyRatio) sellerParts.push(`24h 回复率 ${seller.replyRatio}`)
  if (seller.registeredDays !== null) sellerParts.push(`注册 ${seller.registeredDays} 天`)
  if (seller.zhimaAuth) sellerParts.push('芝麻认证')
  if (sellerParts.length > 0) lines.push(`- 卖家：${sellerParts.join(' · ')}`)
  if (seller.signature) lines.push(`- 卖家签名：${preview(seller.signature, 120)}`)

  lines.push('')
  if (item.partial) {
    lines.push('## 说明')
    lines.push(
      `完整详情被闲鱼人机验证拦截（来源：${item.partialSource || '搜索结果'}）。在浏览器完成一次验证后重试，可能可以拿到完整描述和全部图片。`,
    )
  } else {
    lines.push('## 描述')
    lines.push(item.description ? preview(item.description, 1500) : '（卖家没有填写描述）')
  }

  if (item.images.length > 0) {
    lines.push('')
    lines.push('## 图片')
    item.images.slice(0, 8).forEach((url, index) => lines.push(`${index + 1}. ${url}`))
    if (item.images.length > 8) lines.push(`（还有 ${item.images.length - 8} 张，未全部列出）`)
  }

  lines.push('')
  lines.push(`链接：${item.url}`)
  return lines.join('\n')
}

function indexLine(label, index) {
  if (!index) return `${label}指数：暂无数据`
  const change =
    index.direction === '平' || index.change === 0
      ? '持平'
      : `${index.direction === '跌' ? '-' : '+'}${index.change}`
  return `${label} 卡指数：${index.value}（${change}）`
}

export function formatReport(article, downloaded = []) {
  const lines = [`# 显卡日报 · ${article.date || article.createdDate || ''}`, '']
  lines.push(`**${article.title}**`)
  lines.push('')
  const indices = article.indices || {}
  if (indices.n || indices.a) {
    if (indices.n) lines.push(`- ${indexLine('N', indices.n)}`)
    if (indices.a) lines.push(`- ${indexLine('A', indices.a)}`)
    lines.push('')
  }

  if (article.summary) {
    lines.push('## 摘要')
    lines.push(article.summary)
    lines.push('')
  }

  if (article.points && article.points.length > 0) {
    lines.push('## 行情要点')
    article.points.forEach((point) => lines.push(`- ${point}`))
    lines.push('')
  }

  if (article.images && article.images.length > 0) {
    lines.push('## 价格表 / 配图')
    const shown = article.images.slice(0, 6)
    shown.forEach((url, index) => {
      const saved = downloaded.find((entry) => entry.url === url)
      lines.push(`${index + 1}. ${url}`)
      if (saved) lines.push(`   已保存：${saved.path}`)
    })
    if (article.images.length > shown.length) {
      lines.push(`（共 ${article.images.length} 张，其余未列出；正文中保留了全部图片地址）`)
    }
    lines.push('')
    if (downloaded.length > 0) {
      lines.push('提示：用 read_image 打开上面的本地图片，可读取图中的显卡价格表。')
      lines.push('')
    }
  }

  lines.push('## 正文')
  lines.push(article.text || '（没有取到正文）')
  lines.push('')
  lines.push(`原文：${article.url}`)
  return lines.join('\n')
}

export function formatArticleList(articles, query = '') {
  const title = query
    ? `# 显卡日报 · 搜索“${query}”`
    : `# 显卡日报 · 最近 ${articles.length} 期`
  const lines = [title, '']
  if (articles.length === 0) {
    lines.push('没有找到匹配的日报。可以换关键词，或减少过滤条件。')
    return lines.join('\n')
  }
  articles.forEach((article, index) => {
    lines.push(`${index + 1}. **${article.date || article.createdDate || ''}** — [${article.title}](${article.url})`)
    const meta = []
    if (article.indices && article.indices.n) meta.push(`N ${article.indices.n.value}`)
    if (article.indices && article.indices.a) meta.push(`A ${article.indices.a.value}`)
    if (meta.length > 0) lines.push(`   ${meta.join(' · ')}`)
    if (article.excerpt) {
      const excerpt = String(article.excerpt)
        .replace(/\[图片[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (excerpt) lines.push(`   ${preview(excerpt, 160)}`)
    }
  })
  lines.push('')
  lines.push('用 gpu_daily action=read article=<链接或 ID> 查看某一期全文。')
  return lines.join('\n')
}
