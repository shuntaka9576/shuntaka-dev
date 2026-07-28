<script lang="ts">
  import { base } from '$app/paths';
  import { hydrateWidgets } from '$lib/widgets/hydrate';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const prev = $derived(
    data.chapters.find((c) => c.position === data.chapter.position - 1) ?? null,
  );
  const next = $derived(
    data.chapters.find((c) => c.position === data.chapter.position + 1) ?? null,
  );

  let contentEl = $state<HTMLElement | null>(null);

  // {@html} の描画後にウィジェットプレースホルダへ Svelte コンポーネントを差し込む。
  // contentHtml が変わる（章遷移）たびに再実行され、cleanup で前回分を unmount する
  $effect(() => {
    void data.chapter.contentHtml;
    if (!contentEl) return;
    return hydrateWidgets(contentEl);
  });
</script>

<svelte:head>
  <title>{data.chapter.title} | {data.lab.title}</title>
</svelte:head>

<main class="mx-auto flex max-w-6xl gap-8 px-4 py-8">
  <aside class="hidden w-64 shrink-0 lg:block">
    <div class="sticky top-8 rounded-xl border border-[#dde3ea] bg-white p-5">
      <a
        href="{base}/{data.lab.slug}"
        class="mb-3 block text-sm font-semibold text-[#33383e] hover:text-[#5c6eb1]"
      >
        {data.lab.title}
      </a>
      <ol class="space-y-1">
        {#each data.chapters as chapter (chapter.slug)}
          <li>
            <a
              href="{base}/{data.lab.slug}/{chapter.slug}"
              aria-current={chapter.slug === data.chapter.slug ? 'page' : undefined}
              class="flex gap-2 rounded-md px-2 py-1.5 text-sm leading-snug {chapter.slug ===
              data.chapter.slug
                ? 'bg-[#eef1fb] font-medium text-[#5c6eb1]'
                : 'text-[#6b7280] hover:bg-[#f4f6f9] hover:text-[#33383e]'}"
            >
              <span class="font-mono text-xs leading-5 tabular-nums text-[#b3bac1]">
                {String(chapter.position + 1).padStart(2, '0')}
              </span>
              <span>{chapter.title}</span>
            </a>
          </li>
        {/each}
      </ol>
    </div>
  </aside>

  <article class="min-w-0 flex-1">
    <nav class="mb-4 text-sm text-[#8b9299] lg:hidden">
      <a href="{base}/{data.lab.slug}" class="hover:text-[#5c6eb1]">← {data.lab.title}</a>
    </nav>

    <div class="rounded-xl border border-[#dde3ea] bg-white px-6 py-8 sm:px-10">
      <p class="mb-2 font-mono text-xs tabular-nums text-[#b3bac1]">
        Chapter {String(data.chapter.position + 1).padStart(2, '0')}
      </p>
      <h1 class="mb-8 text-2xl leading-snug font-semibold text-[#33383e]">
        {data.chapter.title}
      </h1>

      <div class="prose" bind:this={contentEl}>
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- 同期時に生成済みの信頼できる HTML -->
        {@html data.chapter.contentHtml}
      </div>
    </div>

    <nav class="mt-6 flex gap-4">
      {#if prev}
        <a
          href="{base}/{data.lab.slug}/{prev.slug}"
          class="flex-1 rounded-xl border border-[#dde3ea] bg-white p-4 hover:shadow-md"
        >
          <span class="block text-xs text-[#8b9299]">← 前の章</span>
          <span class="text-sm font-medium text-[#33383e]">{prev.title}</span>
        </a>
      {:else}
        <span class="flex-1"></span>
      {/if}
      {#if next}
        <a
          href="{base}/{data.lab.slug}/{next.slug}"
          class="flex-1 rounded-xl border border-[#dde3ea] bg-white p-4 text-right hover:shadow-md"
        >
          <span class="block text-xs text-[#8b9299]">次の章 →</span>
          <span class="text-sm font-medium text-[#33383e]">{next.title}</span>
        </a>
      {:else}
        <span class="flex-1"></span>
      {/if}
    </nav>
  </article>
</main>
