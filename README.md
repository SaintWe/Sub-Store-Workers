## Sub-Store Workers 部署

项目使用到 [Cloudflare Workers Serverless](https://workers.cloudflare.com/) 以及 [Cloudflare D1 Serverless SQL databases](https://developers.cloudflare.com/d1/)，感谢 Cloudflare

## 部署

其中前序步骤由您自行完成，以下是关键步骤

1. 获取 Cloudflare API Token
2. 创建 Cloudflare D1 数据库
3. Fork 此仓库
4. 设置 Git Repository secrets
5. 启用 Actions
6. 完成部署

### 0x1 获取 Cloudflare API Token

[点击打开](https://dash.cloudflare.com/profile/api-tokens) 此页面，-> 创建令牌 -> 编辑 Cloudflare Workers 使用模板 -> 帐户资源 以及 区域资源 根据您的需要进行设置 -> 继续以显示摘要 -> 创建令牌

**将令牌保存以供后续步骤使用**

### 0x2 创建 Cloudflare D1 数据库

[点击打开](https://dash.cloudflare.com/) 此页面，进入 Workers 和 Pages -> D1 -> 创建数据库 -> 仪表盘

设置一个数据库名称例如：`sub_store`

地理位置根据您的需要选择

创建完成后保存 **数据库名称** 以及 **数据库 ID** 以供后续步骤使用**

### 0x3 Fork 此仓库

如题

### 0x4 设置 Git Repository secrets

在您 Fork 后的仓库 -> Settings -> Secrets and variables -> Actions -> new repository secrets

重复上述步骤将以下 3 项依次添加

- name 填入【 CLOUDFLARE_API_TOKEN 】secrets 填入第一步获取的令牌
- name 填入【 DATABASE_ID 】secrets 填入第二步获取的数据库 ID
- name 填入【 DATABASE_NAME 】secrets 填入第二步获取的数据库名称

### 0x5 启用 Actions

在您 Fork 后的仓库启用 Actions，随后手动运行工作流

### 0x5 完成部署

如不出意外的话，回到 [此页面](https://dash.cloudflare.com/) 进入 Workers 和 Pages 即可看到已创建的应用

您可以在此处获取到您的 sub-store-workers 地址也就是后端地址

或您亦可自行绑定域名

### 0x6 设置身份认证

在 Workers 和 Pages 应用的设置中配置环境变量

- `BEARER_TOKEN` 为 HTTP Bearer Token，前后端通信认证使用
- `D_TOKEN` 为您从 sub-store-workers 后端获取和预览节点的认证

若未配置上述环境变量，则任何人在得知后端地址的情况下均有权访问和编辑

设置 **D_TOKEN** 后，前端会自动处理预览以及获取节点的认证，您不会有任何感知

## 前端

- **Vercel**：<https://sub-store-workers.vercel.app>
- **Cloudflare Pages**：<https://sub-store-workers.pages.dev>

上述 2 个由我构建，推荐您审查代码然后使用 [SaintWe/Sub-Store-Front-End](https://github.com/SaintWe/Sub-Store-Front-End) 自行构建

### 前后端连接

**您可在前端 [我的] 页面填入后端地址以及其他参数**，或使用 url 传入，例：

- https://sub-store-workers.vercel.app?api_url=https%3A%2F%2Fgithub.com&bearer_token=111222333444&d_token=555666777888
- https://sub-store-workers.vercel.app?api=https%3A%2F%2Fgithub.com&token=111222333444&d_token=555666777888

*您设置后端地址以及其他内容均保存在浏览器中，清理浏览器或导致您需重新填写*

*将 URL 保存为书签方便多设备使用*

### 参数解析

以下内容非必须，您可以全部使用，或使用部分：

- `api_url` 或 `api` 为后端地址
- `bearer_token` 或 `token` 为 HTTP Bearer Token，前后端通信认证使用
- `d_token` 为您从 sub-store-workers 后端获取和预览节点的认证

**请注意进行 Url 编码**

## 结束语

- 感谢 [@Peng-YM](https://github.com/Peng-YM/Sub-Store) 以及所有参与的大佬的无私的奉献
