# dsh-literature — 完整链路

> 一个 host-only 插件：把"检索到论文"和"拿到全文"分成两层，全文按"官方接口 → OA 副本 → 浏览器 → 人工一步"四级降级。

## 一、模块（11 个文件）

```
入口 / 编排
  lib/index.js          Config(27 项) · apply() · 6 个工具 · 通道决策 · 时间预算
检索层
  lib/sources.js        5 个检索源适配器 + 刊名/ISSN 解析 + PMID 元数据
  lib/identity.js       DOI 归一 · 标题 key · 去重合并 · 排序
全文解析链
  lib/fulltext.js       9 个 oracle + 出版社 PDF 路径推导 + 候选排序
  lib/elsevier.js       Elsevier TDM：PDF + 全文 XML → Markdown
传输层
  lib/net.js            fetch/undici · 系统代理探测 · 机构分流 · 重试 · PDF 校验
浏览器通道
  lib/browser.js        CDP 封装 · 启动 Chrome · Fetch 域抓字节 · 签名链监听
  lib/browser-click.js  打开文章页 · 检测验证 · 人工交接 · 点击 PDF
存储 / 解析 / 导出
  lib/pdfstore.js       下载落盘 · 内容寻址缓存 · pdf-parse · Markdown · 库检索 · 命名
  lib/import.js         导入你手动下载的 PDF（按正文 DOI 识别）
  lib/xlsx.js           零依赖 .xlsx 写入器
```

## 二、8 个工具

| 工具 | 作用 | 需要人操作 |
|---|---|---|
| `lit_search` | 五源并行检索 → 归一 → 去重 → 排序；可选按刊/按卷、导出 xlsx | 否 |
| `lit_resolve` | 问 9 个 oracle "哪有合法全文"，列出候选与逐个应答 | 否 |
| `lit_fetch_pdf` | 四级通道自动下载，校验完整性，落盘 + 立即解析 | 订阅刊需点一次 |
| `lit_read` | 读正文（缓存 → Elsevier XML → PDF 抽文本），分片返回 | 否 |
| `lit_library` | 本地全文检索 / 列库 | 否 |
| `lit_import` | 导入你下载的 PDF（识别 DOI、解析、改名） | 你负责下载 |
| `lit_doctor` | 自检：Node / 目录 / 解析器 / Chrome / 代理 / 密钥 / bsk / 库 | 否 |
| `lit_login` | 登录一次，持久化复用；`check` 查会话 | 一次 |

## 三、完整链路

