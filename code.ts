/// <reference types="@figma/plugin-typings" />
/**
 * HTML to Figma 插件主线程
 * 监听 UI 发来的 Node Tree，递归在画布上创建 Frame / Text 图层
 */

// ---------------------------------------------------------------------------
// Node Tree 类型约定（与 ui.html 序列化结构一致）
// ---------------------------------------------------------------------------
interface RGB {
  r: number; // 0-255
  g: number;
  b: number;
  a: number; // 0-1
}

interface SerializedStyles {
  display?: string;
  flexDirection?: string;
  justifyContent?: string;
  alignItems?: string;
  width?: number | null;
  height?: number | null;
  paddingTop?: number | null;
  paddingRight?: number | null;
  paddingBottom?: number | null;
  paddingLeft?: number | null;
  marginTop?: number | null;
  marginRight?: number | null;
  marginBottom?: number | null;
  marginLeft?: number | null;
  backgroundColor?: RGB | null;
  color?: RGB | null;
  borderRadius?: number;
  fontSize?: number;
  fontWeight?: string;
  fontFamily?: string;
  gap?: number | null;
  flexGrow?: number;
  textAlign?: string;
}

interface SerializedNode {
  type: 'root' | 'element' | 'text';
  tagName?: string;
  textContent?: string;
  styles?: SerializedStyles;
  children?: SerializedNode[];
}

// ---------------------------------------------------------------------------
// 字体加载（默认 Inter Regular）
// ---------------------------------------------------------------------------
let fontsLoaded = false;
const defaultFont = { family: 'Inter', style: 'Regular' };

async function ensureFontLoaded(): Promise<void> {
  if (fontsLoaded) return;
  await figma.loadFontAsync(defaultFont);
  fontsLoaded = true;
}

// ---------------------------------------------------------------------------
// 颜色：CSS 0-255 RGB -> Figma 0-1
// ---------------------------------------------------------------------------
function toFigmaColor(c: RGB): { r: number; g: number; b: number } {
  return {
    r: c.r / 255,
    g: c.g / 255,
    b: c.b / 255
  };
}

function toSolidPaint(c: RGB): SolidPaint {
  return {
    type: 'SOLID',
    color: toFigmaColor(c),
    opacity: c.a
  };
}

// ---------------------------------------------------------------------------
// 布局映射：display:flex -> layoutMode，justify-content / align-items -> Figma
//
// 对应关系（主轴 = flex-direction 方向，交叉轴 = 垂直方向）：
//
//  CSS justify-content       ->  Figma primaryAxisAlignItems（主轴对齐）
//  ─────────────────────────────────────────────────────────────────────
//  flex-start / start        ->  MIN（起点对齐）
//  flex-end / end            ->  MAX（终点对齐）
//  center                    ->  CENTER
//  space-between             ->  SPACE_BETWEEN（两端对齐，中间均分）
//  space-around / space-evenly -> CENTER（Figma 无直接等价，用 CENTER 近似）
//
//  CSS align-items           ->  Figma counterAxisAlignItems（交叉轴对齐）
//  ─────────────────────────────────────────────────────────────────────
//  flex-start / start        ->  MIN
//  flex-end / end            ->  MAX
//  center                    ->  CENTER
//  stretch                   ->  MIN（Figma 仅支持 MIN|MAX|CENTER|BASELINE，无 STRETCH，用 MIN 近似）
//  baseline                  ->  BASELINE
// ---------------------------------------------------------------------------
function normalizeAlignValue(v: string): string {
  const s = (v || '').trim().toLowerCase();
  if (!s) return 'flex-start';
  return s;
}

type PrimaryAxisAlign = 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
function mapJustifyContent(cssValue: string): PrimaryAxisAlign {
  const v = normalizeAlignValue(cssValue);
  const map: Record<string, PrimaryAxisAlign> = {
    'flex-start': 'MIN',
    start: 'MIN',
    left: 'MIN',
    'flex-end': 'MAX',
    end: 'MAX',
    right: 'MAX',
    center: 'CENTER',
    'space-between': 'SPACE_BETWEEN',
    'space-around': 'CENTER',
    'space-evenly': 'CENTER',
    'normal': 'MIN'
  };
  return map[v] ?? 'MIN';
}

