# 实现基线

2026-09-22 用户授权开发、取源头数据并直接部署 GitHub。源头 OI / 价格 / 合约范围来自 Binance 公共官方 API，无交易权限或交易 API key。

- 合约范围：交易中的 USDⓈ-M 稳定币保证金加密资产永续；排除交割、传统资产、指数、币保证金。按可靠资产标识聚合。
- 数据：一分钟 OI、价格及估算流通市值/FDV，小时级供应量。最大供应量口径一致；缺失为 null，禁止零值假象和不可验证告警。
- 页面：中文、响应式；散点总览、USD曲线、百分比曲线、全市场表格、来源抽屉、阈值设置、页内与系统通知。
- GitHub Pages 只能运行前端。直连模式由打开的浏览器每分钟采集，IndexedDB 保存本机30天历史；页面关闭后采集暂停。生产后台接入后提供7x24、跨设备历史和Web Push。未经部署的后台功能不得标为已上线。
- 后台：Node24 + Fastify + PostgreSQL，可独立部署；未获云主机账号/资源前不购买服务。数据库与推送凭证只在服务端。
- UI参考：CoinGlass全市场OI表格和TradingView时间区间操作；使用ECharts散点与曲线功能，设计采用冷白底、海军蓝结构、蓝色OI、青色市值、紫色FDV，警告色只用于告警。系统中文字体与表格等宽数字。紧凑行情工具，无营销大标题。
- 验收：公式和倍数、缺失/过期、阈值跨越与去重；实际全量采集、浏览器交互、持久化、重启、GitHub构建与部署。模拟只用于明确标注的测试。

## 已锁定接口

共同TypeScript合同为 src/shared/types.ts。所有时间epoch ms，比例为百分比(72=72%)，金额为USD。

- createCollector(options).collect({signal,onProgress}) -> Snapshot，模块 src/data/collector.ts；浏览器和后台共用。
- GET /api/v1/health -> BackendStatus
- GET /api/v1/snapshot -> Snapshot (未产生有效快照返回503)
- GET /api/v1/history?assetId=...&hours=24 -> HistoryPoint[] (1..720小时)
- GET /api/v1/alerts?limit=100 -> AlertEvent[]
- GET /api/v1/push/key -> {publicKey:string|null}
- POST /api/v1/push/subscriptions -> {subscription:PushSubscriptionJSON,thresholds:Thresholds}; 返回 {id,deleteToken}，token只交还创建者。
- DELETE /api/v1/push/subscriptions/:id 要求 Authorization: Bearer <deleteToken>。
- 后台接口只读行情公开，订阅接口严格验证来源、限速并限制推送目的域名。默认匿名，不含交易功能。

## 代理边界

数据代理: src/data/* 及对应测试。前端代理: src/web/*, public/*。后台代理: server/*, Dockerfile, compose.yaml, .env.example。主代理拥有 shared、工程配置、文档、发布及整体验收。改变共享合同先协调。
