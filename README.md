# dsh-goofish-gpu-market

给 **DeepSeek Harness (DSH)** 用的 Host 插件：让 Agent 搜索闲鱼商品、查看价格与详情，并读取知乎「显卡日报」的每日行情。

> 非官方工具。闲鱼部分使用网页端 MTOP 接口，需要你自己的闲鱼登录 Cookie；接口和风控可能随时变化。

## 功能

| 工具 | 作用 |
| --- | --- |
| `xianyu_search` | 搜索闲鱼在售商品，返回标题、价格、地区、卖家、商品 ID、链接，并统计本页价格区间/中位数/均价 |
| `xianyu_item` | 查看商品详情：售价、原价、运费、描述、标签、卖家资料、浏览/想要/收藏数、图片 |
| `gpu_daily` | 读取知乎[「显卡日报」](https://www.zhihu.com/column/c_1433942042578157568)：最新一期、最近几期、关键词检索、指定文章全文 |

## 环境要求

- DSH Desktop（支持 Host bundle）
- Node.js 运行时由 DSH 提供；本插件只用 Node 内置模块，无需安装依赖、无需构建
- 一个可用的闲鱼账号（用于获取 Cookie）

## 安装

1. 克隆仓库：

   ```bash
   git clone https://github.com/MoreAmmonia/dsh-goofish-gpu-market.git
   ```

2. 在 DSH 中打开 **设置 → 插件管理**，选择“从本地目录安装”，指向本仓库根目录。
   也可以让 Agent 执行：

   ```
   plugin_manager install_bundle target=<本仓库的绝对路径>
   ```

3. 安装或更新 Host 插件代码后，重启 DSH，确保加载新的 JS 模块。

> 如果之前安装过本地版 `@local/goofish-gpu-market`，请先在插件管理里移除旧版，再安装本仓库，避免同名工具重复注册。

插件在 DSH 中的显示名是 **闲鱼 & 显卡行情**。

## 配置闲鱼 Cookie

闲鱼网页接口现在要求登录状态；没有 Cookie 时搜索会返回 `RGV587_ERROR` 或 `FAIL_SYS_USER_VALIDATE`。

### 获取

1. 浏览器登录 <https://www.goofish.com/>。
2. 打开开发者工具 → Network → 任选一个 `goofish.com` 请求。
3. 复制 Request Headers 里的 `Cookie` 整行，形如：

   ```
   cookie2=xxxx; _m_h5_tk=xxxx_xxxx; ...
   ```

### 写入

默认读取路径：

- Windows：`%USERPROFILE%\.dsh\xianyu-cookie.txt`
- macOS / Linux：`~/.dsh/xianyu-cookie.txt`

文件内容可以是一行 `key=value; key2=value2`，也可以直接粘贴 `Cookie: ...` 开头的内容；支持每行一个 `key=value`，`#` 开头为注释。

### 其他方式

优先级从高到低：

1. 插件配置 `cookie`（内联字符串）或环境变量 `XIANYU_COOKIE`
2. 插件配置 `cookieFile`（路径）或环境变量 `XIANYU_COOKIE_FILE`
3. 默认文件 `$DSH_HOME/xianyu-cookie.txt`（通常是 `~/.dsh/xianyu-cookie.txt`）

Cookie 过期后重新复制一次即可；插件会自动刷新 `_m_h5_tk` 令牌并重算 MTOP 签名。

## 使用示例

```
xianyu_search keyword="RTX 4090" min_price=2500 max_price=6000 sort=price_asc
xianyu_item id="827048882387"
xianyu_item id="827048882387" keyword="RTX 4090"
gpu_daily action=latest download_images=true
gpu_daily action=list query="5080" limit=5
gpu_daily action=read article="https://zhuanlan.zhihu.com/p/2102855803426414930"
```

### `xianyu_item` 的说明

闲鱼详情接口偶尔会触发人机验证（`FAIL_SYS_USER_VALIDATE`）。此时：

- 如果之前用 `xianyu_search` 搜到过该商品，插件会复用内存里的搜索结果卡片；
- 也可以传 `keyword`，让插件重新搜索并匹配同一商品 ID；
- 返回的卡片包含标题、价格、地区、卖家、标签、主图和链接，但不含完整描述/浏览数。

想要完整详情，可以在浏览器打开商品链接完成一次验证后重试。

### `gpu_daily` 的说明

- `latest`：最新一期，返回 N/A 卡价格指数、涨跌、行情要点、图片和全文。
- `list`：最近几期，可按 `query` 过滤标题/摘要/正文。
- `read`：读取指定文章，支持知乎文章链接或纯数字 ID。
- `download_images=true`：把文中前 3 张图片（通常是显卡/内存价格表）保存到系统临时目录，返回本地路径，之后可用 `read_image` 查看图内价格。

## 安全与隐私

- Cookie 只在运行时从本机读取，**不会写进插件代码、`package.json`、patch 或日志**。
- 携带 Cookie 的请求只发往 `h5api.m.goofish.com`（闲鱼）；知乎请求不携带闲鱼 Cookie，插件也没有遥测/上报逻辑。
- 本仓库的 `.gitignore` 已忽略 `xianyu-cookie.txt`、`*.cookie`、`cookie*.txt` 等本地凭据文件。
- 不要用 `config.cookie` 内联 Cookie 后再分享 `cordis.patch.yml` 或整个 profile；推荐始终使用默认文件或 `cookieFile`。
- 不要把 Cookie 粘贴到聊天、截图或公开 issue。
- 如果怀疑 Cookie 已泄露，在闲鱼退出登录（或修改密码）即可让旧 Cookie 失效。

## 已知限制

- 闲鱼是非官方网页接口，字段和风控会变化；插件对缺失字段做了降级，接口报错时会返回可操作的中文提示。
- `min_price` / `max_price` 是对当前页结果的本地过滤，不是服务端筛选，因此可能少于 `limit` 条。
- 闲鱼详情接口的人机验证无法由插件绕过；只能回退到搜索结果卡片，或在浏览器完成验证后重试。
- 知乎专栏使用移动端 UA 读取公开接口，不需要登录；如果知乎调整接口，可能需要更新解析逻辑。
- 本插件只做信息读取，不参与交易；购买前请自行核对商品状态、卖家和平台担保信息。

## License

[MIT](LICENSE)
