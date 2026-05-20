# 🤝 贡献指南

> **注意**：本项目为个人学习/测试用途。以下指南仅供参考。

## 如何贡献

### 报告 Bug

1. 确认该 bug 没有被 [issues](https://github.com/your-username/pi-rp-framework/issues) 记录过
2. 使用 [Bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.md) 提交
3. 尽可能详细地描述复现步骤和环境信息

### 提功能建议

1. 使用 [功能建议模板](.github/ISSUE_TEMPLATE/feature_request.md)
2. 说明你的使用场景和期望的解决方案

### 提交 PR

1. Fork 本仓库
2. 创建特性分支: `git checkout -b feat/your-feature`
3. 确保 `node setup.mjs` 能正常运行
4. 提交 PR，描述你的改动

## 开发指南

### 目录总览

| 目录 | 用途 | 需要改动？ |
|------|------|-----------|
| `worldbook_clean/` | 世界书源文件（编辑入口） | ✅ 添加角色/设定 |
| `.pi/extensions/rp-engine.ts` | 核心引擎 | ⚠️ 改引擎逻辑 |
| `.pi/extensions/rp-web/` | 前端页面 | ⚠️ 改 UI |
| `.pi/APPEND_SYSTEM.md` | 输出风格规范 | ⚠️ 改格式要求 |

### 开发流程

```bash
# 1. 克隆
git clone https://github.com/your-username/pi-rp-framework.git
cd pi-rp-framework

# 2. 安装依赖
npm install ws

# 3. 修改世界书（worldbook_clean/ 下编辑）
# 4. 重新生成
node setup.mjs

# 5. 启动测试
pi

# 6. 打开浏览器访问 http://localhost:3012
```
