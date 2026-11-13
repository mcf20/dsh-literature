# 贡献指南

## 开发环境

```
Node.js ≥ 22.19
```

```bash
git clone <repo> && cd dsh-literature
npm install
npm test
```

## 改动前先看这三件事

1. **不要加绕过反爬的代码**。这个项目只通过公开接口、出版社授权通道和读者自己的浏览器取文件。任何伪装指纹、破解验证码、TLS 指纹伪造之类的改动一律不接受。
2. **纯逻辑要有测试**。`test/logic.test.mjs` 里的用例不碰网络——去重、命名、缓存 key、预览判定这些地方改一行都可能悄悄弄坏别处。
3. **网络行为不做 mock 测试**。出版社的真实响应（403、挑战页、签名链过期）只能实测，写 mock 只会给人虚假信心。

## 提交前

```bash
npm test                    # 20 项应全过
node -e "import('./lib/index.js').then(m=>{const t=[];m.apply({tools:{register:x=>t.push(x.name)},systemPrompt:{section(){}},get:()=>undefined},m.Config({}));console.log(t.length)})"
```

期望输出 `8`。

## 加一个新的检索源

1. 在 `lib/sources.js` 里写一个适配器，返回统一的记录结构（见同文件已有实现）
2. 把名字加进 `SOURCES`
3. 补一条测试：同一篇在两个源出现时能正确合并

## 加一条新的下载路径

在 `lib/fulltext.js` 里加一个 `fromXxx` oracle，或在 `lib/index.js` 的候选排序里调整信任值。
新路径必须自己判断"拿到的不是预览版"——1 页的 PDF 不算成功。

## 报告问题

请附上：

- `lit_doctor` 的输出（会说明环境缺什么）
- 下载失败时的完整提示（它区分了"要登录""没订阅""要验证"）
- 论文的 DOI（不要贴 PDF 本身）
