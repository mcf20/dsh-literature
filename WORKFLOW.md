# dsh-literature — 完整工作流

> 一个 host-only 插件：把「检索到论文」和「拿到全文」分成两层处理。
> 检索用少数高质量源保证覆盖；全文用尽可能多的通道保证命中，并按
> 「官方接口 → OA 副本 → 真实浏览器 → 人工一步」逐级降级。

当前版本 **0.2.0**｜14 个模块 / 4,442 行｜8 个工具｜21 项测试

---

## 一、模块分工

```
编排
  lib/index.js          Config(30 项) · apply() · 8 个工具 · 通道决策 · 时间预算
检索层
  lib/sources.js        5 个源适配器 · S2 限流重试与串行 · 刊名/ISSN 解析 · PMID 元数据
  lib/identity.js       DOI 归一 · 标题 key · 去重合并 · 排序 · 补充材料过滤
全文定位
  lib/fulltext.js       9 个 oracle · 出版社 PDF 路径推导 · 候选信任排序
  lib/elsevier.js       Elsevier TDM：PDF 与全文 XML → Markdown
传输层
  lib/net.js            fetch/undici · 代理探测 · 机构分流 · 重试 · PDF magic 校验
浏览器通道
  lib/browser.js        CDP 封装 · 启动 Chrome · 原生下载 · Fetch 域抓字节 · 会话查询
  lib/browser-click.js  打开文章页 · 识别验证/登录/无权限 · 人工交接 · 点击 PDF
  lib/bsk.js            browser-skill CLI 回退（需要登录态且点击即下载的站点）
解析与存储
  lib/pdfstore.js       落盘 · 内容寻址缓存 · pdf-parse · Markdown · 库检索 · 命名
  lib/quality.js        预览版判定（纯函数，可测）
  lib/search-text.js    正文段落定位
  lib/import.js         导入手动下载的 PDF（按正文 DOI 识别）
  lib/xlsx.js           零依赖 .xlsx 写入器
```

---

## 二、8 个工具

| 工具 | 作用 | 需要人 |
|---|---|---|
| `lit_search` | 五源并行检索 → 归一 → 去重 → 排序；可按刊/按卷、导出 xlsx | 否 |
| `lit_resolve` | 问 9 个 oracle「哪有合法全文」，列出候选与逐个应答 | 否 |
| `lit_fetch_pdf` | 五级通道自动下载 + 完整性校验 + 落盘解析 | 订阅刊可能一次 |
| `lit_read` | 读正文（缓存 → Elsevier XML → PDF 抽文本）；`find` 定位段落 | 否 |
| `lit_library` | 本地全文检索 / 列库 | 否 |
| `lit_import` | 导入手动下载的 PDF（识别 DOI、解析、改名） | 你下载 |
| `lit_doctor` | 13 项环境自检 | 否 |
| `lit_login` | 登录一次持久化复用；`check` 查会话 | 一次 |

---

## 三、主链路

