## 上一轮完成
- 2b 浮动对象全部完成，含审查修复：分支 feat/floating-objects-2b（4d0eff0），已推送。
- 测试：server 45 OK、selftest 76/76、e2e 95/95；真实会话验收通过，验收副本已删除。

## 关键结论
- 审查修复：
  - C1：图标面板隐藏后，输入框里留下的文字会让页面永远不刷新。
  - I1：Claude 画的箭头（旋转过、缺 data-shape 或 viewBox 不符）改为按外框移动。
  - I2：在旧 deck 里"让 Claude 画"时，先补上对象样式；ppt.md 允许 Claude 补这四行规则。
  - I3：冲突后重放的用户操作不再触发 lint。
  - M4：超限的请求体分块丢弃，不再整体缓存在内存里。
- 延后的小问题：
  - M1：没有 id 的对象可以拖动，但保存失败；
  - M2：旋转过、又缺 px 尺寸的对象，一移动就变大；
  - M3：非 deg 单位的旋转在第一次移动时丢失；
  - M5：静态文件没有加 nosniff；
  - M6：改字时插入对象，改字模式不退出；
  - M7：焦点在图标搜索框里时，Esc 关不掉面板。
- 2a 遗留的时序问题：Claude 回执若早于快照，撤销标签会写成"Claude 修改"。

## 改动文件
- ppt/ops.js geom.js toolbar.js editor.js editor.css server.py template.html icons.js icons-zh.js vendor/LICENSE-lucide；tools/build_icons.py；tests/e2e.mjs；selftest；test_server；ppt.md；spec

## 当前 blocker
- 等用户在 finishing 菜单里选：合并到 main / 开 PR / 先保留。

## 下一步
- 按用户的选择处理分支；然后是手绘草图 → 知识库 → 导出 pptx。
