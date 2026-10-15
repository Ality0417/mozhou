# 墨舟 · AI 小说工作台

面向中英文长篇创作的本地优先工作台。支持规划、写章、审稿、有限轮次修订、作者确认与导出。

## 本轮目标

- 书籍级中文／英文写作配置，以及语言相关的字数统计与模型提示。
- 可配置的通用投稿档案和 TXT、Markdown、DOCX、EPUB 导出；默认不夹带内部创作备注。
- AI 提取的事实先待确认，作者决定是否纳入后续创作。
- 自动修订共享轮数上限，避免不同任务反复重写同一章。
- 无模型密钥时可进入本地编辑；模型生成另需配置可用服务。

“多平台”指可配置写作／导出规范，并非已接入所有国家的小说平台，也不自动发布。平台投稿、AI 内容披露和版权规则须由作者在投稿前自行核对。

## 本地开发

环境：Node.js 24、pnpm 10.34.5（packageManager 已固定）。

```sh
git clone https://github.com/Ality0417/mozhou.git
cd mozhou
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

本地应用采用 Electron、React、TypeScript、Express 服务与 SQLite。数据保存在应用用户目录，请先备份再进行升级或迁移，不要将数据库、API 密钥或个人书稿提交到 GitHub。

## 检查与构建

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm db:smoke
node scripts/mozhou-smoke.mjs
pnpm audit --prod --audit-level=high
```

Windows 打包：`pnpm dist:win`。仅有构建成功不等于在 Windows 实机完成验收。本分支自动更新已关闭，避免误装上游发布包。

## 使用新能力

1. 无密钥时，在首次引导选择“先本地体验（无需 API Key）”，可建书、编辑和导出；AI 按钮仍需可用模型。
2. 在书籍工作区“设定”内保存本书的创作语言、章节目标和投稿档案。语言修改会重新统计当前正文，历史贡献不改写。
3. 在章节待确认列表确认或拒绝 AI 提取事实；只有确认项进入已确认事实上下文。
4. 导出预览核对章节与字数。灵感／内部备注默认不导出，需要时主动勾选。通用档案不是任何国家平台的官方规则。
5. 自动改稿共享每章两轮额度，失败也占额度；额度用完后保留当前稿并交给作者处理，不限制人工修改。

## 模型与效果

在设置中配置自己的模型服务。使用远程模型时，相应上下文会发送给该服务商，请先确认作品和资料的使用权限。不要把密钥贴在 issue、日志或代码中。

此阶段“打磨”指提示词、流程、书稿保护与回归测试，不代表已经训练模型。离线模拟和固定样例只能验证程序流程，不能证明真实小说文笔、平台通过率或收益。真实模型质量需另做样章评测。

## 文档与许可

- [本轮验证记录](docs/MOZHOU-VERIFICATION.md)
- [上游中文说明（历史参考）](docs/UPSTREAM-README.zh.md)
- [来源说明](THIRD_PARTY_NOTICES.md)
- [MIT 许可证](LICENSE)

旧文档内的历史版本、个人环境、测试数字与发布记录属于上游，不是墨舟的验收结果。
