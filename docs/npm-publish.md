# NPM 打包与发布流程

本流程只使用官方 registry：`https://registry.npmjs.org/`。
所有命令在仓库根目录执行。

## 1. 设置本次任务的 NPM 参数

```bash
export NPM_REGISTRY="https://registry.npmjs.org/"
export npm_config_cache="${PWD}/.npm-cache"
```

## 2. 检查登录状态

```bash
npm whoami --registry "$NPM_REGISTRY"
```

- 退出码为 `0`：已经登录，继续第 3 步。
- 退出码非 `0`：进入第 2.1 步，不得发布。

### 2.1 登录失效时启动网页登录

```bash
npm login \
  --registry "$NPM_REGISTRY" \
  --auth-type=web
```

将该命令作为后台任务运行并记录 job id。读取输出中的完整链接：

```text
https://www.npmjs.com/login?...
```

把链接发给用户，然后使用问题选项询问「是否已完成 NPM 网页授权」。用户确认后，再读取后台任务结果：

- 退出码为 `0`：继续；
- 退出码非 `0`：停止并报告错误；
- 用户未确认前不得继续。

## 3. 登录后再次确认身份

```bash
npm whoami --registry "$NPM_REGISTRY"
```

只有退出码为 `0` 才能继续。

## 4. 测试

```bash
npm test
```

测试失败时停止，不得发布。

## 5. 预览发布包

```bash
npm pack --dry-run
```

确认发布清单后继续。发布包不应包含测试、调研资料或临时文件。

## 6. 启动后台发布任务

```bash
npm publish --registry "$NPM_REGISTRY"
```

将该命令作为后台任务运行并记录 job id。读取输出：

- 任务成功：继续第 7 步；
- 输出 `Authenticate your account at:` 和 `https://www.npmjs.com/auth/cli/...`：把完整链接发给用户，并使用问题选项询问「是否已完成 NPM 发布授权」；用户确认后再读取任务结果；
- 返回 `EOTP` 且没有授权链接：停止自动发布，告知用户需要在自己的终端使用 `--otp` 或 Automation Token 完成发布。

不得读取、打印或索要 `.npmrc`、NPM token 或其他长期凭据。

## 7. 验证发布结果

```bash
PACKAGE_NAME="$(node -p "require('./package.json').name")"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"

npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" version \
  --registry "$NPM_REGISTRY"
```

只有输出版本号等于 `package.json` 中的版本号，才算发布成功。NPM 发布成功前不得关闭对应的 GitHub Issue。
