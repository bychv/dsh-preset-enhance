# 分包后保留原安装入口

Status: implemented

已有用户安装的是 `dsh-preset-enhance`，不应为了正文分包改装另一个 npm 包。主包本身已是 DSH bundle，因此直接增加正文包的精确版本运行依赖和 patch 条目即可，无需移动主包源码、改 npm 名称或迁移数据。

保留 `preset-enhance` 与 `preset-display-regex` 条目 ID，用户层的配置和启停 patch 仍可覆盖。显示能力默认不启用替换，生命周期按[开关联动](../feature/2026-10-13-display-regex-plugin-lifecycle.md)处理。组合版本面向 DSH 0.2.1 全系列，不沿用主包历史上对旧宿主的宽泛声明。

`packages/bundle` 作为已有开发入口保留；依赖包不会递归贡献 patch。普通用户只选择主包，开发期同时选择过独立显示入口的 profile 需取消重复入口，不由插件擅自重写宿主配置。

这是对[原拆包边界](2026-10-12-output-regex-package-boundary.md)中安装入口的修订，职责拆分不变。子包先发布、主包后发布，避免升级时版本不存在；本次不发布。

配置及安装说明见[正文正则](../../../../docs/api/DISPLAY_REGEX.md#安装与升级)，验证见[包与生命周期记录](../../../../docs/testing/2026-10-13-PACKAGE_LIFECYCLE.md)。