```
一句话 / 一个 DOI
      │
      ▼
① lit_search ────────────────────────────────────────────────
   5 源并行：OpenAlex(key) · Crossref · arXiv · PubMed(key) · Semantic Scholar(key)
   · 逐源 15 秒超时、1 次重试；单源失败只影响该列
   · S2 额外：进程内 ≥1.2s 串行 + 遇 429 重试两次（1.5s → 3s）
     ↓ 归一：DOI 小写去前缀；标题 key（去标点/冠词，保留汉字）
     ↓ 去重（第一层，见第四节）
     ↓ 排序：能拿全文的在前 → 被引数 → 年份
     ↓ 可选：journal（刊名/ISSN）、volume、export（.xlsx）
   输出：每篇标「全文：arXiv PDF / OA PDF / PMC / metadata only」

② lit_resolve（fetch 内部自动调用）──────────────────────────
   9 个 oracle 并行，括号为信任度：
     arXiv(100) · PMC/EuropePMC(90) · 出版社 citation_pdf_url(86)
     · 出版社路径推导(84) · Crossref link & PII(80/83)
     · Unpaywall(80) · OpenAlex locations(70) · S2 openAccessPdf(60) · CORE(55)
   · Elsevier oracle 只对 10.1016/10.1014/… 等前缀调用（其它必 404，不占名额）
   · 出版社路径只认域名匹配，不扫页面文字（避免假候选）
   输出：候选列表 + attempts（「没有」与「被挡」分得清）

③ lit_fetch_pdf ─────────────────────────────────────────────
   陷阱一：Unpaywall 常给 hdl.handle.net 这类「网页」而非文件
          → 标为 landing → 浏览器打开 → 抽出 bitstream 直链
          → 提到最高优先级（95），把预算留给这条慢通道
   陷阱二：候选 URL 若已下过 → 直接返回缓存，一个字节都不下（去重第二层）

   deadline = 工具预算 − 25 秒（避免三分钟静默）
   按信任度逐候选，五级通道：

   第 1 级  直连 HTTP          arXiv / OA 直链 / Elsevier TDM        1–2 秒
   第 2 级  Chrome 原生下载     PDF 存成文件（不走阅读器）              5–20 秒
   第 3 级  Chrome 拦截字节     直链 403 时抓响应                      10–20 秒
   第 4 级  文章页 + 签名链      ScienceDirect 订阅刊，等你点 View PDF
   第 5 级  手动下载 + 导入      你点下载，lit_import 收

   每级成功都过完整性判定：
     页数 ≤ 1 且正文 < 8000 字符 → 预览版，继续下一级

   成功 → papers/<key>/paper.pdf → 立即解析 paper.md
   可选 naming=pubmed → library/年份_期刊_第一作者_标题.pdf

④ lit_read ──────────────────────────────────────────────────
   缓存 paper.md ≥ 8000 字符 → 直接用
   有 DOI + Elsevier key 且缓存太短 → 走 TDM XML（正文最全）
   否则 → PDF 抽文本 → 分片返回（offset / max_chars）
   传 find → 定位模式：逐处返回匹配片段 + 上下文

⑤ lit_library ───────────────────────────────────────────────
   扫 papers/*/paper.md → 字面或正则检索 → 返回命中原句

⑥ lit_import（手动下载的补救路径）───────────────────────────
   扫 Downloads（或 importDir）→ %PDF 校验 → 抽文本 → 正则找 DOI
   → OpenAlex 查元数据 → 按 DOI 入库 → 解析 → 命名
   拒绝：无 DOI 且文件名是哈希 / 无文字层 / 小于 20 KB
```

---

## 四、三层去重

| 层 | 时机 | 规则 |
|---|---|---|
| 元数据 | 检索结果合并时 | DOI 归一后相同才合并；标题 key 相同且**一方无 DOI** 才按标题合并；两个不同 DOI 永不合并（预印本与正刊必须分开）；补充材料（`.s001`、`-sup-0001`）直接剔除 |
| URL | 下载前 | 同一 URL 取过 → 返回缓存，不下载 |
| 内容 | 保存时 | sha256 相同 → 不存第二份，只在原条目记别名 |

第三层是实际撞出来的：某期刊版与预印本指向同一个 PDF，白占 15 MB。

---

## 五、失败时给三种不同答案

| 页面表现 | 工具回答 | 你该做什么 |
|---|---|---|
| 人机验证 | 「在那个 Chrome 窗口完成验证」 | 点一下，让我重试 |
| 需要登录机构账号 | 「用 lit_login 登录一次，之后自动复用」 | 登一次 |
| **本机构没订阅** | 「页面直接给了购买选项，换渠道也拿不到」 | 别耗时 |

第三种最省时间：它把「技术失败」和「权限没有」分开，避免在一篇永远下不到的论文上反复试。

---

## 六、覆盖矩阵（实测）

