## Sub-Store Workers 部署

**版权声明：作者为 [Peng-YM](https://github.com/Peng-YM) 以及 [所有参与贡献的大佬们](https://github.com/sub-store-org/Sub-Store/graphs/contributors)，由本人修改适配 Cloudflare Workers**

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

重复上述步骤将以下内容依次添加

- name 填入【 `CLOUDFLARE_API_TOKEN` 】secrets 填入第一步获取的令牌
- name 填入【 `DATABASE_ID` 】secrets 填入第二步获取的数据库 ID
- name 填入【 `DATABASE_NAME` 】secrets 填入第二步获取的数据库名称
- name 填入【 `BEARER_TOKEN` 】secrets 您随机生成一个大小写字母+数字的组合填入，为 HTTP Bearer Token，前后端通信认证使用
- name 填入【 `D_TOKEN` 】secrets 您随机生成一个大小写字母+数字的组合填入，为您从 sub-store-workers 后端获取和预览节点的认证

### 0x5 启用 Actions

在您 Fork 后的仓库启用 Actions，随后手动运行工作流

### 0x5 完成部署

如不出意外的话，回到 [此页面](https://dash.cloudflare.com/) 进入 Workers 和 Pages 即可看到已创建的应用

您可以在此处获取到您的 sub-store-workers 地址也就是后端地址，workers.dev 的地址在大陆地区可能访问异常，推荐您自行绑定域名

## 前端

- **Vercel**：<https://sub-store-workers.vercel.app>
- **Cloudflare Pages**：<https://sub-store-workers.pages.dev>

上述 2 个由我构建，但在大陆地区可能访问异常，推荐您审查代码然后使用 [SaintWe/Sub-Store-Front-End](https://github.com/SaintWe/Sub-Store-Front-End) 自行构建绑定自己的域名

### 前后端连接

**您可在前端 [我的] 页面填入后端地址以及其他参数**，或使用 url 传入，例：

- https://sub-store-workers.vercel.app?api_url=https%3A%2F%2Fgithub.com&bearer_token=111222333444&d_token=555666777888
- https://sub-store-workers.vercel.app?api=https%3A%2F%2Fgithub.com&token=111222333444&d_token=555666777888

*您设置后端地址、Bearer Token 以及 D Token 均保存在浏览器中，清理浏览器或导致您需重新填写*

*将 URL 保存为书签方便多设备使用*

### 参数解析

- `api_url` 或 `api` 为后端地址
- `bearer_token` 或 `token` 为 HTTP Bearer Token，前后端通信认证使用
- `d_token` 为您从 sub-store-workers 后端获取和预览节点的认证

**请注意进行 Url 编码**

## 结束语

- 感谢 [淮城一只猫 @JaxsonWang](https://github.com/JaxsonWang) 在移植过程中提供的帮助
- 感谢 [@Peng-YM](https://github.com/Peng-YM/Sub-Store) 以及所有参与的大佬的无私的奉献
