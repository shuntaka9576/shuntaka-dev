// content_html 中のウィジェットプレースホルダ
// (<div class="lab-widget" data-widget="..." data-payload="<base64 YAML>">) を
// Svelte コンポーネントに差し替える。ブログの X 埋め込み hydration と同じパターン
import { mount, unmount } from 'svelte';
import type { Component } from 'svelte';
import { parse as parseYaml } from 'yaml';
import EngineSteps from './EngineSteps.svelte';

// 新しいウィジェットはここに追加する。
// ペイロードは実行時にしか分からない YAML なので props の静的型検査は放棄する
const REGISTRY: Record<string, Component<Record<string, unknown>>> = {
  'engine-steps': EngineSteps as unknown as Component<Record<string, unknown>>,
};

function decodePayload(base64: string): Record<string, unknown> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return parseYaml(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

export function hydrateWidgets(root: HTMLElement): () => void {
  const mounted: object[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('.lab-widget[data-widget]')) {
    const name = el.dataset.widget ?? '';
    const component = REGISTRY[name];
    if (!component) {
      console.warn(`未対応のウィジェット: ${name}`);
      continue;
    }
    try {
      const props = decodePayload(el.dataset.payload ?? '');
      el.replaceChildren();
      mounted.push(mount(component, { target: el, props }));
    } catch (e) {
      console.error(`ウィジェット ${name} の描画に失敗`, e);
    }
  }
  return () => {
    for (const instance of mounted) {
      void unmount(instance);
    }
  };
}