| 论文类型 | 走哪级 | 需要人 | 实测 |
|---|---|---|---|
| arXiv 预印本 | 1 | 否 | ✅ 多篇 |
| 金色 / green OA | 1 | 否 | ✅ Nat Sustain 46 页 |
| Europe PMC | 2 | 否 | ✅ 49 页、13 页 |
| IEEE 等按 IP 放行 | 2 | 否 | ✅ 1.25 MB |
| **ACS 订阅** | 2 | 否 | ✅ 13 页 |
| **Nature 订阅** | 2 | 否 | ✅ 9 页 |
| Elsevier OA | 1（TDM） | 否 | ✅ 15 页 |
| Elsevier 订阅正文 | 1（TDM XML） | 否 | ✅ 10.3 万字符 |
| Elsevier 订阅 PDF | 4 | 点 View PDF | ✅ 13 页 |
| 机构仓储作者稿 | 1（句柄跟进） | 否 | ✅ 4 页 |
| 出版社 CDN | 1 | 否 | ✅ 53 / 62 页 |
| 学校未订阅 | — | — | ❌ 报清原因 |

---

## 七、浏览器通道与登录

插件自带一个**持久化**的独立 Chrome 配置（`~/.dsh-literature/chrome`），与日常浏览器隔离。

```
lit_login url=<文章页或图书馆门户>   打开窗口，你登录
lit_login check=true                查哪些站点有会话
```

### 三条实现细节（都踩过坑）

1. 必须设 `plugins.always_open_pdf_externally = true`，否则 PDF 进阅读器、字节抓不到
2. 抓 PDF 必须开**新标签**：导航到 PDF 会让 Chrome 替换 target，复用旧标签 socket 会断
3. `Fetch.enable` 用广域 `*`；窄 pattern 会漏掉文档响应

### browser-skill 回退（可选）

`browserEngine: auto` 时浏览器那一级依次尝试：

```
1. CDP 原生下载（PDF 落地为文件）      5 秒级
2. CDP 拦截响应字节                   10–20 秒
3. bsk CLI 打开文章页 → 读快照 → 点击捕获下载   15–25 秒
```

边界：bsk 只能捕获**真正的文件下载**；对「跳到阅读器」的站点会超时。
daemon 无法在沙箱内自启，需常驻任务：

```powershell
bsk daemon start --foreground
# 客户端命令加 BSK_AUTO_START=0
```

---

## 八、配置与凭据

凭据存 `~/.dsh/.credentials.yaml` 的 `refs:` 下，插件只引用名字：

```
OPENALEX_API_KEY · NCBI_API_KEY · SEMANTIC_SCHOLAR_API_KEY
ELSEVIER_API_KEY · CORE_API_KEY（未配，仅少一个 oracle）
```

关键配置（30 项中的主要项）：

```yaml
openalexMailto / unpaywallEmail     礼貌池与 OA 判定（必填）
proxyUrl                            元数据走代理
institutionalProxyUrl: direct       出版社直连（校园 IP 才代表订阅）
ezproxyPrefix                       有 EZproxy 的学校用
browserDownload / cdpPort / chromeProfileDir / browserDirect / browserEngine
humanWaitMs = 20000                 等你过验证的时长
toolTimeoutMs = 180000              单次工具预算
defaultSources                      默认 5 个源全开
dataDir                             空 = ~/.dsh-literature
```

---

## 九、落盘

```
~/.dsh-literature/
├─ papers/<key>/{paper.pdf, paper.md, meta.json}   key = DOI > arXiv > PMID > 标题
├─ library/年份_期刊_第一作者_标题.pdf              阅读版
├─ exports/*.xlsx                                  检索结果
├─ tmp-dl/                                         浏览器下载的临时落点
└─ chrome/                                         独立浏览器配置（含登录状态）
```

---

## 十、已知限制（如实）

1. Elsevier 订阅文章的**PDF 导出**不授权给 TDM 接口（只给首页）→ 正文走 XML
2. Wiley 等是否可下取决于**本机构订没订**，与技术水平无关
3. ScienceDirect 订阅刊仍可能需人工点一次 View PDF
4. 中文文献（知网/万方）无公开 API，未接入
5. 解析是启发式的，表格公式会丢失；图表不单独提取
6. S2 免费 key 限流较紧（~1 次/秒），高并发时可能整列失败（已加重试，其它源不受影响）
