# 来源与许可

基础脚本：**NS 管理记录快捷查看 0.5.0**。

- 来源：https://api.xxboxx.de/ns-seek.user.js
- 获取日期：2026-10-16（Asia/Hong_Kong）
- 原文件 SHA256：`9112108294d8b60c442d1b349f22e2912b86398b57391d75b7b86e7c6b8ee7d7`
- 原元数据声明：`@license MIT`。
- 原文件未提供 `@author` 或版权人名称；本仓库不推测作者身份。

本版本保留楼层按钮与弹窗查询的用途，重写请求、渲染与交互处理，增加安全渲染、取消、限速处理、测试与独立更新地址。1.0.0 曾使用上游 v1 接口；1.1.0 起已移除第三方查询依赖，改为使用浏览器当前登录状态读取 NodeSeek 站内分页记录。

站内接口的字段、分页和操作格式参考 [Nodyssey 的实际实现](https://github.com/5151561/nodyssey/blob/7eccd05bc45093dbf2fe31671ebd32979a0c6aee/shared/src/commonMain/kotlin/io/github/nodyssey/data/RulingRepository.kt)，该实现说明依据站点自己的 ruling 脚本（2026-08-02）核对。此处仅参考接口契约，自行编写 JavaScript，没有引入客户端代码或运行站点脚本。每页 20 条、最多 100 页及普通登录账号可读的行为尚需在当前真实登录环境验证；不是论坛提供的稳定 API 承诺。

本仓库 LICENSE 保留 MIT 完整许可文本，并为新增修改标注维护者版权。该标注不主张上游原作的版权。

`jsdom` 仅用于开发测试，不会打包到油猴脚本；其依赖许可随 npm 包提供。GitHub Actions 官方组件与 Gitleaks 仅用于 CI。
