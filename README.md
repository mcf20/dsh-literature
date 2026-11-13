# dsh-literature

[![test](https://github.com/mcf20/dsh-literature/actions/workflows/test.yml/badge.svg)](https://github.com/mcf20/dsh-literature/actions/workflows/test.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A522.19-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![version](https://img.shields.io/github/package-json/v/mcf20/dsh-literature)](package.json)

给 DeepSeek Harness 用的**文献检索 + 全文获取**插件。

检索只负责找线索；拿到正文是另一件事，按"官方接口 → OA 副本 → 浏览器 → 人工一步"逐级降级。

> A DeepSeek Harness plugin for literature search **and full-text retrieval**: five metadata sources,
> a nine-oracle open-access chain, publisher download channels, PDF→Markdown, and a local
> full-text library.

---

## 它解决什么问题

OpenAlex / Crossref / PubMed 这类接口只给题目、作者、摘要、DOI。点进去往往还是要订阅或登录。
这个插件把"找到"和"拿到"分开处理，并在拿不到时**明确告诉你卡在哪一步**，而不是编造内容。

---

## 安装

插件是一个标准的 DSH bundle（`dsh.bundle.patch` + 一个 loader 行）。

### 方式一：本地目录（推荐给开发/内网）

```bash
# 克隆到任意目录，例如 ~/dsh-literature
git clone <this-repo> ~/dsh-literature
cd ~/dsh-literature
npm install            # 装 pdf-parse
```

然后在 DSH 里安装这个本地目录：

```text
plugin_manager  action=install_bundle  target=/绝对路径/dsh-literature
```

或手工登记到你的 profile（`<DSH_HOME>/profiles/<name>/package.json`）：

```json
{
  "dsh": { "profile": { "bundles": ["...", "dsh-literature"] } },
  "dependencies": { "dsh-literature": "link:/绝对路径/dsh-literature" }
}
```

重启 DSH 后生效。

### 方式零：tgz（最简单，推荐给别人）

拿到 `dsh-literature-0.1.0.tgz` 后按 [INSTALL.md](INSTALL.md) 走：解包 → `npm install` → 在 DSH 里登记。

### 方式二：npm（尚未发布）

```bash
dsh plugin --profile web add dsh-literature
```

> 目前未发布到 npm，请用方式零或方式一。

### 系统要求

| 项 | 要求 |
|---|---|
| Node | ≥ 22.19（用到内置 WebSocket） |
| 平台 | Windows / macOS / Linux |
| 浏览器（可选） | Chrome 或 Edge，用于"浏览器通道"和 browser-skill |
| Python | 不需要 |

---

## 配置

所有配置走 DSH 的 profile patch；密钥一律走**凭据库**，不写进配置文件。

```yaml
# <DSH_HOME>/profiles/<name>/cordis.patch.yml
- id: literature
  name: dsh-literature
  config:
    openalexMailto: you@example.com      # OpenAlex/Crossref 礼貌池
    unpaywallEmail: you@example.com      # Unpaywall 判定 OA 必需
    dataDir: ''                          # 空 = ~/.dsh-literature
    defaultSources: [openalex, crossref, arxiv, pubmed, semantic-scholar]   # 默认全开
```

### 凭据（可选，缺了会自动降级）

写进 `<DSH_HOME>/.credentials.yaml` 的 `refs:` 下：

| 引用名 | 作用 | 缺失影响 |
|---|---|---|
| `OPENALEX_API_KEY` | OpenAlex 日配额 | 无 key 时按共享 IP 预算，容易 429 |
| `NCBI_API_KEY` | PubMed 10 次/秒 | 无 key 时 3 次/秒 |
| `SEMANTIC_SCHOLAR_API_KEY` | S2 速率 | 无 key 时经常 429 |
| `ELSEVIER_API_KEY` | Elsevier 官方 TDM（PDF + 全文 XML） | 无 key 时 Elsevier 只能走 OA/浏览器 |
| `CORE_API_KEY` | 机构仓储聚合 | 无 key 时该 oracle 不工作 |

申请入口：OpenAlex `POST https://api.openalex.org/api-keys`、NCBI `ncbi.nlm.nih.gov/account`、
Semantic Scholar 官网、Elsevier `dev.elsevier.com`、CORE `core.ac.uk/services/api`。

---

## 八个工具

| 工具 | 用途 |
|---|---|
| `lit_search` | 五源并行检索 → 去重 → 排序；可选按刊/按卷、导出 xlsx |
| `lit_resolve` | 问 9 个 oracle "哪有合法全文"，列出候选与逐条应答 |
| `lit_fetch_pdf` | 四级通道下载，**校验完整性**（1 页预览不算成功） |
| `lit_read` | 读正文（缓存 → Elsevier XML → PDF 抽文本），分片返回；传 `find` 直接定位段落 |
| `lit_library` | 本地全文检索 / 列库 |
| `lit_doctor` | 自检：Node / 目录 / 解析器 / Chrome / 代理 / 密钥 / bsk / 本地库 |
| `lit_login` | 在插件自己的 Chrome 里登录一次，之后自动复用；`check: true` 只查当前会话 |
| `lit_import` | 导入你手动下载的 PDF（按正文 DOI 识别、解析、改名） |

自然语言即可，不需要记工具名。

---

## 三层去重

重复内容一分钱都不该多花，所以拦三道：

| 层 | 时机 | 做什么 |
|---|---|---|
| 元数据 | 检索结果合并时 | DOI 归一 + 标题 key；两个不同 DOI 永不合并（预印本 vs 正刊） |
| URL | 下载前 | 同一个下载地址以前取过 → 直接跳过，不下载 |
| 内容 | 保存时 | sha256 相同 → 不存第二份，只在原条目记别名 |

## 下载通道与覆盖

```
1 直连 HTTP        arXiv / 金色 OA / green OA / Elsevier API        1–2 秒
2 浏览器原生下载     Chrome 存文件（需 always_open_pdf_externally）  5–20 秒
3 浏览器拦截字节     直链 403 时                                    10–20 秒
4 文章页签名链       你点一次 View PDF（ScienceDirect 订阅刊）
5 手动下载 + 导入    你点下载，lit_import 收                         3 秒
```

| 论文类型 | 结果 |
|---|---|
| arXiv / 金色 / green OA / PMC | 自动 |
| IEEE 等按 IP 放行 | 自动 |
| Elsevier（有 key） | 全文 XML 自动；OA 文章整篇 PDF 自动 |
| ACS / Nature（有订阅） | 自动（走浏览器原生下载） |
| ScienceDirect 订阅刊 | 需点一次 |
| 学校未订阅 | 拿不到，工具会说明原因 |

**"OA" ≠ 能自动下**：不少机构仓储对脚本返回 418/403，只能走浏览器。

---

## 数据落盘

```
~/.dsh-literature/
├─ papers/<key>/{paper.pdf, paper.md, meta.json}   key = DOI > arXiv > PMID > 标题
├─ library/年份_期刊_第一作者_标题.pdf              可直接用的阅读版
├─ exports/*.xlsx                                  检索结果
└─ chrome/                                         下载用的独立浏览器配置
```

---

## 故障排查

先跑一次自检（工具名 `lit_doctor`），它会报告：Node 版本、数据目录可写、pdf-parse 能否加载、
Chrome 是否找到、代理探测结果、各密钥是否存在、browser-skill 是否就绪。

常见问题：

| 现象 | 原因 |
|---|---|
| 检索全空 | 缺 OpenAlex key 或代理不通 |
| 下载总是 403 | 该刊未订阅，或需要走浏览器通道 |
| 浏览器通道失败 | 没装 Chrome，或端口被占用 |
| 只拿到 1 页 | 出版社只给预览版（订阅刊常态） |

---

## 订阅与登录

插件自己带一个**持久化**的 Chrome 配置（`~/.dsh-literature/chrome`），登录一次就够。

```text
lit_login  url=<文章页或图书馆门户>     # 打开窗口，让你登录
lit_login  check=true                  # 看现在哪些站点有会话
```

登录后会话存在那个配置目录里，之后每次下载自动复用，不会反复问你。删掉该目录＝清空所有登录状态。

遇到三种情况，插件给的提示不同：

| 页面表现 | 插件回答 | 你该做什么 |
|---|---|---|
| 人机验证 | 「在那个 Chrome 窗口里完成验证」 | 点一下，然后让我重试 |
| 需要登录机构账号 | 「用 lit_login 登录一次」 | 登录一次，之后自动 |
| 本机构没有订阅 | 「页面直接给了购买选项」 | 换渠道或文献传递，别耗时 |

## 已知限制

1. Elsevier 订阅文章的**PDF 导出**不授权给 TDM 接口（只给首页）；正文走 XML
2. 中文文献（知网/万方）未接入
3. 解析是启发式（修连字符/识别标题），表格公式会丢；未接 MinerU
4. 图表不单独提取
5. browser-skill 回退只对"点击即下载"的站点有效

---

## 许可

MIT，见 [LICENSE](LICENSE)。