type CounterAxisAlign = 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
function mapAlignItems(cssValue: string): CounterAxisAlign {
  const v = normalizeAlignValue(cssValue);
  const map: Record<string, CounterAxisAlign> = {
    'flex-start': 'MIN',
    start: 'MIN',
    'self-start': 'MIN',
    'flex-end': 'MAX',
    end: 'MAX',
    'self-end': 'MAX',
    center: 'CENTER',
    stretch: 'MIN',
    baseline: 'BASELINE',
    'normal': 'MIN'
  };
  return map[v] ?? 'MIN';
}

/** 将 flex-direction 转为 Figma layoutMode（row -> 主轴水平，column -> 主轴垂直） */
function mapFlexDirectionToLayoutMode(cssFlexDirection: string): 'HORIZONTAL' | 'VERTICAL' {
  const v = (cssFlexDirection || 'row').trim().toLowerCase();
  if (v === 'column' || v === 'column-reverse') return 'VERTICAL';
  return 'HORIZONTAL';
}

// ---------------------------------------------------------------------------
// 容器型 tag（创建 Frame）
// ---------------------------------------------------------------------------
const CONTAINER_TAGS = new Set([
  'div', 'section', 'header', 'footer', 'main', 'article', 'aside', 'nav',
  'figure', 'figcaption', 'form', 'fieldset', 'ul', 'ol', 'li', 'dl', 'dt', 'dd'
]);

function isContainerTag(tagName: string): boolean {
  return CONTAINER_TAGS.has(tagName.toLowerCase());
}

// 可作为子节点容器的类型（Page / Frame / Group / Component / Instance）
type ContainerNode = PageNode | FrameNode | GroupNode | ComponentNode | InstanceNode;

function getTargetParent(): ContainerNode {
  const sel = figma.currentPage.selection;
  if (sel.length === 1) {
    const node = sel[0];
    const type = node.type;
    if (type === 'FRAME' || type === 'GROUP' || type === 'COMPONENT' || type === 'INSTANCE') {
      return node as ContainerNode;
    }
  }
  return figma.currentPage;
}

