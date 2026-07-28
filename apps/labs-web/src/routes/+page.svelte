<script lang="ts">
  import { base } from '$app/paths';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' });
</script>

<svelte:head>
  <title>labs | shuntaka.dev</title>
</svelte:head>

<main class="mx-auto max-w-6xl px-4 py-10">
  <h1 class="mb-1 text-2xl font-semibold text-[#33383e]">Labs</h1>
  <p class="mb-8 text-sm text-[#8b9299]">ハンズオン教材（lab-contents リポジトリから同期）</p>

  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {#each data.labs as lab (lab.slug)}
      <a
        href="{base}/{lab.slug}"
        class="group flex flex-col rounded-xl border border-[#dde3ea] bg-white p-5 transition-shadow hover:shadow-md"
      >
        <div class="mb-2 flex items-center gap-2">
          <h2 class="text-base font-semibold text-[#33383e] group-hover:text-[#5c6eb1]">
            {lab.title}
          </h2>
          {#if !lab.published}
            <span
              class="rounded-full bg-[#fff2b8] px-2 py-0.5 text-[10px] font-medium text-[#8a6d00]"
            >
              下書き
            </span>
          {/if}
        </div>
        {#if lab.summary}
          <p class="mb-4 line-clamp-3 text-sm leading-relaxed text-[#6b7280]">{lab.summary}</p>
        {/if}
        <div class="mt-auto flex items-center gap-3 text-xs text-[#8b9299]">
          <span>全 {lab.chapterCount} 章</span>
          <span>{formatDate(lab.updatedAt)} 更新</span>
        </div>
      </a>
    {/each}
  </div>
</main>
