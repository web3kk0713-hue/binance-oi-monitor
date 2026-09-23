# 实现基线

2026-09-22 用户授权开发、取源头数据并直接部署 GitHub。源头 OI / 价格 / 合约范围来自 Binance 公共官方 API，无交易权限或交易 API key。

- 合约范围：交易中的 USDⓈ-M 稳定币保证金加密资产永续；排除交割、传统资产、指数、币保证金。按可靠资产标识聚合。
- 数据：一分钟 OI、价格及估算流通市值/FDV，小时级供应量。最大供应量口径一致；缺失为 null，禁止零值假象和不可验证告警。
- 页面：中文、响应式；散点总览、USD曲线、百分比曲线、全市场表格、来源抽屉、阈值设置、页内与系统通知。
- GitHub Pages 只能运行前端。直连模式由打开的浏览器每分钟采集，IndexedDB 保存本机30天历史；页面关闭后采集暂停。生产后台接入后提供7x24、跨设备历史和Web Push。未经部署的后台功能不得标为已上线。
- 后台：Node24 + Fastify + PostgreSQL，可独立部署；未获云主机账号/资源前不购买服务。数据库与推送凭证只在服务端。
- UI方向（按用户再次明确的既有规则纠正）：Apple HIG 风格基线，浅色中性导航、清晰系统字体、留白与轻分隔，减少装饰和独立卡片，不采用厚重海军蓝顶栏及黄色品牌装饰。CoinGlass 表格与 TradingView 区间操作仅作功能参考；OI 蓝色、市值青色、FDV 紫色承担数据系列识别，黄红只用于风险。设计参照：https://developer.apple.com/design/human-interface-guidelines/layout 。
- 验收：公式和倍数、缺失/过期、阈值跨越与去重；实际全量采集、浏览器交互、持久化、重启、GitHub构建与部署。模拟只用于明确标注的测试。
- 2026-09-22 追加历史需求：至少保留3–7天 OI 与 FDV 变化。保留窗口仍为30天，新增3天范围，默认7天；共同起点的涨跌幅／美元金额切换，OI与FDV差额、OI/FDV百分点变化及有效分钟覆盖。尚不足所选时间范围时必须明示；未上线常驻后台前不承诺连续3–7天采集。

## 2026-09-23 已确认的短线与视觉迭代

用户确认“5分钟”“最好30S更新”、继续开发并调整主流 UI；沿用已有仓库及 GitHub Pages 发布授权，不新增付费资源或交易权限。此节替代上方一分钟采样及默认7天视图的旧值，旧记录保留供追溯。

- 目标每30秒采集全范围 OI；27秒轮次预算，限流、缺失和过期必须可见，不把目标间隔称为全币种完整性保证。供应量仍为小时级；FDV/流通市值按采样时 Binance 指数价估算。
- 5分钟观察使用真实、同一合约组成的标准化 OI 数量和价格；不从美元 OI 反推数量、不插值、不补造历史。OI/FDV是风险提醒，不是做多/做空指令。
- 新观测保留实际完成时间、源时间、数量和组成。浏览器保存7天30秒观测，此前旧版历史兼容保留，7天之后取每分钟最后一个真实观测至30天；后台另外保存7天合约原始十进制字符串。未常驻运行的时段无数据，绝不回填虚构曲线。
- 选中标的增加 Binance 永续／已核实现货的实时成交与买卖价差观察，只订阅当前标的；连续满5分钟才展示完整窗口的主动买入占比，重连/休眠重新积累。成交观察不等于市场全部成交或交易信号。
- 设计参考：TradingView Screener 的表格/列组与视图切换（https://www.tradingview.com/support/solutions/43000718885-tradingview-screeners-walkthrough/）；Coinbase Advanced 的行情与图表分区（https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/dashboard-overview）；Apple HIG Layout（https://developer.apple.com/design/human-interface-guidelines/layout）。不复刻品牌资产。
- 设计决定：浅色系统字体、紧凑顶部、行情左/曲线右工作台；散点下放“市场分布”，核心/估值/数据列组；手机“行情/标的”切换。正文13–14px、辅助至少11px，蓝色主操作，红绿用于变化方向而非推荐；保留来源、风险、历史缺口和两类通知。
- 当前无已部署常驻后台：GitHub Pages只托管前端。实现和本地后台验收不等于云端7×24服务上线。

## 已锁定接口（增量兼容）

共同TypeScript合同为 src/shared/types.ts。所有时间epoch ms，比例为百分比(72=72%)，金额为USD。

- createCollector(options).collect({signal,onProgress}) -> Snapshot，模块 src/data/collector.ts；浏览器和后台共用。
- GET /api/v1/health -> BackendStatus
- GET /api/v1/snapshot -> Snapshot (未产生有效快照返回503)
- GET /api/v1/history?assetId=...&hours=24 -> HistoryPoint[] (1..720小时)
- GET /api/v1/contracts/:symbol/history?hours=24 -> RawContractPoint[] (1..168小时，后台原始合约字符串)
- GET /api/v1/alerts?limit=100 -> AlertEvent[]
- GET /api/v1/push/key -> {publicKey:string|null}
- POST /api/v1/push/subscriptions -> {subscription:PushSubscriptionJSON,thresholds:Thresholds}; 返回 {id,deleteToken}，token只交还创建者。
- DELETE /api/v1/push/subscriptions/:id 要求 Authorization: Bearer <deleteToken>。
- 后台接口只读行情公开，订阅接口严格验证来源、限速并限制推送目的域名。默认匿名，不含交易功能。

## 代理边界

数据代理: src/data/* 及对应测试。前端代理: src/web/*, public/*。后台代理: server/*, Dockerfile, compose.yaml, .env.example。主代理拥有 shared、工程配置、文档、发布及整体验收。改变共享合同先协调。
