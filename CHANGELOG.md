# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] — 2026-11-13

### 新增

- `lit_login` 工具：在插件自己的持久化 Chrome 里登录一次，之后所有下载自动复用会话；`check: true` 只查当前登录状态
- `lit_read` 的 `find` 参数：按字面或正则定位段落，不必分片翻全文
- `lit_doctor` 工具：13 项环境自检（Node、数据目录、解析器、Chrome、代理、密钥、bsk、本地库）
- `install.mjs`：一条命令完成解包、装依赖、登记 profile、自检
- 补充材料 DOI 过滤（Crossref 会把 `.s001` 之类当独立记录返回）

### 变更

- `defaultSources` 默认改成 5 个源全开
- 下载失败时区分三种情况：需要人机验证、需要登录、机构没有订阅

### 修复

- 两个不同 DOI 但标题相同时被错误合并，导致预印本与正刊丢一条
- 合并记录时丢失 DOI
- `paperKey` 未归一化 DOI，同一篇可能算出两个缓存 key 并重复下载
- `pageTarget` 复用停在 PDF 上的标签，一导航就断 socket
- CDP socket 静默关闭时挂起请求永不返回（表现为卡死）
- `undici` 被 import 却没声明为依赖，换机器安装后插件加载失败

## [0.1.0] — 2026-11-10

### 新增

- 五源并行检索（OpenAlex / Crossref / arXiv / PubMed / Semantic Scholar），DOI + 标题双层去重
- 9 个全文 oracle（arXiv、EuropePMC、Unpaywall、OpenAlex、Semantic Scholar、CORE、Elsevier TDM、citation_pdf_url、Crossref link）
- 5 级下载通道：HTTP 直连 → Chrome 原生下载 → 响应字节拦截 → 文章页签名链 → 手动导入
- PDF → Markdown，含预览版拒绝（1 页 / 8000 字符以下不算成功）
- 本地全文库：`lit_library` 跨论文检索正文，`lit_import` 导入手动下载的 PDF
- 三层去重：元数据、下载 URL、内容哈希
- 命名规范：`年份_期刊_第一作者_标题.pdf`
