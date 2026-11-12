# 配置存储迁移完成

普通设置与通知/日记配置从 conf/still/records-v1.json 迁移到官方 petal 数据目录 settings-v2.json、notifications-v2.json。内核使用文件 API 访问官方目录，确保无前端窗口时可用。已有官方设置优先，迁移前完整备份保留在 conf/still/before-settings-migration-v2.json。

Supabase 连接参数单独通过 loadData/saveData 保存到 supabase-connection-v1.json，白名单过滤字段；旧 localStorage 迁移成功后移除。认证会话留设备本地。订阅和决策保持原有 RxDB/Supabase 数据路径，避免双重同步覆盖。onDataChanged/sync-end 重新加载配置。

验证：两份 TypeScript 检查通过；6 项配置迁移测试通过；实际 Postgres/RxDB 往返测试通过；真实 goja 内核场景通过；生产构建成功，apps/siyuan/package.zip 已生成。尚未安装到用户思源、推送或发布。

用户要求提交：将本次配置存储迁移、回归测试和文档一起提交到本地 Git；不推送。提交前 git diff --check 通过。
