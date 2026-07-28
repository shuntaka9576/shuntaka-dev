<script lang="ts">
  import { base } from '$app/paths';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{data.lab.title} | labs</title>
</svelte:head>

<main class="mx-auto max-w-3xl px-4 py-10">
  <nav class="mb-6 text-sm text-[#8b9299]">
    <a href="{base}/" class="hover:text-[#5c6eb1]">Labs</a>
    <span class="mx-1">/</span>
    <span>{data.lab.title}</span>
  </nav>

  <div class="rounded-xl border border-[#dde3ea] bg-white p-8">
    <div class="mb-2 flex items-center gap-2">
      <h1 class="text-2xl font-semibold text-[#33383e]">{data.lab.title}</h1>
      {#if !data.lab.published}
        <span class="rounded-full bg-[#fff2b8] px-2 py-0.5 text-xs font-medium text-[#8a6d00]">
          下書き
        </span>
      {/if}
    </div>
    {#if data.lab.summary}
      <p class="mb-8 leading-relaxed text-[#6b7280]">{data.lab.summary}</p>
    {/if}

    <h2 class="mb-3 text-sm font-semibold tracking-wide text-[#8b9299] uppercase">Chapters</h2>
    <ol class="divide-y divide-[#eef1f5]">
      {#each data.chapters as chapter (chapter.slug)}
        <li>
          <a
            href="{base}/{data.lab.slug}/{chapter.slug}"
            class="group flex items-center gap-4 py-3"
          >
            <span
              class="w-8 shrink-0 text-right font-mono text-sm tabular-nums text-[#b3bac1] group-hover:text-[#5c6eb1]"
            >
              {String(chapter.position + 1).padStart(2, '0')}
            </span>
            <span class="text-[#33383e] group-hover:text-[#5c6eb1]">{chapter.title}</span>
          </a>
        </li>
      {/each}
    </ol>
  </div>
</main>
