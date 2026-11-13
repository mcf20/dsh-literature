# 安装说明（tgz 分发）

这个包是给 **DeepSeek Harness** 用的插件，不能直接当普通 npm 包 `require`——它靠 DSH 的 loader 挂载。

文件：`dsh-literature-0.1.0.tgz`（67 KB）

---

## 一、解包并装依赖

**Windows PowerShell**

```powershell
mkdir $HOME\dsh-literature
tar -xzf dsh-literature-0.1.0.tgz -C $HOME\dsh-literature --strip-components=1
cd $HOME\dsh-literature
npm install
```

**macOS / Linux**

```bash
mkdir -p ~/dsh-literature
tar -xzf dsh-literature-0.1.0.tgz -C ~/dsh-literature --strip-components=1
cd ~/dsh-literature && npm install
```

装完应该有 `node_modules`（约 22 个包）。验证：

```bash
npm test        # 应该 19 项全过
```

---

## 二、挂到 DSH

先确认插件能被加载：

```bash
node -e "import('./lib/index.js').then(m=>{const t=[];m.apply({tools:{register:x=>t.push(x.name)},systemPrompt:{section(){}},get:()=>undefined},m.Config({}));console.log(t.length,'tools')})"
```

期望输出 `7 tools`。

然后在 DSH 里登记（二选一）：

**方式 A：用插件管理器**

```text
plugin_manager  action=install_bundle  target=<上面解包的绝对路径>
```

**方式 B：手改 profile**

编辑 `<DSH_HOME>/profiles/<你的 profile>/package.json`：

```json
{
  "dsh": { "profile": { "bundles": ["...原有...", "dsh-literature"] } },
  "dependencies": { "dsh-literature": "link:/绝对路径/dsh-literature" }
}
```

再编辑同目录的 `cordis.patch.yml`，加一行：

```yaml
- id: literature
  name: dsh-literature
```

重启 DSH。

---

## 三、配置（至少填邮箱）

编辑 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml`：

```yaml
- id: literature
  name: dsh-literature
  config:
    openalexMailto: you@example.com     # 必填，OpenAlex 礼貌池
    unpaywallEmail: you@example.com     # 必填，否则 OA 判定少一路
    # 下面是可选的
    # proxyUrl: http://127.0.0.1:<端口>   # 有代理才填
    # dataDir: ''                       # 空 = ~/.dsh-literature
```

---

## 四、自检

装完先让它自己体检：

```text
跑一下文献插件自检
```

或者直接调 `lit_doctor`。它会逐项报告：Node 版本、数据目录可写、PDF 解析器、Chrome、代理、各密钥、本地库。

**⚠️ 的项目不一定阻断使用**——比如没有 Elsevier key，Elsevier 就自动走 OA/浏览器。

### 可选：密钥（缺了会自动降级）

写进 `<DSH_HOME>/.credentials.yaml` 的 `refs:` 下：

```yaml
refs:
  OPENALEX_API_KEY: 你的key
  NCBI_API_KEY: 你的key
  SEMANTIC_SCHOLAR_API_KEY: 你的key
  ELSEVIER_API_KEY: 你的key
  CORE_API_KEY: 你的key
```

申请入口见 `README.md` 的"凭据"一节。

---

## 五、浏览器通道与登录（可选，但强烈建议）

有些刊物只对"真实浏览器 + 机构 IP"放行，走这条路能自动下：

1. 装 Chrome
2. **什么配置都不用改**——插件会自己起一个独立 profile（`~/.dsh-literature/chrome`），并把它设成"PDF 一律下载"
3. 校园网内运行时，机构 IP 才会生效

第一次用到时会自动起浏览器，约 20 秒。

**需要机构账号时**：让插件打开登录窗口

```text
lit_login url=https://www.sciencedirect.com/     # 或你们图书馆的门户
```

在那个窗口里登录一次即可——插件用的是持久化配置（`~/.dsh-literature/chrome`），
之后所有下载自动复用会话，不会再问。

查当前有哪些站点已登录：

```text
lit_login check=true
```

---

## 六、常见问题

| 现象 | 原因 |
|---|---|
| `7 tools` 变成了别的数字 | 依赖没装全，重跑 `npm install` |
| 检索全空 | 没填 `openalexMailto`，或网络不通 |
| 下载一直 403 | 该刊没订阅；或需要浏览器通道（见第五节） |
| 只下到 1 页 | 出版社只给预览版——订阅刊的常态，工具会拒绝并继续找别的源 |
| 想看它怎么工作 | 读 `WORKFLOW.md`（中文，完整链路） |

---

## 七、许可

MIT。数据（下载的论文）归各自版权方，插件只按你所在机构的订阅权限取用。


