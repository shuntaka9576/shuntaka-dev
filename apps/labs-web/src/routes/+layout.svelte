<script lang="ts">
  import '../app.css';
  import { base } from '$app/paths';

  let { children } = $props();
</script>

<div class="min-h-screen bg-[#edf2f7]">
  <header class="border-b border-[#dde3ea] bg-white">
    <div class="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
      <a href="{base}/" class="text-lg font-semibold tracking-tight text-[#33383e]">
        shuntaka.dev <span class="text-[#5c6eb1]">labs</span>
      </a>
      <span
        class="ml-auto rounded-full border border-[#dde3ea] px-2 py-0.5 text-xs text-[#8b9299]"
      >
        preview
      </span>
    </div>
  </header>
  {@render children()}
</div>
