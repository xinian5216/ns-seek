# 隐私说明

## 脚本处理的数据

脚本仅在匹配的 NodeSeek 帖子页中运行，读取楼层作者显示名和公开个人主页链接中的 UID。打开弹窗时显示该名字；只有用户再次点击「同意并查询」，才向 `https://api.xxboxx.de/v1/user?q=uid:…` 发送 UID。

加载页面、注入按钮、打开弹窗、展开更多结果均不触发查询。没有后台批量查询、遥测、自动重试、持久化缓存或浏览记录收集。关闭弹窗时取消请求并清空显示结果；JavaScript 内存回收时机由浏览器控制。此功能不能撤回已经发送的请求。

## 请求保护与剩余风险

- `@connect` 只允许 `api.xxboxx.de`；只有 `GM_xmlhttpRequest` 权限。
- `anonymous: true` 按管理器文档禁止携带目标站 Cookie；不读取论坛 Cookie 或本地存储。
- 不发送论坛帖子 URL、用户名、页面 HTML、浏览器历史或站长密钥；Referer 清空；拒绝重定向。
- IP、所查 UID、请求时间、浏览器网络元数据仍会对 API 及其网络服务商可见。HTTPS 保护传输内容，但无法阻止接收服务记录请求。
- 无法核验第三方数据收集授权、准确性、服务端保存期限或日志行为。脚本不宣称第三方服务符合任何特定隐私标准。
- API 的文本不作为 HTML 执行；仅允许规范的 NodeSeek 帖子链接，外链设置 `noopener noreferrer`。
- 页面其他代码与浏览器扩展仍可能观察页面 DOM；本脚本不提供对恶意页面或恶意扩展的隔离保证。

## 仓库与更新

仅发布源码、文档、合成测试、开发依赖锁文件和 CI 配置。不发布本机路径、个人邮箱、凭据、Cookie、真实账号记录或浏览器配置。GitHub 公开用户名及其仓库归属是项目公开身份，不是匿名发布。

脚本更新由 GitHub 托管，Tampermonkey 自行检查更新。更新检查请求可能向 GitHub 暴露 IP 与常规元数据。原站更新地址不会更新本维护版，但查询服务仍依赖原站。

建议实际验证环境为当前稳定版 Tampermonkey；管理器对匿名请求、Referer、重定向的支持差异应通过浏览器检查。官方语义参考：[Tampermonkey GM_xmlhttpRequest](https://www.tampermonkey.net/documentation.php#api:GM_xmlhttpRequest)、[@connect](https://www.tampermonkey.net/documentation.php#meta:connect)。
