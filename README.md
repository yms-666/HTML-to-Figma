# HTML to Figma

Figma 插件：在插件窗口粘贴 HTML/CSS 代码，点击按钮后在画布上递归生成对应的可编辑 Frame 和 Text 图层。

## 构建

```bash
npm install
npm run build
```

开发时可用 `npm run watch` 监听 `code.ts` 变化自动构建。

## 使用

1. 在 Figma 中：Plugins → Development → Import plugin from manifest…
2. 选择本目录下的 `manifest.json`
3. 运行插件，在 textarea 中粘贴 HTML（可含内联样式或基础 CSS），点击「转换为 Figma 图层」

## 测试用 HTML 示例

**简单 div + 文本：**
```html
<div style="padding:16px; background:#f0f0f0; border-radius:8px;">
  <p style="font-size:14px; color:#333;">Hello, Figma</p>
</div>
```

**Flex 横向布局：**
```html
<div style="display:flex; flex-direction:row; gap:8px; padding:16px;">
  <div style="width:60px; height:60px; background:#0d99ff; border-radius:8px;"></div>
  <div style="flex:1;">
    <p style="margin:0; font-size:14px;">Auto Layout 子项</p>
  </div>
</div>
```

**多层嵌套：**
```html
<section style="display:flex; flex-direction:column; padding:20px; background:#fff; border-radius:12px;">
  <h1 style="font-size:18px; color:#111;">标题</h1>
  <div style="display:flex; justify-content:center; align-items:center; padding:12px;">
    <span style="font-size:12px; color:#666;">居中文本</span>
  </div>
</section>
```

在 Figma 中运行插件后，将上述任一段粘贴到输入框，点击「转换为 Figma 图层」即可在画布上看到对应 Frame 与 Text 图层。

## 说明

- 文本统一使用 Inter 字体，避免字体加载错误。
- 图层层级与 HTML 结构一致。
- `<script>` 和 `<style>` 会被忽略。
- 首版不处理 margin，仅支持 padding 与 Auto Layout。
