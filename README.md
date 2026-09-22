# 币安 OI 监测

直接读取 Binance 官方合约 OI、标记价、指数价和美元换算汇率。按币汇总，结合可追溯供应量计算流通市值与 FDV，展示比较图、时间曲线与阈值提醒。

**网站：[GitHub Pages](https://web3kk0713-hue.github.io/binance-oi-monitor/)**

## 两种运行方式

| | GitHub Pages 直连 | 独立后台 |
|---|---|---|
| 数据采集 | 打开的浏览器每分钟直接请求官方接口 | 常驻 Node 服务每分钟采集 |
| 历史 | 本浏览器 IndexedDB，保留30天采到的数据 | 数据库30天历史，可多设备访问 |
| 页内提示 / 系统通知 | 页面运行期间支持，需用户授予通知权限 | 支持 |
| 关闭网页后采集和推送 | **不支持** | 配置 VAPID 后支持 Web Push |
| 数据来源可核查 | 来源面板含请求地址、原始数值及时间 | 同样保留来源证据 |

GitHub Pages 是静态托管，不能运行持续采集进程；GitHub Actions 的 schedule 最小间隔5分钟，不能当作本产品的一分钟采集器。网站默认直连，无后台时会清楚显示运行边界，不会用静态示例或旧快照伪装实时数据。关闭页面、浏览器休眠、断网及接口限流会留下历史缺口。30天是保留窗口，不代表首次打开就有30天分钟数据。

### OI / FDV 历史变化

- 时间范围为 1 小时、24 小时、3 天、7 天、30 天，默认 7 天；保留实际采集的分钟点，不补造上线前历史。
- “涨跌幅”按同一有效起点对齐 OI、流通市值、FDV，避免数值量级差异掩盖变化；可切回美元金额。下图独立展示 OI / FDV 与 OI / 流通市值。
- 变化摘要显示 OI 与 FDV 百分比和美元差额，以及 OI / FDV 的百分点差（pp）。缺少起点、数据过期或分母为零时不伪报涨跌幅；历史不足时注明真实起点，不称为完整 3 / 7 天回报。
- 采集起始分钟用作存储槽；断采不连线。每个历史点固化当时有效金额，后续供应量更新不重算旧 FDV。行情不完整时不记有效点，供应量超过 2 小时或映射未通过时仅保留有效 OI。
- 旧版未记录供应量有效性标记的历史估值，保留原始存储但不再用于曲线或比较；新版本从有效采集点继续积累。直连数据可能被浏览器清理，连续 3–7 天监控仍需实际部署常驻后台。

## 数据和计算

- 范围：Binance 当前交易中的稳定币保证金加密资产永续合约。排除交割、指数、传统资产和币保证金；无需 Binance API key，无交易接口。
- OI：`openInterest × markPrice × quoteUsd`，使用 decimal.js 运算，按可靠身份映射汇总同币不同合约。不会把多空两边再乘二。
- 价格：Binance 指数价，千倍等合约归一到每一枚币，再按 Binance assetIndex 换算美元。
- 流通市值估算：`每币价格 × circulating_supply`。
- FDV估算：`每币价格 × max_supply`。固定最大供应量口径，不直接混用不同供应商的 FDV 字段；没有可靠最大供应量时为缺失。
- 供应量：浏览器直连使用允许跨域读取的 CoinGecko 官方 API；后台对 BTC、ETH、NEIRO、PUMP 优先使用已核实 ID 的 CoinMarketCap 官方 API，其余使用 CoinGecko。每条记录明确标识来源。禁止凭同名或跨平台 slug 自动合并。供应源价格仅作负向一致性检查，偏差超过30%时估值留空、禁报；价格接近本身不是身份证据。供应量按小时刷新，并非每分钟重新审计；身份映射及供应量缺失、受限、陈旧时标记原因。
- 原始数据可以在所选币种的来源面板核查与导出；本项目不将供应商原始数据批量打包为公共数据集。

默认阈值：OI/FDV 达70%黄色、90%红色、100%强提醒。阈值可配置，同级默认30分钟冷却，升级即时提醒。只有完整、时间有效、身份确定且存在可靠FDV的记录可触发提醒。OI/FDV描述仓位名义规模与估值的关系，并非多空方向或保证金金额。

### 官方来源

- [Binance USDⓈ-M market data](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data)
- [CoinMarketCap public API](https://coinmarketcap.com/api/documentation/pro-api-reference/keyless-public-api)
- [CoinMarketCap supply definitions](https://support.coinmarketcap.com/hc/en-us/articles/360043396252-Supply-Circulating-Total-Max)
- [CoinGecko API](https://docs.coingecko.com/reference/introduction)

## 本地启动

需要 Node.js 24 和 pnpm 11。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

打开 `http://127.0.0.1:5178`。构建、测试和真实数据探测：

```sh
pnpm test
pnpm build
pnpm probe
```

`pnpm probe` 直接访问外部数据源，只输出覆盖率、耗时和有限示例，不创建假数据。测试里的固定样本仅用于验证计算和故障边界，不进入生产页面。

## GitHub 发布

推送到 `main` 后，GitHub Actions 自动测试、构建并部署 `dist/`。仓库 Settings → Pages 的 Source 需为 GitHub Actions。构建产物只包含前端，不包含数据库、推送私钥或数据供应商私钥。

## 常驻后台

后端源码在 `server/`，支持 PostgreSQL 及本地 SQLite；部署配置见 `compose.yaml` 和 `.env.example`。必须从目标机器实测 Binance 是否可访问，不能通过地区绕过限制来承诺可用性。

1. 复制 `.env.example` 为 `.env`，配置数据库及允许访问的网页来源。
2. 在目标服务器以 Docker Compose 启动，或使用 Node 24 运行 `pnpm server`。
3. 通过 HTTPS 反向代理公开 API，在网页设置中连接后台地址。
4. 需要关闭网页后推送时，配置服务端 VAPID，并从网页点击启用通知。

不要把 `.env`、数据库、推送订阅地址或私钥提交到仓库。通知订阅是匿名的，浏览器保存删除/更新令牌；后台只允许已知推送服务的 HTTPS 地址，限制来源和调用频率。

Web Push 送达依赖联网、系统通知权限和浏览器后台行为，过期通知可能无法送达；服务端告警记录可以在恢复连接后查看。尚未部署或未配置推送密钥的后台，不会报告推送已启用。

## 技术与许可

React、Vite、ECharts、Fastify、PostgreSQL、decimal.js、idb、web-push。第三方依赖保留各自许可（ECharts Apache-2.0；web-push MPL-2.0），本项目未修改第三方源码。上游完整应用经比较后未采用，参见 `docs/workflow/baseline.md`。
