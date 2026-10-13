# DSH 预设组合包（兼容入口）

开发期组合入口，直接注册 `dsh-preset-enhance` 与 `dsh-preset-display-regex` 两个运行条目。现在主包本身也携带正文包；新安装和已有主包升级均使用 **dsh-preset-enhance**，不需要换装本包。

此包保留现有布局和条目 ID。依赖包的 bundle patch 不递归展开，不会因主包也声明正文包而重复装配。不要在同一 profile 同时选择多个入口。

目前子包尚未发布，开发验证须先用本地构建快照满足依赖。正式发布按正文包、主包、兼容组合入口的顺序，版本及精确依赖一起更新。入口源码在 `src/index.mts`，发布产物由根目录构建生成。详见[安装与升级](../../docs/api/DISPLAY_REGEX.md#安装与升级)。