```
用户问题
   │
   ▼
① lit_search ─────────────────────────────────────────────
   5 源并行：OpenAlex(带key) / Crossref / arXiv / PubMed(带key) / Semantic Scholar(带key)
   逐源：15 秒超时、1 次重试；单源失败只影响该列
   ↓ 归一：DOI 小写去前缀；标题 key（去标点/去冠词/保留汉字）
   ↓ 去重（第一层）：DOI 归一 + 标题 key；两个不同 DOI 永不合并；一方无 DOI 才按标题合并
   ↓ 排序：能拿全文的在前 → 被引数 → 年份
   ↓ 可选：journal（刊名/ISSN，OpenAlex 源解析，失败转 Crossref 精确匹配）
   ↓ 可选：volume（过卷）、export（写 .xlsx 到 exports/）
   输出：每篇带「全文：arXiv PDF / OA PDF / PMC / metadata only」

② lit_resolve（fetch 内部自动调用）─────────────────────────
   9 个 oracle 并行（括号内为信任度）：
     arXiv(100) · PMC/EuropePMC(90) · 出版社 citation_pdf_url(86)
     · 出版社路径推导(84) · Crossref link & PII(80/83)
     · Unpaywall(80) · OpenAlex locations(70) · S2 openAccessPdf(60) · CORE(55)
   规则：Elsevier oracle 仅对 10.1016 等前缀调用（其它一律 404，不占名额）
   规则：出版社路径只认域名匹配，不扫页面文字（避免误判）
   输出：候选列表 + attempts（"没有" 与 "被挡" 分得清）

③ lit_fetch_pdf ───────────────────────────────────────────
   去重（第二层）：候选 URL 若已下过 → 直接返回缓存，不下载
                    （第三层）：保存时 sha256 相同 → 只记别名，不存第二份
   deadline = 工具预算 − 25 秒（避免三分钟静默）
   按信任度逐候选，四级通道：

   第 0 步  仓库句柄跟进
              Unpaywall 常给 hdl.handle.net 这类"网页"而非文件
              → 标为 landing → 浏览器打开 → 抽出 bitstream 直链
              → 提到最高优先级（95），省下的时间留给这条慢通道
   第 1 级  直连 HTTP               arXiv / OA 直链 / Elsevier API       1–2 秒
   第 2 级  浏览器直接取 PDF         IEEE 等按 IP 放行的                   10–120 秒
   第 3 级  文章页 + 签名链
              ① 打开文章页（DOI 后缀 / PII / arnumber 推导）
              ② 有验证 → 等你 20 秒；同时监听标签列表
              ③ 出现 pdf.sciencedirectassets.com 签名链 → 用浏览器取字节
              ④ 裸 HTTP 取签名链会 403，必须浏览器
   第 4 级  全失败 → 保留预览版 + 逐条失败原因 + 三条出路

   "网页型"候选（kind=landing）不再交给浏览器重试，避免空耗预算

   每一级成功都过"完整性判定"：
      页数 ≤ 1 且正文 < 8000 字符 → 视为预览版，继续下一级

   成功 → papers/<key>/paper.pdf → 立即解析 paper.md
   可选 naming=pubmed → library/年份_期刊_第一作者_标题.pdf

④ lit_read ────────────────────────────────────────────────
   缓存 paper.md ≥ 8000 字符 → 直接用
   有 DOI + Elsevier key 且缓存太短 → 走 TDM XML（正文最全）
   否则 → PDF 抽文本 → 分片返回（offset / max_chars）
   传 find 时改为定位：逐处返回匹配片段 + 上下文，不必翻全文

⑤ lit_library ─────────────────────────────────────────────
   扫 papers/*/paper.md → 字面或正则检索 → 返回命中原句

⑥ lit_import（手动下载的补救路径）──────────────────────────
   扫 Downloads（或 importDir）→ 校验 %PDF → 抽文本 → 正则找 DOI
   → OpenAlex 查元数据 → 按 DOI 入库 → 解析 → 命名
   拒绝：无 DOI 且文件名是哈希 / 正文无文字层 / 小于 20 KB
```

## 四、覆盖矩阵

| 论文类型 | 走哪级 | 需要人 | 实测 |
|---|---|---|---|
| arXiv 预印本 | 1 级 | 否 | ✅ |
| 金色 / green OA（Unpaywall 判定） | 1 级 | 否 | ✅ |
| PMC 开放子集 | 2 级 | 否 | ✅ 2.03 MB |
| IEEE 等按 IP 放行 | 2 级 | 否 | ✅ 1.25 MB |
| Elsevier OA | 1 级（TDM） | 否 | ✅ 15 页 |
| Elsevier 订阅 | 3 级 | 点 View PDF | ✅ 2 篇 13 页 |
| Nature / ACS / Wiley | 6 级（导入） | 点下载 | ✅ 1 篇 Nature |
| 无权限且无 OA | — | — | ❌ 报清楚原因 |

## 五、配置与凭据

凭据（`~/.dsh/.credentials.yaml` → `refs`，插件只存引用名）：
`OPENALEX_API_KEY` · `NCBI_API_KEY` · `SEMANTIC_SCHOLAR_API_KEY` · `ELSEVIER_API_KEY` · `CORE_API_KEY`（未配）