// ---------------------------------------------------------------------------
// 递归绘制：根据 Node Tree 创建 Frame / Text
// ---------------------------------------------------------------------------
async function renderNode(
  node: SerializedNode,
  parent: ContainerNode
): Promise<SceneNode | null> {
  if (node.type === 'root') {
    const children = node.children ?? [];
    const nodes: SceneNode[] = [];
    for (const child of children) {
      const n = await renderNode(child, parent);
      if (n) nodes.push(n);
    }
    return nodes.length > 0 ? nodes[0] : null;
  }

  if (node.type === 'text') {
    await ensureFontLoaded();
    const textNode = figma.createText();
    textNode.fontName = defaultFont;
    const styles = node.styles ?? {};
    textNode.fontSize = typeof styles.fontSize === 'number' ? styles.fontSize : 14;
    textNode.characters = node.textContent ?? '';
    if (styles.color) {
      textNode.fills = [toSolidPaint(styles.color)];
    }
    parent.appendChild(textNode);
    return textNode;
  }

  const tagName = (node.tagName ?? 'div').toLowerCase();
  const styles = node.styles ?? {};
  const children = node.children ?? [];

  // 容器：创建 Frame，应用布局与样式，再递归子节点
  if (node.type === 'element' && isContainerTag(tagName)) {
    const frame = figma.createFrame();
    frame.name = tagName;

    const display = styles.display ?? 'block';
    const isFlex = display === 'flex' || display === 'flexbox';

    if (isFlex) {
      frame.layoutMode = mapFlexDirectionToLayoutMode(styles.flexDirection ?? 'row');
      frame.primaryAxisAlignItems = mapJustifyContent(styles.justifyContent ?? 'flex-start');
      frame.counterAxisAlignItems = mapAlignItems(styles.alignItems ?? 'stretch');
      const gap = styles.gap;
      if (typeof gap === 'number' && gap >= 0) {
        frame.itemSpacing = gap;
      }
    } else {
      const textAlign = (styles.textAlign ?? '').trim().toLowerCase();
      if (textAlign === 'right' || textAlign === 'end') {
        frame.layoutMode = 'HORIZONTAL';
        frame.primaryAxisAlignItems = 'MAX';
        frame.counterAxisAlignItems = mapAlignItems(styles.alignItems ?? 'stretch');
      } else if (textAlign === 'center') {
        frame.layoutMode = 'HORIZONTAL';
        frame.primaryAxisAlignItems = 'CENTER';
        frame.counterAxisAlignItems = mapAlignItems(styles.alignItems ?? 'stretch');
      } else {
        frame.layoutMode = 'VERTICAL';
        frame.primaryAxisAlignItems = 'MIN';
        frame.counterAxisAlignItems = 'MIN';
      }
    }

    const w = styles.width;
    const h = styles.height;
    if (typeof w === 'number' && w > 0 && typeof h === 'number' && h > 0) {
      frame.resize(w, h);
    } else if (typeof w === 'number' && w > 0) {
      frame.resize(w, 100);
    } else if (typeof h === 'number' && h > 0) {
      frame.resize(1, h);
    }

    const pt = styles.paddingTop ?? 0;
    const pr = styles.paddingRight ?? 0;
    const pb = styles.paddingBottom ?? 0;
    const pl = styles.paddingLeft ?? 0;
    if (typeof pt === 'number') frame.paddingTop = pt;
    if (typeof pr === 'number') frame.paddingRight = pr;
    if (typeof pb === 'number') frame.paddingBottom = pb;
    if (typeof pl === 'number') frame.paddingLeft = pl;

    const radius = styles.borderRadius;
    if (typeof radius === 'number' && radius >= 0) {
      frame.cornerRadius = radius;
    }

    if (styles.backgroundColor) {
      frame.fills = [toSolidPaint(styles.backgroundColor)];
    }

    parent.appendChild(frame);

    // 先添加文本子节点（若有），再添加子元素，以保持顺序
    if (node.textContent && node.textContent.trim()) {
      await ensureFontLoaded();
      const textNode = figma.createText();
      textNode.fontName = defaultFont;
      textNode.fontSize = typeof styles.fontSize === 'number' ? styles.fontSize : 14;
      textNode.characters = node.textContent.trim();
      if (styles.color) {
        textNode.fills = [toSolidPaint(styles.color)];
      }
      frame.appendChild(textNode);
    }

    for (const child of children) {
      const mt = child.styles?.marginTop ?? 0;
      const mb = child.styles?.marginBottom ?? 0;
      const needMarginWrap = (typeof mt === 'number' && mt > 0) || (typeof mb === 'number' && mb > 0);
      let targetParent: ContainerNode = frame;
      if (needMarginWrap) {
        const wrap = figma.createFrame();
        wrap.name = 'margin-wrap';
        wrap.layoutMode = 'VERTICAL';
        wrap.fills = [];
        if (typeof mt === 'number' && mt > 0) wrap.paddingTop = mt;
        if (typeof mb === 'number' && mb > 0) wrap.paddingBottom = mb;
        frame.appendChild(wrap);
        targetParent = wrap as ContainerNode;
      }
      const created = await renderNode(child, targetParent);
      if (created && 'layoutGrow' in created && child.styles && (child.styles.flexGrow ?? 0) > 0) {
        (created as { layoutGrow: number }).layoutGrow = 1;
      }
    }
    if (frame.layoutMode === 'VERTICAL') {
      for (const c of frame.children) {
        if ('layoutAlign' in c) (c as { layoutAlign: string }).layoutAlign = 'STRETCH';
      }
    }
    if (frame.layoutMode !== 'NONE') {
      let hasFlexChild = false;
      for (const c of frame.children) {
        if ('layoutGrow' in c && (c as { layoutGrow: number }).layoutGrow === 1) {
          frame.primaryAxisSizingMode = 'FIXED';
          hasFlexChild = true;
          break;
        }
      }
      if (hasFlexChild) {
        const isHorizontal = frame.layoutMode === 'HORIZONTAL';
        const primarySize = isHorizontal ? styles.width : styles.height;
        if (primarySize == null || primarySize <= 0) {
          if (isHorizontal) frame.resize(375, frame.height);
          else frame.resize(frame.width, 200);
        }
      }
    }

    return frame;
  }

  // 文本型元素（p, span, h1 等）：创建 Frame + Text 或仅 Text
  if (node.type === 'element') {
    await ensureFontLoaded();
    const textNode = figma.createText();
    textNode.fontName = defaultFont;
    textNode.fontSize = typeof styles.fontSize === 'number' ? styles.fontSize : 14;
    textNode.characters = node.textContent ?? '';
    if (styles.color) {
      textNode.fills = [toSolidPaint(styles.color)];
    }

    const hasLayout = (styles.display === 'flex' || styles.display === 'flexbox') && children.length > 0;
    if (hasLayout || children.length > 0) {
      const frame = figma.createFrame();
      frame.name = tagName;
      frame.layoutMode = mapFlexDirectionToLayoutMode(styles.flexDirection ?? 'row');
      frame.primaryAxisAlignItems = mapJustifyContent(styles.justifyContent ?? 'flex-start');
      frame.counterAxisAlignItems = mapAlignItems(styles.alignItems ?? 'stretch');
      const gap = styles.gap;
      if (typeof gap === 'number' && gap >= 0) frame.itemSpacing = gap;
      const pt = styles.paddingTop ?? 0;
      const pr = styles.paddingRight ?? 0;
      const pb = styles.paddingBottom ?? 0;
      const pl = styles.paddingLeft ?? 0;
      if (typeof pt === 'number') frame.paddingTop = pt;
      if (typeof pr === 'number') frame.paddingRight = pr;
      if (typeof pb === 'number') frame.paddingBottom = pb;
      if (typeof pl === 'number') frame.paddingLeft = pl;
      if (typeof styles.borderRadius === 'number') frame.cornerRadius = styles.borderRadius;
      if (styles.backgroundColor) frame.fills = [toSolidPaint(styles.backgroundColor)];
      parent.appendChild(frame);
      if (node.textContent && node.textContent.trim()) {
        frame.appendChild(textNode);
      }
      for (const child of children) {
        const created = await renderNode(child, frame);
        if (created && 'layoutGrow' in created && child.styles && (child.styles.flexGrow ?? 0) > 0) {
          (created as { layoutGrow: number }).layoutGrow = 1;
        }
      }
      if (frame.layoutMode !== 'NONE') {
        let hasFlexChild = false;
        for (const c of frame.children) {
          if ('layoutGrow' in c && (c as { layoutGrow: number }).layoutGrow === 1) {
            frame.primaryAxisSizingMode = 'FIXED';
            hasFlexChild = true;
            break;
          }
        }
        if (hasFlexChild) {
          const isHorizontal = frame.layoutMode === 'HORIZONTAL';
          const primarySize = isHorizontal ? styles.width : styles.height;
          if (primarySize == null || primarySize <= 0) {
            if (isHorizontal) frame.resize(375, frame.height);
            else frame.resize(frame.width, 200);
          }
        }
      }
      return frame;
    }

    parent.appendChild(textNode);
    return textNode;
  }

  return null;
}

// ---------------------------------------------------------------------------
// 入口：显示 UI，监听消息
// ---------------------------------------------------------------------------
figma.showUI(__html__, { width: 400, height: 500 });

figma.ui.onmessage = async (msg: { type?: string; payload?: SerializedNode }) => {
  if (msg.type !== 'render-html-tree' || !msg.payload) {
    return;
  }

  try {
    const root = msg.payload;
    const topFrames: SceneNode[] = [];
    const targetParent = getTargetParent();

    if (root.type === 'root' && root.children) {
      for (const child of root.children) {
        const node = await renderNode(child, targetParent);
        if (node) topFrames.push(node);
      }
    } else {
      const node = await renderNode(root, targetParent);
      if (node) topFrames.push(node);
    }

    if (topFrames.length > 0) {
      figma.viewport.scrollAndZoomIntoView(topFrames);
    }

    figma.ui.postMessage({ type: 'done' });
  } catch (e) {
    figma.ui.postMessage({
      type: 'error',
      message: e instanceof Error ? e.message : String(e)
    });
  }
};
