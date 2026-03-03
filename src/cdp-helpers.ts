import type { Page } from '@playwright/test';

/**
 * CDP-based helpers for tricky GWT widget interactions.
 * Uses Chrome DevTools Protocol directly to bypass Playwright's
 * strict actionability checks (overlay detection, etc.).
 */

interface AccessibilityNode {
  nodeId: string;
  role: { value: string };
  name: { value: string };
  children?: AccessibilityNode[];
  properties?: Array<{ name: string; value: { value: unknown } }>;
}

/** Get the full accessibility tree via CDP */
export async function getAccessibilityTree(page: Page): Promise<AccessibilityNode> {
  var cdp = await page.context().newCDPSession(page);
  try {
    var { nodes } = await cdp.send('Accessibility.getFullAXTree');
    return buildTree(nodes);
  } finally {
    await cdp.detach();
  }
}

function buildTree(nodes: any[]): AccessibilityNode {
  var nodeMap = new Map<string, AccessibilityNode>();
  for (var n of nodes) {
    nodeMap.set(n.nodeId, {
      nodeId: n.nodeId,
      role: n.role || { value: '' },
      name: n.name || { value: '' },
      properties: n.properties,
      children: [],
    });
  }
  for (var n of nodes) {
    if (n.childIds) {
      var parent = nodeMap.get(n.nodeId);
      if (parent) {
        parent.children = n.childIds
          .map((id: string) => nodeMap.get(id))
          .filter(Boolean);
      }
    }
  }
  return nodeMap.get(nodes[0]?.nodeId) || { nodeId: '0', role: { value: 'root' }, name: { value: '' } };
}

/** Find a node in the tree by role and name pattern */
export function findNode(
  tree: AccessibilityNode,
  role: string,
  namePattern: RegExp | string,
): AccessibilityNode | null {
  var pattern = typeof namePattern === 'string' ? new RegExp(namePattern, 'i') : namePattern;
  if (tree.role.value === role && pattern.test(tree.name.value)) return tree;
  for (var child of tree.children || []) {
    var found = findNode(child, role, pattern);
    if (found) return found;
  }
  return null;
}

/** Find all nodes matching role and name pattern */
export function findAllNodes(
  tree: AccessibilityNode,
  role: string,
  namePattern: RegExp | string,
): AccessibilityNode[] {
  var results: AccessibilityNode[] = [];
  var pattern = typeof namePattern === 'string' ? new RegExp(namePattern, 'i') : namePattern;
  if (tree.role.value === role && pattern.test(tree.name.value)) results.push(tree);
  for (var child of tree.children || []) {
    results.push(...findAllNodes(child, role, namePattern));
  }
  return results;
}

/** Click a node by its accessibility nodeId using CDP — bypasses overlay checks */
export async function cdpClickNode(page: Page, backendNodeId: number) {
  var cdp = await page.context().newCDPSession(page);
  try {
    // Resolve node to get its DOM nodeId
    var { model } = await cdp.send('DOM.getBoxModel', { backendNodeId });
    // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
    var quad = model.content;
    var x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    var y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;

    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  } finally {
    await cdp.detach();
  }
}

/** Focus a DOM element by backendNodeId via CDP */
export async function cdpFocusNode(page: Page, backendNodeId: number) {
  var cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.focus', { backendNodeId });
  } finally {
    await cdp.detach();
  }
}

/** Get the backendNodeId for a DOM node from its accessibility nodeId */
export async function getBackendNodeId(page: Page, axNodeId: string): Promise<number> {
  var cdp = await page.context().newCDPSession(page);
  try {
    var { nodes } = await cdp.send('Accessibility.getFullAXTree');
    var node = nodes.find((n: any) => n.nodeId === axNodeId);
    return node?.backendDOMNodeId;
  } finally {
    await cdp.detach();
  }
}

/**
 * Smart element interaction: finds an element by role/name in the accessibility tree
 * and clicks it via CDP (no overlay interference).
 */
export async function smartClick(page: Page, role: string, namePattern: RegExp | string) {
  var cdp = await page.context().newCDPSession(page);
  try {
    var { nodes } = await cdp.send('Accessibility.getFullAXTree');
    var pattern = typeof namePattern === 'string' ? new RegExp(namePattern, 'i') : namePattern;
    var target = nodes.find((n: any) =>
      n.role?.value === role && pattern.test(n.name?.value || ''),
    );
    if (!target) throw new Error(`smartClick: no ${role} matching "${namePattern}"`);
    if (!target.backendDOMNodeId) throw new Error(`smartClick: no backendDOMNodeId for ${target.name.value}`);

    var { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: target.backendDOMNodeId });
    var quad = model.content;
    var x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    var y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;

    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  } finally {
    await cdp.detach();
  }
}

/**
 * Smart focus: finds an element by role/name and focuses it via CDP.
 */
export async function smartFocus(page: Page, role: string, namePattern: RegExp | string) {
  var cdp = await page.context().newCDPSession(page);
  try {
    var { nodes } = await cdp.send('Accessibility.getFullAXTree');
    var pattern = typeof namePattern === 'string' ? new RegExp(namePattern, 'i') : namePattern;
    var target = nodes.find((n: any) =>
      n.role?.value === role && pattern.test(n.name?.value || ''),
    );
    if (!target) throw new Error(`smartFocus: no ${role} matching "${namePattern}"`);
    if (!target.backendDOMNodeId) throw new Error(`smartFocus: no backendDOMNodeId for ${target.name.value}`);

    await cdp.send('DOM.focus', { backendNodeId: target.backendDOMNodeId });
  } finally {
    await cdp.detach();
  }
}
