# Cの炼金工坊维护规则

## 工作目录与发布范围

- 独立工作目录为 `E:\STscript\c-alchemy-workshop`，后续在本目录维护，不再回旧tavern13副本修改。
- 用户已指定本目录持续维护，使用Git管理版本；除非另行要求，不另建版本目录。
- 仓库为 `https://github.com/ClameCyrus/c-alchemy-workshop`；显示名称 `Cの炼金工坊`，作者 `ClameCyrus`。
- 唯一对外提供的安装方式是酒馆填写仓库链接安装。不维护Release、ZIP、下载附件、打包脚本或Actions下载artifact。
- 保留并提交酒馆实际加载的 `dist/` 和第三方许可，不能只上传源码。

## 文档规则

- README只保留参照 `ClameCyrus/tavern-chat-bubbles` 的许可介绍、LICENSE链接和原样传播提醒，不添加功能、教程、更新日志、测试记录。
- LICENSE使用指定参考仓库的原文，不自行改写许可条款；保留第三方许可。
- 需求在 `docs/需求参考.md`，开发和Actions说明在 `docs/开发与发布.md`，验证记录在 `VERIFICATION.md`。
- 界面文案简短，使用实际预设名称，不添加重复说明和常驻颜色图例。

## 开发与验证

- 本目录独立安装依赖与维护锁文件，不能借用旧工作区node_modules或测试工具。
- 数据读写改动验证字段保留、复制默认关闭、删除确认、冲突和失败恢复。
- TypeScript与Vue；核心直接使用SillyTavern接口，不依赖酒馆助手或另外两款扩展。
- 保留预设和正则未知字段，禁止有损转换保存；不广播CHAT_CHANGED刷新列表。
- 分组冲突由用户选择；清理必须确认并保留备份，不删除条目和正则。
- 仅扩展名称使用指定在线字体851 GBai Marker，正常字重；不全局改变酒馆字体。
- Live检查使用已连接的Chrome DevTools，保持酒馆助手监听关闭；不擅自安装、刷新或覆盖正在运行的扩展。

## GitHub Actions

- 推送main和PR触发检查，PR不写仓库；手动触发只允许main发布构建产物。
- 检查通过的main提交才可更新dist，使用自动GITHUB_TOKEN和contents:write，不要求个人Token。
- 不生成Release、ZIP、下载artifact，不自动修改版本号或移动tag。
- main已前进时不覆盖新提交；禁止强制推送。