关键配置：
```
openalexMailto / unpaywallEmail     礼貌池与 OA 判定
proxyUrl                            元数据走代理（默认系统代理）
institutionalProxyUrl: direct       出版社直连（校园 IP 才是订阅）
ezproxyPrefix                       有 EZproxy 的学校用
browserDownload / cdpPort / chromeProfileDir / browserDirect
humanWaitMs = 20000                 等你过验证的时长
toolTimeoutMs = 180000              单次工具预算
dataDir                             空 = ~/.dsh-literature
```

## 六、落盘

```
C:\Users\12460\.dsh-literature\
├─ papers\<key>\{paper.pdf, paper.md, meta.json}   key = DOI > arXiv > PMID > 标题
├─ library\年份_期刊_作者_标题.pdf                  阅读版
├─ exports\*.xlsx                                  检索结果
└─ chrome\                                         下载用的独立浏览器配置
```

## 七、两条浏览器通道（并存）

插件自带一条 CDP 通道；`browser-skill` 提供另一条真实浏览器通道。两者并存、互不干扰。

| | 插件 CDP 通道 | browser-skill |
|---|---|---|
| 浏览器 | 独立配置 `C:\Users\12460\.dsh-chrome` | 你日常的 Chrome（带全部登录态） |
| 端口 | 9222（按需启动） | daemon 52800 |
| 用途 | **抓 PDF 字节**（arXiv/PMC/IEEE/Elsevier/ACS/Nature） | **需要登录或人机验证的站点**、读页面结构、点击 |
| 输出 | 直接进本地库 | 页面文字/截图/点击；下载文件落 Downloads 后可 `lit_import` |
| 依赖 | 无（Node 内置 WebSocket） | `bsk` CLI + Chrome 扩展 + daemon |

关键实现细节（都是踩过的坑）：

- 插件通道里 Chrome 必须设 `plugins.always_open_pdf_externally = true`，否则 PDF 进阅读器、字节抓不到
- 抓 PDF 必须用**新标签**；导航到 PDF 会让 Chrome 替换 target，复用旧标签 socket 会断
- `Fetch.enable` 用广域 `*`；窄 pattern 会漏掉文档响应
- 元数据走代理（Clash），出版社走直连（校园 IP 才代表订阅）

browser-skill 的 daemon 在这台机器上无法脱离沙箱 Job 自启，需要在常驻任务里跑：

```powershell
bsk daemon start --foreground
# 之后客户端命令加 BSK_AUTO_START=0
```

### 已接入的回退引擎

`browserEngine: auto`（默认）时，`lit_fetch_pdf` 的浏览器那一级按顺序尝试：

```
1. CDP：Chrome 原生下载（PDF 落地为文件）        5 秒级
2. CDP：Fetch 域拦截响应字节                    10–20 秒
3. bsk：spawn CLI 打开文章页 → 读快照找按钮 → 点击捕获下载   15–25 秒
```

实测边界（重要）：

- bsk 的 `download` 只能捕获**真正的文件下载**；对"跳到 PDF 让阅读器打开"的站点（Nature、ACS）会超时
- 团队机器上插件 Chrome 设了 `always_open_pdf_externally`，所以 CDP 那两级能覆盖这类站点
- 若要 bsk 也覆盖，需要把**用户日常 Chrome** 也设成 PDF 一律下载——副作用影响日常浏览，未采用
- 因此 bsk 的定位是：**需要登录态、且点击即下载**的站点

## 八、已知限制


1. Elsevier 订阅文章的 **PDF 导出**不授权给 TDM 接口（只给首页）→ 靠第 3 级
2. Nature/ACS/Wiley 只给"下载文件"不给可抓链接 → 靠第 6 级导入
3. PDF 阅读器内跑不了脚本、缓存命中时拦截不到 → 这两处必须人点
4. 中文文献（知网/万方）未接入
5. 解析是启发式（修连字符/识别标题），表格公式会丢；未接 MinerU




