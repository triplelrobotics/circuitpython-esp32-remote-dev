请继续开发当前打开的 CircuitPython Remote VS Code Extension。

先检查 package.json、src/extension.ts、README.md 和当前目录结构，不要立刻改代码；先总结当前实现。

项目现状：
- Extension 名称：CircuitPython Remote
- publisher/author：triplelrobotics
- 当前版本：0.0.1
- 定位：轻量级、只解决 CircuitPython 无线文件编辑
- 已完成通过 mDNS 浏览 _circuitpython._tcp.local
- 已能发现设备并显示：
  ESP32-S3-DevKitC-1-N8R8
  cpy-devkitc_1_n8r8-f412fae3af2c.local
  192.168.1.100:80
- GET http://192.168.1.100/cp/version.json 已验证成功
- 当前状态栏的显示方式已经满意，不要修改

下一步：
实现 VS Code 左侧的远程设备文件树，通过 CircuitPython Web Workflow 的 /fs/ API 加载 ESP32 上的目录和文件。

暂时只实现：
1. 选择已经发现的设备
2. 在 Activity Bar / Explorer 中显示远程文件树
3. 支持刷新
4. 正确处理 Web Workflow 密码认证和网络错误

暂时不要实现：
- 串口功能
- REPL
- 固件烧录
- 项目模板
- AI 功能
- 复杂配置界面
- 文件保存上传

约束：
- 保持实现轻量
- 不要无故添加依赖
- 修改后运行 npm run compile
- 暂时保持 version 为 0.0.1
- 每次改动前先解释准备修改哪些文件