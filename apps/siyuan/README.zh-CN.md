# 续了么 · Still

> 续费之前，先问你一句：**还在用吗？**

续了么帮你记录所有订阅和免费试用。每次扣费前，它会弹出一张卡片：**续**、**不续了**、还是**再想想**——一键决定。

![续了么](https://raw.githubusercontent.com/suka233/still/main/docs/media/preview.png)

## 能做什么

- **扣费前提醒**：默认提前 3 天和 1 天，免费试用转正前也会提醒；同一天的提醒等到你设定的时间再出现。
- **「续了么」决策卡**：显示这次扣多少、到目前为止大约已付多少。点「不续了」会标记取消，并给你撤销和「去取消」的快捷入口。
- **窗口关了也不会漏**：提醒由思源内核插件计算；配置推送渠道后，即使没开窗口也能推送到手机——Bark、ntfy、Telegram、Server 酱（微信）、企业微信、钉钉、飞书、Discord、Slack、Gotify、Webhook。
- **侧栏一眼看清**：本月还要付多少、哪些在等你决定、接下来谁要扣费；状态栏显示最近的一笔。
- **管理页**：月均与年度支出、已省下多少、未来 6 个月预测、日历、分类洞察。
- **90+ 常用服务**，带品牌图标，搜索即添加。
- **多币种**，按汇率合并计算。
- **八套主题**：五种小票风格——热敏（默认）、精品店、票根、孔版印刷、极简——加上静谧、卡片墙、时间线，都支持浅色和深色。
- **思源特色**：扣费和「不续了」可自动写进日记；输入 `/续了么` 插入订阅概览表；思源 AI 智能体可以直接查询你的订阅。
- 订阅和续费决策支持离线保存、JSON 导入导出，以及可选的 Supabase 双向同步。

## 动图演示

| 添加订阅 | 续了么？ |
|---|---|
| ![添加订阅](https://raw.githubusercontent.com/suka233/still/main/docs/media/still-add-subscription.zh-CN.webp) | ![续了么](https://raw.githubusercontent.com/suka233/still/main/docs/media/still-decide.zh-CN.webp) |
| **再想想** | **主题** |
| ![再想想](https://raw.githubusercontent.com/suka233/still/main/docs/media/still-snooze.zh-CN.webp) | ![主题](https://raw.githubusercontent.com/suka233/still/main/docs/media/still-themes.zh-CN.webp) |
| **日历与洞察** | **在笔记里插入概览** |
| ![日历](https://raw.githubusercontent.com/suka233/still/main/docs/media/still-calendar.zh-CN.webp) | ![斜杠命令](https://raw.githubusercontent.com/suka233/still/main/docs/media/still-slash.zh-CN.webp) |

## 使用

1. 点右侧 Dock 的续了么图标打开侧栏，点「添加」，搜索服务或手动填写。
2. 到期前会弹出决策卡；没处理的会留在侧栏「等你决定」里。
3. 顶栏图标或命令面板「续了么：打开订阅管理」进入管理页；推送渠道、主题、提醒时间都在「设置」里。

需要思源 3.8.5 及以上版本。

## Supabase 双向同步

1. 在 Supabase 项目应用仓库 `supabase/migrations` 中的 `still_rxdb_sync` 迁移。在 Authentication 中启用邮箱密码登录，并创建一个已确认邮箱的账号。
2. 在思源「续了么 → 设置 → Supabase 远程同步」填写项目 HTTPS URL、Publishable Key（或旧版 anon Key）、该账号的邮箱和密码。点「一键测试连接」，再开启远程同步并保存。其他设备使用同一个 Supabase Auth 账号。
3. 同步在插件前端运行时自动推送订阅和续费决策的改动。默认每 60 秒拉取，也可点「立即同步」。启动插件、浏览器恢复联网或思源发出 `sync-end` 事件时也会拉取。离线改动会在重连后补传，同一记录以 `updatedAt` 的混合逻辑时钟版本判定胜负。删除通过 `deletedAt` 同步。

首次加载会把旧的 `data/storage/petal/still/` 数据复制到 `conf/still/records-v1.json`。内核使用该文件提供后台提醒和日记；前端使用 RxDB/Dexie（IndexedDB）保存复制数据和同步检查点。订阅、续费决策、汇率缓存和投递记录继续写入该本机文件。普通设置和推送/日记配置会迁移到思源官方插件数据目录 `data/storage/petal/still/` 下的 `settings-v2.json`、`notifications-v2.json`，随思源同步；同步后的设置会被内核重新读取，无需重启。迁移前的完整文件另存为 `conf/still/before-settings-migration-v2.json`，旧的独立 JSON 文件也保留以便回退。关闭所有思源前端时，内核继续使用上次保存的数据，远程同步在前端重新打开后继续。

## 隐私

远程同步默认关闭。启用后，仅订阅及续费决策发送到你配置的 Supabase 项目。外观、提醒偏好、推送渠道及日记配置使用思源插件数据存储，随思源同步；其中可能包含推送渠道的凭据，请使用可信的思源同步空间。汇率缓存及提醒投递记录保存在本地。Supabase 连接参数（项目 URL、Publishable/anon Key、邮箱、账号标识和同步偏好）单独保存于 `supabase-connection-v1.json`，通过 `saveData/loadData` 随思源同步，并自动迁移旧的本机配置。Supabase 按 Auth 用户隔离记录；每台设备需要单独登录，登录会话只保存在该设备，密码只用于登录。汇率换算使用公开接口（open.er-api.com / Frankfurter），可以在设置中关闭。

## 开源

MIT · [github.com/suka233/still](https://github.com/suka233/still)
