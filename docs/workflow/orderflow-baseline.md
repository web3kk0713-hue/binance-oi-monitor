# 异常事件监控：已确认实施基线

2026-09-23 用户在研究结论后明确“开始”。本轮沿用既有源头数据、GitHub 前端发布及已批准技术栈，不购买云资源，不开启交易权限，不改机器级服务。

## 范围和交互

- 全市场 USDⓈ-M 加密资产永续的异常事件；现货对照只使用明确核实的同币 USDT 市场。
- 首屏为异常列表，选中事件联动 1m/5m K 线、成交气泡、主动成交差/CVD、原始 OI 数量；估值旧功能保留为独立视图。
- 大额聚合成交、持续买卖压力、放量突破/跌破、价量背离、盘口变薄。所有规则标记实验性，不输出做多/做空指令或胜率。
- 页内醒目提醒与已授权系统通知；合并、冷却、过期和断流抑制；不请求自动化工具授予 OS 权限。
- 至少7天事件与分钟证据保留。已有OI/FDV历史规则不变。历史不足、缺失或盘口只覆盖选中交易对必须可见。

## 数据合同

`src/shared/flowTypes.ts` 为唯一接口合同。交易价格及金额保持交易对原生报价币，禁止 USDT/USDC 默认为 USD 后混加。所有时间 epoch ms。

- `src/shared/orderflow.ts`: `createFlowEngine()` 提供 `setMarkets(markets)`、`setConnected(keys,connected,now)`、`ingestCandle(candle)`、`ingestTrade(trade)`、`ingestQuote(quote)`、`ingestOi(oi)`、`ingestDepth(depth)`、`invalidateDepth(key)`、`metrics(now)`、`events()`、`hydrateEvents(events)`、`history(key,from,to)`、`drainUpdates()`。所有事件通过 `FlowUpdate` 输出。无网络或持久化依赖。
- `src/data/flowFeed.ts`: `createFlowFeed(options)` 提供 `start():Promise<void>`、`stop():Promise<void>`（等待在途及末批写入）、`updateSnapshot(snapshot):void`、`selectMarket(key|null):void`、`snapshot():FlowSnapshot`、`history(key,from,to):FlowHistory`、`hydrateEvents(events)`。前后端共享源头流与分析，不复制规则。
- 后台新增只读 GET `/api/v1/flow/snapshot`、`/api/v1/flow/events?marketKey=&limit=100&before=`、`/api/v1/flow/history?marketKey=&hours=24&to=`；`FlowHistory` 返回范围内实际证据，空缺不插值。最多168小时。
- 前端 `useFlowMonitor(settings,snapshot)` 返回 `{data,error,selectMarket,history,refresh}`；history异步 `(marketKey,hours,to?)=>Promise<FlowHistory>`。`FlowDashboard` props 为 `{settings,snapshot,onOpenSettings}`，内部调用该hook。

## 方法与性能

- 逐笔/分钟K线连续接收；OI目标30秒采样。全市场连接分片、重连退避、断流状态、有限内存、按秒汇总发布React更新。
- 官方目录包含中文币名、单字符资产及 U 报价，校验允许 Unicode 字母/数字/下划线并对网络参数编码，不按 ASCII 或两字母下限静默漏标的。范围变化重建合约连接分片，避免暂停后重新上市导致重复订阅。
- 1m REST历史提供完整OHLC、成交量和主动买量，启动先初始化重点市场，再限速预热其他市场；未完成5分钟数据不触发方向事件。
- 放量基准取当前窗口之前最多60个完整非重叠5m窗口的中位数，至少12个完整窗口。历史越界、未收盘和未来数据不得参与。
- 大额成交阈值取实际接收的有界近期聚合成交样本，标明样本数，不冒称完整7天分位数；样本不足只展示，不触发高优先提醒。样本窗口、固定最低金额和冷却写入规则版本。
- 当公开数据无法归因主体或开平仓，不使用“庄家出货”“鲸鱼开多”。标准盘口只代表公开可见深度，不能证明撤单意图。
- 现有 ECharts 支持 K 线和联动子图，不新增完整交易终端依赖。仪表盘技能用于证据与布局验收，不将实时产品迁移为静态数据快照模板。

## 视觉决定

参考 ATAS 大额成交过滤、Bookmap Market Pulse 异常筛选、Coinalyze 分开现货/合约成交差。沿用已批准 Apple HIG 克制浅色风格；系统字体，正文13–14px，蓝色交互，红绿只表示成交方向，少卡片、轻分割。

色板：背景 #f7f8fa，内容 #ffffff，正文 #24292f，次要 #68717d，蓝 #0875e1，边线 #e5e8ed；买卖辅助 #16866b / #c93646。

布局：顶部紧凑导航；左侧事件流约30%，右侧图表与指标约70%；手机上下排列并可切换。事件详情是证据面板，不添加营销大标题或综合胜率分数。

参考（2026-09-23核对）：https://help.atas.net/en/support/solutions/articles/72000602332-big-trades ; https://bookmap.com/knowledgebase/docs/Addons-Market-Pulse ; https://coinalyze.net/coinalyze-custom-metrics.pdf ; https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market

## 验收与边界

公式、无前视、重连/去重/缺口、冷却、后台读写/重启、7天保留、真实浏览器数据/图表/事件选择及移动布局。规则收益尚未验证；回放结果仅描述随后价格，不计为实盘收益。

GitHub Pages不承载数据库。未提供可部署云资源前，本机后台验证不等于7×24云端上线。操作系统通知送达、PostgreSQL生产运行及7天长跑须分别记录验证状态。
